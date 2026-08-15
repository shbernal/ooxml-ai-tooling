#!/usr/bin/env node
/**
 * Deterministic text serialisation of a built database.
 *
 * Usage: node build/dump.mjs [db-path] [> out.tsv]
 *
 * **This format is a contract.** It is what CI hashes to decide whether a
 * rebuild reproduced the committed database, so changing it invalidates every
 * stored hash. Change it deliberately, and when you do, expect to regenerate
 * the expected hash in the same commit.
 *
 * Why a dump and not the raw bytes: the thing that actually moves SQLite's
 * on-disk layout between environments is the **bundled library version**, which
 * advances inside the Node 24 line. Gating on bytes would mean pinning Node
 * exactly in CI and taking a database rebuild plus a release on both surfaces
 * every time that pin moved, for no functional change — and the failure would
 * read `sha256 differs`, with no way to tell an ingest regression from
 * environment drift. Gating on content costs neither, and a failure is a
 * readable `diff` of two dumps. (Platform is a non-issue: SQLite's file format
 * is big-endian regardless of host, so this is version drift, not a Windows
 * problem.)
 */
import {DatabaseSync} from 'node:sqlite';

/**
 * NULL and the empty string must not collide — plenty of these columns are
 * nullable text — so NULL is `\N` and a backslash in a value is doubled. Tabs
 * and newlines are escaped because the format is line- and tab-delimited;
 * `pattern` facets contain both often enough to matter.
 */
function encode(value) {
  if (value === null) return '\\N';
  if (typeof value !== 'string') return String(value);
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
}

export function dumpDatabase(dbPath) {
  const db = new DatabaseSync(dbPath, {readOnly: true});
  const out = [];

  // 1. The pinned pragmas. Cheap to include and easy to forget: without them a
  //    user_version bump with unchanged rows would pass the gate silently.
  out.push('# pragmas');
  for (const pragma of ['application_id', 'user_version', 'page_size', 'encoding']) {
    const row = db.prepare(`PRAGMA ${pragma}`).get();
    if (row === undefined) throw new Error(`PRAGMA ${pragma} returned nothing`);
    out.push(`${pragma}\t${encode(Object.values(row)[0])}`);
  }

  // 2. The DDL. Without this a schema-only change — a dropped index, a widened
  //    column, a lost CHECK — passes silently while every row still matches.
  //    This is the single easiest thing to leave out of a dump and the most
  //    expensive to have left out.
  out.push('# schema');
  const ddl = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE sql IS NOT NULL ORDER BY type, name`,
    )
    .all();
  for (const row of ddl) {
    out.push(`${row.type}\t${row.name}\t${encode(row.sql)}`);
  }

  // 3. Every table, in name order, with an explicit column list. Never
  //    `SELECT *` (column-order dependent) and never an implicit row order
  //    (rowid- and storage-dependent).
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((row) => row.name);

  for (const table of tables) {
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => String(c.name));
    const list = columns.map((c) => `"${c}"`).join(', ');
    out.push(`# table ${table}`);
    out.push(columns.join('\t'));
    const rows = db.prepare(`SELECT ${list} FROM "${table}" ORDER BY ${list}`).all();
    for (const row of rows) {
      out.push(columns.map((c) => encode(row[String(c)])).join('\t'));
    }
    out.push(`# rows ${rows.length}`);
  }

  db.close();
  // '\n' explicitly, never the platform line ending — this is the one place a
  // Windows CRLF could re-enter and silently change every hash.
  return `${out.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // `make dump | head` closes the pipe early. That is normal use of a tool that
  // writes 40k lines to stdout, not an error worth a stack trace.
  process.stdout.on('error', (/** @type {NodeJS.ErrnoException} */ error) => {
    if (error.code !== 'EPIPE') throw error;
  });
  process.stdout.write(dumpDatabase(process.argv[2] ?? 'core/data/ooxml.db'));
}
