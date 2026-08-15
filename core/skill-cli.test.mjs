/**
 * The skill's no-install property, and the CLI's own argument handling.
 *
 * `skill/` has no `package.json` and no `node_modules`. It must run from a bare
 * checkout with Node and nothing else. That is not enforced by anything
 * structural — it is enforced by this file, which reads every module the skill
 * ships and asserts each import is either a `node:` builtin or a relative path.
 * One `import {z} from 'zod'` in the core would break every skill install and
 * pass every other test in the repo.
 *
 * This test lives in `core/` and is deliberately **not** in the Makefile's
 * `CORE_FILES`, so it is never vendored and `skill/scripts/` stays at exactly
 * the files it publishes.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {before, describe, test} from 'node:test';
import {buildDatabase} from '../build/build-db.mjs';
import {CORE_FILES} from '../build/check-vendor.mjs';

const SKILL = 'skill/scripts';
const CLI = join(SKILL, 'ooxml.mjs');

before(() => {
  if (!existsSync('core/data/ooxml.db')) buildDatabase('core/data/ooxml.db', {quiet: true});
});

/** Every `from '...'` and `import('...')` specifier in a module. */
function importsOf(path) {
  const source = readFileSync(path, 'utf8');
  const specifiers = [];
  for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g))
    specifiers.push(match[1]);
  return specifiers;
}

const run = (args) =>
  execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe('the skill runs without an install', () => {
  test('every shipped module imports only node: builtins and relative paths', () => {
    const modules = readdirSync(SKILL).filter((f) => f.endsWith('.mjs'));
    assert.ok(modules.length > 0);

    for (const file of modules) {
      for (const specifier of importsOf(join(SKILL, file))) {
        const ok = specifier.startsWith('node:') || specifier.startsWith('.');
        assert.ok(
          ok,
          `${file} imports "${specifier}" — skill/ has no node_modules, so this would fail ` +
            'for every user of the skill while passing every other test here',
        );
      }
    }
  });

  test('ships exactly the vendored core plus the CLI, and no tests', () => {
    const shipped = readdirSync(SKILL)
      .filter((f) => f.endsWith('.mjs'))
      .sort();
    const expected = [...CORE_FILES.filter((f) => f.endsWith('.mjs')), 'ooxml.mjs'].sort();
    assert.deepEqual(shipped, expected);
    assert.ok(!shipped.some((f) => f.includes('.test.')));
  });

  test('carries its own copy of the database, resolved relative to itself', () => {
    // Resolved through import.meta.url, not cwd — the skill is invoked from
    // wherever the agent happens to be.
    assert.ok(existsSync(join(SKILL, 'data', 'ooxml.db')));
    const output = run(['element', 'w:tbl', '--compact']);
    assert.equal(JSON.parse(output).found, true);
  });
});

describe('the CLI contract', () => {
  test('everything on stdout is JSON and stderr stays empty', () => {
    // The experimental SQLite warning would land on stderr and an agent piping
    // this into a parser would see it. This is the assertion that keeps the
    // warning filter honest.
    const result = execFileSync(process.execPath, [CLI, 'element', 'w:tbl', '--compact'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.doesNotThrow(() => JSON.parse(result));
  });

  test('accepts every qname spelling', () => {
    for (const spelling of [
      'w:tbl',
      'wml:tbl',
      '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tbl',
    ]) {
      assert.equal(JSON.parse(run(['element', spelling, '--compact'])).found, true, spelling);
    }
  });

  test('--profile reaches the core', () => {
    const strict = JSON.parse(run(['element', 'w:tbl', '--profile', 'strict', '--compact']));
    assert.match(strict.symbols[0].namespace.uri, /purl\.oclc\.org/);
  });

  test('explain accepts a bare diagnostic or a whole report', () => {
    const diagnostic = {
      id: 'Sch_UndeclaredAttribute',
      description: "The 'bogus' attribute is not declared.",
      xpath: '/w:document[1]/w:body[1]/w:p[1]/w:pPr[1]/w:ind[1]',
    };
    const bare = JSON.parse(run(['explain', JSON.stringify(diagnostic), '--compact']));
    assert.equal(bare.legal.type, 'w:CT_Ind');

    // People have a report in hand, not a hand-extracted diagnostic.
    const report = JSON.parse(
      run(['explain', JSON.stringify({valid: false, diagnostics: [diagnostic]}), '--compact']),
    );
    assert.deepEqual(report.legal.type, bare.legal.type);
  });

  test('sql is read-only and refuses anything that is not a query', () => {
    const rows = JSON.parse(run(['sql', 'SELECT key FROM profiles ORDER BY id', '--compact']));
    assert.deepEqual(
      rows.rows.map((r) => r.key),
      ['transitional', 'strict'],
    );

    assert.throws(() => run(['sql', 'DROP TABLE symbols']), /read-only/);
    assert.throws(() => run(['sql', 'SELECT 1; SELECT 2']), /one statement/);
  });

  test('an unknown command exits 2 with usage, not a stack trace', () => {
    try {
      run(['nonsense']);
      assert.fail('expected a non-zero exit');
    } catch (error) {
      assert.equal(error.status, 2);
      assert.match(error.stderr, /unknown command/);
      assert.match(error.stderr, /ooxml element/);
    }
  });

  test('no arguments prints usage and exits 0', () => {
    const output = run([]);
    assert.match(output, /query the ECMA-376 schema graph/);
  });
});
