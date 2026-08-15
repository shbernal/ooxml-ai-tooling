#!/usr/bin/env node
/**
 * Verify the vendored XSDs against `schemas/SHA256SUMS`.
 *
 * The whole trust chain of this repo rests on the schemas being byte-identical
 * to what Ecma published: `schemas/PROVENANCE.md` records the archive hashes,
 * and this manifest records what came out of them. The two failures it exists to
 * catch are a well-meaning hand-edit and a line-ending rewrite — the second is
 * silent, happens at checkout rather than at edit time, and would otherwise
 * surface as an unexplained ingest diff months later.
 *
 * Written in Node rather than `sha256sum -c` so it runs identically on the
 * Windows machine, where the line-ending failure is the one actually at risk.
 * The format is deliberately `sha256sum`-compatible, so regenerating is
 * `cd schemas && find … | xargs sha256sum > SHA256SUMS`.
 */
import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
const MANIFEST = join(SCHEMAS, 'SHA256SUMS');

/**
 * Parse the `<hex>  <path>` lines of a sha256sum manifest.
 *
 * Split on `\r?\n`, not `\n`. The manifest is an ordinary text file — only
 * `*.xsd` is marked `-text` in .gitattributes, because only the XSDs' bytes are
 * a provenance claim — so a Windows checkout hands us CRLF here quite legally.
 * Splitting on `\n` alone leaves a `\r` that the `$` anchor rejects, failing
 * every line of a manifest that is perfectly intact.
 */
function parseManifest(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error(`SHA256SUMS: unparseable line: ${line}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function findXsd(dir) {
  const found = [];
  for (const entry of await readdir(dir, {withFileTypes: true, recursive: true})) {
    if (entry.isFile() && entry.name.endsWith('.xsd')) {
      found.push(relative(SCHEMAS, join(entry.parentPath, entry.name)));
    }
  }
  return found.sort();
}

const expected = parseManifest(await readFile(MANIFEST, 'utf8'));
const actual = await findXsd(SCHEMAS);
const problems = [];

for (const path of actual) {
  if (!expected.has(path)) {
    problems.push(`UNLISTED ${path} — present on disk, absent from SHA256SUMS`);
    continue;
  }
  const digest = createHash('sha256')
    .update(await readFile(join(SCHEMAS, path)))
    .digest('hex');
  if (digest !== expected.get(path)) {
    problems.push(`MODIFIED ${path}\n  expected ${expected.get(path)}\n  actual   ${digest}`);
  }
  expected.delete(path);
}

for (const path of expected.keys()) {
  problems.push(`MISSING  ${path} — listed in SHA256SUMS, absent from disk`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(
    '\nThe XSDs are vendored verbatim and are never hand-edited. If a correction\n' +
      'is genuinely needed, re-extract from the source archive named in\n' +
      'schemas/PROVENANCE.md and regenerate the manifest.\n' +
      'A CRLF/LF difference here means .gitattributes stopped applying.',
  );
  process.exit(1);
}

console.log(`ok   ${actual.length} XSDs match schemas/SHA256SUMS`);
