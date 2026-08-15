#!/usr/bin/env node
/**
 * Verify that the vendored copies still match `core/`.
 *
 * Both surfaces are thin adapters over one implementation. If a vendored copy
 * drifts they do not fail — they quietly stop behaving the same way, which is
 * the failure this repo is least able to notice by reading any single file.
 *
 * **The two file kinds are compared differently, and that is not an
 * inconsistency.**
 *
 * - The `.mjs` files are compared **byte for byte**. They are copies of a
 *   source file; anything other than equality is drift.
 * - The `.db` is compared by **canonical dump hash**, never by bytes. The
 *   reason is that `core/data/ooxml.db` is *not committed* — it is build output,
 *   and CI rebuilds it from the XSDs on every run. So this check is really
 *   "does a fresh build agree with what was vendored", and a fresh build's byte
 *   layout moves with the bundled SQLite version even when every row is
 *   identical. Comparing bytes would mean pinning Node exactly and taking a
 *   rebuild plus a release on both surfaces every time that pin moved.
 *
 * That makes this check and part 06's determinism gate the same comparison,
 * which is the point: there is one definition of "the database changed".
 */
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildDatabase} from './build-db.mjs';
import {dumpDatabase} from './dump.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Kept in step with the Makefile's CORE_FILES — the Makefile is the source of truth. */
export const CORE_FILES = [
  'db.mjs',
  'warnings.mjs',
  'qname.mjs',
  'graph.mjs',
  'explain.mjs',
  'data/ooxml.db',
];

export const VENDOR_DIRS = ['skill/scripts', 'mcp/src'];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

export function checkVendor({quiet = false} = {}) {
  const log = quiet ? () => {} : (message) => console.log(message);
  const problems = [];

  const corePath = join(ROOT, 'core', 'data', 'ooxml.db');
  if (!existsSync(corePath)) {
    // A cold clone has no database. Building it is the correct response — the
    // alternative is a failure that reads like drift when it is just absence.
    log('core/data/ooxml.db is absent (it is build output); building it');
    buildDatabase(corePath, {quiet: true});
  }

  const coreDump = sha256(dumpDatabase(corePath));

  for (const dir of VENDOR_DIRS) {
    for (const file of CORE_FILES) {
      const source = join(ROOT, 'core', file);
      const vendored = join(ROOT, dir, file);

      if (!existsSync(vendored)) {
        problems.push(`MISSING  ${dir}/${file} (run: make sync-core)`);
        continue;
      }

      if (file.endsWith('.db')) {
        const vendoredDump = sha256(dumpDatabase(vendored));
        if (vendoredDump !== coreDump) {
          problems.push(
            `DRIFT    ${dir}/${file} holds a different graph from core/${file}\n` +
              `         core     ${coreDump}\n` +
              `         vendored ${vendoredDump}\n` +
              '         (run: make db sync-core — then read the diff of `make dump` first)',
          );
        }
        continue;
      }

      if (!readFileSync(source).equals(readFileSync(vendored))) {
        problems.push(`DRIFT    ${dir}/${file} differs from core/${file} (run: make sync-core)`);
      }
    }
  }

  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return false;
  }

  log(`ok   ${CORE_FILES.length} files in each of: ${VENDOR_DIRS.join(' ')}`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) checkVendor();
