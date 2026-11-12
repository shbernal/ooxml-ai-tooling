// The `--test-global-setup` module for `pnpm test` and `make test`.
//
// core/data/ooxml.db is build output and gitignored, so a cold clone has none.
// It is built here, once, before node --test starts the test files in parallel
// processes. When each file built it in its own before(), they raced, and all
// but one failed with `database is locked`.

import {existsSync} from 'node:fs';

import {buildDatabase} from './build-db.mjs';

const DB = 'core/data/ooxml.db';

export function globalSetup() {
  if (!existsSync(DB)) buildDatabase(DB, {quiet: true});
}
