#!/usr/bin/env node
/**
 * Build `core/data/ooxml.db` from `schemas/`.
 *
 * Usage: node build/build-db.mjs [output-path]
 *
 * The output is a *derived artifact* — it is gitignored here and rebuilt by CI
 * on every run. The two copies that are committed live in the surfaces, and
 * part 06's gate rebuilds this one and compares the canonical dump, so the
 * committed copies stay honest.
 */
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {buildResolver, declareSymbols, parseProfiles, writeEdges, writeSymbols} from './ingest.mjs';
import {buildNamespaceIndex, listSchemaFiles} from './parse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Bumped on any change to build/schema.sql. core/ refuses a database it does not know. */
export const USER_VERSION = 1;

/** 'OOX1' as a big-endian int32 — `file`-style magic for a SQLite payload. */
export const APPLICATION_ID = 0x4f4f5831;

export const PROFILES = [
  {key: 'transitional', label: 'ECMA-376 Part 4 — Transitional', dir: 'schemas/ooxml-transitional'},
  {key: 'strict', label: 'ECMA-376 Part 1 — Strict', dir: 'schemas/ooxml-strict'},
];

/**
 * Order-of-magnitude floors, from the raw tag counts measured on the vendored
 * Transitional set. Not expected row counts — a tag count conflates
 * declarations with references — but if the graph comes out an order of
 * magnitude smaller than this, something failed silently, which is the only
 * failure mode that matters here.
 *
 * They are floors for **Transitional alone**, not for a both-profile build, so
 * that the Transitional-only retreat stays runnable. Do not raise them to hug
 * the current numbers; a tripwire that fires on any change is a tripwire nobody
 * leaves armed.
 */
const FLOORS = {
  symbols: 3000,
  child_edges: 2000,
  attr_edges: 3000,
  enums: 3000,
  compositors: 800,
  group_edges: 250,
  inheritance_edges: 500,
  simple_type_facets: 100,
  union_members: 40,
};

export function buildDatabase(outputPath, {profiles = PROFILES, quiet = false} = {}) {
  const log = quiet ? () => {} : (message) => console.log(message);

  rmSync(outputPath, {force: true});
  mkdirSync(dirname(outputPath), {recursive: true});
  const db = new DatabaseSync(outputPath);

  // page_size and encoding only take effect on an empty database, so they have
  // to precede the DDL. Both are pinned because both are otherwise free to vary
  // with the bundled SQLite's defaults, and the file is committed.
  db.exec('PRAGMA page_size = 4096');
  db.exec("PRAGMA encoding = 'UTF-8'");
  // Never WAL: it leaves -wal/-shm sidecars next to a file that ships inside an
  // npm tarball and a bare checkout.
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'build', 'schema.sql'), 'utf8'));
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  db.exec(`PRAGMA user_version = ${USER_VERSION}`);

  const dirs = profiles.map((profile) => join(ROOT, profile.dir));
  const namespaceIndex = buildNamespaceIndex(dirs);
  const withFiles = profiles.map((profile) => ({
    ...profile,
    files: listSchemaFiles(join(ROOT, profile.dir)),
  }));

  log(`parsing ${withFiles.map((p) => `${p.files.length} ${p.key}`).join(', ')} schemas`);
  const parsed = parseProfiles(withFiles, namespaceIndex);

  const universe = declareSymbols(parsed);
  log(`declared ${universe.ids.size} symbols across ${parsed.length} profile(s)`);

  db.exec('BEGIN');
  const {profileIds} = writeSymbols(db, parsed, universe);
  const resolver = buildResolver(db, universe);
  writeEdges(db, parsed, universe, resolver, profileIds);
  db.exec('COMMIT');

  assertIntegrity(db, withFiles, log);

  // VACUUM rewrites the file compactly, dropping the freelist and whatever
  // fragmentation the insert order produced. Without it the byte layout carries
  // a record of how the file was built, which is exactly the nondeterminism the
  // committed artifact must not have.
  db.exec('VACUUM');
  db.close();

  const size = statSync(outputPath).size;
  log(`wrote ${outputPath} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  return {path: outputPath, size};
}

function assertIntegrity(db, profiles, log) {
  const failures = [];
  const count = (sql) => db.prepare(sql).get().n;

  // Declared foreign keys are not enforced retroactively, so ask SQLite
  // directly. This is the "no orphan edges" assertion, for every edge table at
  // once rather than one query per table.
  const orphans = db.prepare('PRAGMA foreign_key_check').all();
  if (orphans.length > 0) {
    failures.push(`${orphans.length} orphaned rows: ${JSON.stringify(orphans.slice(0, 5))}`);
  }

  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (integrity.integrity_check !== 'ok')
    failures.push(`integrity_check: ${integrity.integrity_check}`);

  // Every reference to an OOXML type resolves. Built-ins (`xsd:string`) are
  // named but have no row, and that is the one legitimate NULL.
  const unresolvedTypes = count(
    `SELECT COUNT(*) AS n FROM symbols
      WHERE type_ref IS NOT NULL AND type_ref NOT LIKE 'xsd:%' AND type_symbol_id IS NULL`,
  );
  if (unresolvedTypes > 0) failures.push(`${unresolvedTypes} symbols with an unresolved type_ref`);

  const unresolvedAttrs = count(
    `SELECT COUNT(*) AS n FROM attr_edges
      WHERE type_ref IS NOT NULL AND type_ref NOT LIKE 'xsd:%' AND type_symbol_id IS NULL`,
  );
  if (unresolvedAttrs > 0)
    failures.push(`${unresolvedAttrs} attributes with an unresolved type_ref`);

  const unresolvedMembers = count(
    `SELECT COUNT(*) AS n FROM union_members
      WHERE member_type_ref NOT LIKE 'xsd:%' AND member_symbol_id IS NULL`,
  );
  if (unresolvedMembers > 0) failures.push(`${unresolvedMembers} union members unresolved`);

  const unresolvedBases = count(
    `SELECT COUNT(*) AS n FROM inheritance_edges
      WHERE base_type_ref NOT LIKE 'xsd:%' AND base_symbol_id IS NULL`,
  );
  if (unresolvedBases > 0) failures.push(`${unresolvedBases} inheritance bases unresolved`);

  // A compositor hangs off a symbol or off another compositor, never both and
  // never neither. The table has a CHECK; this proves the CHECK was actually in
  // force when the rows went in.
  const badCompositors = count(
    `SELECT COUNT(*) AS n FROM compositors
      WHERE (parent_symbol_id IS NULL) = (parent_compositor_id IS NULL)`,
  );
  if (badCompositors > 0) failures.push(`${badCompositors} compositors with a bad parent`);

  const badWildcards = count(
    `SELECT COUNT(*) AS n FROM child_edges WHERE (child_symbol_id IS NULL) <> (is_wildcard = 1)`,
  );
  if (badWildcards > 0) failures.push(`${badWildcards} child edges disagree with is_wildcard`);

  // A local element must have a real owner; 0 is the top-level sentinel.
  const orphanLocals = count(
    `SELECT COUNT(*) AS n FROM symbols s
      WHERE s.parent_symbol_id <> 0
        AND NOT EXISTS (SELECT 1 FROM symbols p WHERE p.id = s.parent_symbol_id)`,
  );
  if (orphanLocals > 0) failures.push(`${orphanLocals} local symbols with a missing parent`);

  for (const [table, floor] of Object.entries(FLOORS)) {
    const n = count(`SELECT COUNT(*) AS n FROM ${table}`);
    if (n < floor) failures.push(`${table} has ${n} rows, expected at least ${floor}`);
  }

  for (const profile of profiles) {
    const n = count(
      `SELECT COUNT(*) AS n FROM symbol_profiles sp
         JOIN profiles p ON p.id = sp.profile_id WHERE p.key = '${profile.key}'`,
    );
    if (n === 0) failures.push(`profile ${profile.key} has no symbols`);
  }

  // Part 02's structural diff said Strict is a subset of Transitional. That was
  // measured on top-level declarations in the raw XSD; this re-checks it on the
  // built graph, which is the artifact anyone actually queries.
  if (profiles.some((p) => p.key === 'strict')) {
    const strictOnly = count(
      `SELECT COUNT(*) AS n FROM symbol_profiles sp
         JOIN profiles p ON p.id = sp.profile_id
        WHERE p.key = 'strict'
          AND NOT EXISTS (
            SELECT 1 FROM symbol_profiles sp2 JOIN profiles p2 ON p2.id = sp2.profile_id
             WHERE sp2.symbol_id = sp.symbol_id AND p2.key = 'transitional')`,
    );
    if (strictOnly > 0) {
      failures.push(
        `${strictOnly} symbols are Strict-only — part 02 measured zero, so either the ` +
          'schemas changed or the ingest mis-scoped something',
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`integrity assertions failed:\n  - ${failures.join('\n  - ')}`);
  }

  const tally = [
    'symbols',
    'compositors',
    'child_edges',
    'group_edges',
    'attr_edges',
    'inheritance_edges',
    'enums',
    'simple_type_facets',
    'union_members',
  ]
    .map((t) => `${t}=${count(`SELECT COUNT(*) AS n FROM ${t}`)}`)
    .join(' ');
  log(`integrity ok  ${tally}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const output = process.argv[2] ?? join(ROOT, 'core', 'data', 'ooxml.db');
  const {path, size} = buildDatabase(output);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  console.log(`sha256 ${digest}  ${size} bytes`);
}
