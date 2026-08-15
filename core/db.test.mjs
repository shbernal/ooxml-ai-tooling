/**
 * The loader's refusals.
 *
 * These matter more than they look. Both surfaces ship a vendored copy of the
 * database beside a vendored copy of the core, and a release that lands one
 * without the other does not crash — it answers confidently from a schema whose
 * columns have moved. Each guard turns that into a startup error naming the fix.
 */
import assert from 'node:assert/strict';
import {copyFileSync, existsSync, mkdirSync, rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {before, describe, test} from 'node:test';
import {buildDatabase} from '../build/build-db.mjs';
import {EXPECTED_APPLICATION_ID, EXPECTED_USER_VERSION, openGraph} from './db.mjs';

const DB = 'core/data/ooxml.db';

before(() => {
  if (!existsSync(DB)) buildDatabase(DB, {quiet: true});
  mkdirSync('.tmp', {recursive: true});
});

describe('openGraph', () => {
  test('opens the real database and reports the pragmas it checked', () => {
    const graph = openGraph(DB);
    assert.equal(graph.get('PRAGMA user_version').user_version, EXPECTED_USER_VERSION);
    assert.equal(graph.get('PRAGMA application_id').application_id, EXPECTED_APPLICATION_ID);
    graph.close();
  });

  test('refuses a database whose schema version does not match the code', () => {
    const drifted = '.tmp/drifted.db';
    copyFileSync(DB, drifted);
    const writable = new DatabaseSync(drifted);
    writable.exec(`PRAGMA user_version = ${EXPECTED_USER_VERSION + 1}`);
    writable.close();

    assert.throws(
      () => openGraph(drifted),
      (error) => {
        assert.match(error.message, /schema version mismatch/);
        // The error has to name the fix, or it reads as an unexplained crash.
        assert.match(error.message, /make sync-core/);
        return true;
      },
    );
  });

  test('refuses a SQLite file that is not ours at all', () => {
    const foreign = '.tmp/foreign.db';
    // .tmp survives between runs, so build the fixture from nothing every time
    // rather than inheriting whatever the last run left.
    rmSync(foreign, {force: true});
    const other = new DatabaseSync(foreign);
    other.exec('CREATE TABLE t (a)');
    other.close();

    assert.throws(() => openGraph(foreign), /not an OOXML schema database/);
  });

  test('a missing database says how to build one', () => {
    assert.throws(() => openGraph('.tmp/does-not-exist.db'), /make db/);
  });
});
