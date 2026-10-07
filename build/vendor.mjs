#!/usr/bin/env node
/**
 * What the surfaces vendor from `core/`, and the copy that vendors it.
 *
 * Usage: node build/vendor.mjs   (or `make sync-core`)
 *
 * This list is the only statement of the shipped core. The copy, the vendoring
 * check and the tests all read it, so a module added here is copied, checked
 * and tested together, and a module left out is none of those.
 *
 * Running it is deliberately not automatic. Vendoring is a decision to record
 * in the commit, not a side effect of one.
 */
import {copyFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The implementation modules and the built database they query. The tests and
 * everything under `build/` are deliberately absent: they are development-only
 * and must never reach a surface.
 */
export const CORE_FILES = [
  'db.mjs',
  'warnings.mjs',
  'qname.mjs',
  'graph.mjs',
  'explain.mjs',
  'data/ooxml.db',
];

export const VENDOR_DIRS = ['skill/scripts', 'mcp/src'];

/** Copy every core file into every surface, byte for byte. */
export function syncCore({root = ROOT, quiet = false} = {}) {
  for (const dir of VENDOR_DIRS) {
    for (const file of CORE_FILES) {
      const target = join(root, dir, file);
      mkdirSync(dirname(target), {recursive: true});
      copyFileSync(join(root, 'core', file), target);
    }
    if (!quiet) console.log(`wrote ${dir} (${CORE_FILES.length} files)`);
  }
}

if (import.meta.main) syncCore();
