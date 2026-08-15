/**
 * The ingest's regression net.
 *
 * Two jobs. First, determinism: the database is a committed artifact, so a
 * rebuild has to reproduce it or the committed binary is an assertion rather
 * than a derived thing. Second, goldens: known-answer queries that pin what the
 * graph currently says, so a change to the ingest shows up as a reviewable diff
 * instead of as silence.
 *
 * These live in core/ because that is what `pnpm test` runs, but they are not
 * vendored — `CORE_FILES` in the Makefile is the shipped set and no test is in
 * it.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {after, before, describe, test} from 'node:test';
import {APPLICATION_ID, buildDatabase, USER_VERSION} from '../build/build-db.mjs';
import {dumpDatabase} from '../build/dump.mjs';

const DB = 'core/data/ooxml.db';
const GOLDEN = 'core/fixtures/graph.json';

let db;

before(() => {
  // A cold clone has no database — it is build output and gitignored — so build
  // it rather than failing with something that reads like a broken checkout.
  if (!existsSync(DB)) buildDatabase(DB, {quiet: true});
  db = new DatabaseSync(DB, {readOnly: true});
});

after(() => db?.close());

const all = (sql, ...params) => db.prepare(sql).all(...params);
const one = (sql, ...params) => db.prepare(sql).get(...params);

describe('the built database', () => {
  test('declares the pragmas core/ checks on load', () => {
    assert.equal(one('PRAGMA application_id').application_id, APPLICATION_ID);
    assert.equal(one('PRAGMA user_version').user_version, USER_VERSION);
    assert.equal(one('PRAGMA page_size').page_size, 4096);
    assert.equal(one('PRAGMA encoding').encoding, 'UTF-8');
  });

  test('carries both profiles', () => {
    const profiles = all('SELECT key FROM profiles ORDER BY id').map((r) => r.key);
    assert.deepEqual(profiles, ['transitional', 'strict']);
  });

  test('has no orphaned rows', () => {
    assert.deepEqual(all('PRAGMA foreign_key_check'), []);
  });
});

describe('determinism', () => {
  // The expensive one: two full builds. It is the only way to prove the claim,
  // and the claim is what makes committing a binary defensible.
  test('two builds produce an identical canonical dump', () => {
    const a = '.tmp/determinism-a.db';
    const b = '.tmp/determinism-b.db';
    buildDatabase(a, {quiet: true});
    buildDatabase(b, {quiet: true});

    const dumpA = dumpDatabase(a);
    const dumpB = dumpDatabase(b);
    assert.equal(
      createHash('sha256').update(dumpA).digest('hex'),
      createHash('sha256').update(dumpB).digest('hex'),
      'canonical dumps differ between two builds of the same input',
    );

    // The raw byte comparison is a canary, never a gate. It moves with the
    // bundled SQLite version, and failing on that would cost a rebuild plus a
    // release on both surfaces for no functional change. Logged so that if it
    // stays green it is free to promote later.
    const bytesA = createHash('sha256').update(readFileSync(a)).digest('hex');
    const bytesB = createHash('sha256').update(readFileSync(b)).digest('hex');
    if (bytesA !== bytesB) {
      console.log(`note: byte-identical rebuild did not hold (${bytesA} vs ${bytesB})`);
    }
  });

  test('the dump distinguishes NULL from the empty string', () => {
    const dump = dumpDatabase(DB);
    assert.match(dump, /\\N/, 'no NULL marker in the dump');
    assert.ok(dump.endsWith('\n'));
    assert.ok(!dump.includes('\r'), 'a CR reached the dump — the hash would be platform-dependent');
  });

  test('the dump includes the DDL, not just the rows', () => {
    // The most likely way to write a dump that passes while a schema change
    // slips through.
    const dump = dumpDatabase(DB);
    assert.match(dump, /CREATE TABLE symbols/);
    assert.match(dump, /CREATE INDEX idx_symbols_name/);
    assert.ok(dump.startsWith(`# pragmas\napplication_id\t${APPLICATION_ID}\n`));
  });
});

/**
 * Known-answer queries. Each returns something small and human-checkable, and
 * together they span wml, sml, pml and dml plus every construct the ingest
 * treats specially: an extended type, a group ref carrying its own cardinality,
 * a union, an enum, a wildcard, and a profile difference.
 *
 * Regenerate deliberately with UPDATE_GOLDENS=1 and read the diff — that diff
 * is the review artifact.
 */
function goldenQueries() {
  // Vocabulary-qualified on purpose. A bare name is *not* unique across the
  // corpus — `ST_Percentage` is a pattern-restricted string in
  // shared-commonSimpleTypes and a union in dml-main — and a golden that
  // silently picked whichever came first would pin the wrong thing while
  // looking fine. Part 04's lookup has to handle the same ambiguity.
  const symbolId = (vocabulary, name, kind) =>
    one(
      `SELECT s.id FROM symbols s JOIN vocabularies v ON v.id = s.vocabulary_id
        WHERE v.key = ? AND s.local_name = ? AND s.kind = ? AND s.parent_symbol_id = 0`,
      vocabulary,
      name,
      kind,
    )?.id;

  const profileId = (key) => one('SELECT id FROM profiles WHERE key = ?', key).id;
  const transitional = profileId('transitional');
  const strict = profileId('strict');

  return {
    // wml — a paragraph's properties, the single most asked-about type.
    'wml CT_PPr children': all(
      `SELECT c.local_name, ce.min_occurs, ce.max_occurs, ce.order_index
         FROM child_edges ce
         JOIN symbols c ON c.id = ce.child_symbol_id
        WHERE ce.parent_symbol_id = ? AND ce.profile_id = ?
        ORDER BY ce.order_index LIMIT 12`,
      symbolId('wml', 'CT_PPrBase', 'complexType'),
      transitional,
    ),

    // An extended type: CT_PPr extends CT_PPrBase, so its own sequence is only
    // half the story and the base particle comes first.
    'wml CT_PPr inheritance': all(
      `SELECT relation, content_model, base_type_ref
         FROM inheritance_edges WHERE symbol_id = ? AND profile_id = ?`,
      symbolId('wml', 'CT_PPr', 'complexType'),
      transitional,
    ),

    // A group ref with its own cardinality — the ref site's occurs, not the
    // definition's.
    'wml group refs with unbounded ref sites': all(
      `SELECT p.local_name AS parent, g.local_name AS grp, ge.min_occurs, ge.max_occurs
         FROM group_edges ge
         JOIN symbols p ON p.id = ge.parent_symbol_id
         JOIN symbols g ON g.id = ge.group_symbol_id
        WHERE ge.ref_kind = 'group' AND ge.max_occurs = -1 AND ge.profile_id = ?
        ORDER BY parent, grp LIMIT 8`,
      transitional,
    ),

    // sml — a union of two anonymous inline member types, the one place in
    // ECMA-376 that happens.
    'sml ST_TextRotation union': all(
      `SELECT m.order_index, m.member_kind, m.member_type_ref,
              i.base_type_ref,
              (SELECT group_concat(f.facet || '=' || f.value, ',')
                 FROM simple_type_facets f
                WHERE f.symbol_id = m.member_symbol_id AND f.profile_id = m.profile_id) AS facets,
              (SELECT group_concat(e.value, ',')
                 FROM enums e
                WHERE e.symbol_id = m.member_symbol_id AND e.profile_id = m.profile_id) AS values_
         FROM union_members m
         LEFT JOIN inheritance_edges i
                ON i.symbol_id = m.member_symbol_id AND i.profile_id = m.profile_id
        WHERE m.symbol_id = ? AND m.profile_id = ?
        ORDER BY m.order_index`,
      symbolId('sml', 'ST_TextRotation', 'simpleType'),
      transitional,
    ),

    // An enum, with the facets that bound a neighbouring numeric type.
    'sml ST_Orientation values': all(
      'SELECT value, order_index FROM enums WHERE symbol_id = ? AND profile_id = ? ORDER BY order_index',
      symbolId('sml', 'ST_Orientation', 'simpleType'),
      transitional,
    ),

    // The same name in two vocabularies, meaning two different things. This is
    // the fixture that documents why a name alone is not an identity.
    'ST_Percentage is two different types': {
      'shared-commonSimpleTypes (facets)': all(
        `SELECT facet, value FROM simple_type_facets
          WHERE symbol_id = ? AND profile_id = ? ORDER BY facet`,
        symbolId('shared-commonSimpleTypes', 'ST_Percentage', 'simpleType'),
        transitional,
      ),
      'dml-main (union)': all(
        `SELECT member_kind, member_type_ref, order_index FROM union_members
          WHERE symbol_id = ? AND profile_id = ? ORDER BY order_index`,
        symbolId('dml-main', 'ST_Percentage', 'simpleType'),
        transitional,
      ),
    },

    // pml — a wildcard extension point.
    wildcards: all(
      `SELECT p.local_name AS parent, ce.wildcard_namespace, ce.wildcard_process_contents,
              ce.min_occurs, ce.max_occurs
         FROM child_edges ce
         JOIN symbols p ON p.id = ce.parent_symbol_id
        WHERE ce.is_wildcard = 1 AND ce.profile_id = ?
        ORDER BY parent, ce.order_index`,
      transitional,
    ),

    // dml — a type whose entire content is a group ref, so `children` is empty
    // and the answer lives one hop away. Exactly the case where a query that
    // only reads child_edges gives a confidently wrong "it accepts nothing".
    'dml CT_SolidColorFillProperties content': {
      direct_children: all(
        `SELECT c.local_name FROM child_edges ce JOIN symbols c ON c.id = ce.child_symbol_id
          WHERE ce.parent_symbol_id = ? AND ce.profile_id = ? ORDER BY ce.order_index`,
        symbolId('dml-main', 'CT_SolidColorFillProperties', 'complexType'),
        transitional,
      ),
      group_refs: all(
        `SELECT g.local_name, ge.min_occurs, ge.max_occurs FROM group_edges ge
           JOIN symbols g ON g.id = ge.group_symbol_id
          WHERE ge.parent_symbol_id = ? AND ge.profile_id = ? ORDER BY ge.order_index`,
        symbolId('dml-main', 'CT_SolidColorFillProperties', 'complexType'),
        transitional,
      ),
    },

    'dml CT_Point2D attributes': all(
      `SELECT local_name, attr_use, is_qualified, type_ref
         FROM attr_edges WHERE symbol_id = ? AND profile_id = ? ORDER BY order_index`,
      symbolId('dml-main', 'CT_Point2D', 'complexType'),
      transitional,
    ),

    // A genuinely nested content model — compositors inside compositors — which
    // is what makes `compositors` a tree rather than a list. wml's CT_Object
    // nests two levels.
    'wml CT_Object compositor tree': all(
      `WITH RECURSIVE tree(id, kind, depth, min_occurs, max_occurs, order_index) AS (
          SELECT id, kind, 0, min_occurs, max_occurs, order_index
            FROM compositors WHERE parent_symbol_id = ? AND profile_id = ?
          UNION ALL
          SELECT c.id, c.kind, tree.depth + 1, c.min_occurs, c.max_occurs, c.order_index
            FROM compositors c JOIN tree ON c.parent_compositor_id = tree.id
        )
        SELECT kind, depth, min_occurs, max_occurs, order_index FROM tree
         ORDER BY depth, order_index, kind`,
      symbolId('wml', 'CT_Object', 'complexType'),
      transitional,
    ),

    // The profile difference the model predicts: same symbol, same type_ref,
    // different edges.
    'ST_OnOff differs by profile': {
      transitional: all(
        'SELECT member_type_ref, order_index FROM union_members WHERE symbol_id = ? AND profile_id = ? ORDER BY order_index',
        symbolId('shared-commonSimpleTypes', 'ST_OnOff', 'simpleType'),
        transitional,
      ),
      strict: all(
        'SELECT member_type_ref, order_index FROM union_members WHERE symbol_id = ? AND profile_id = ? ORDER BY order_index',
        symbolId('shared-commonSimpleTypes', 'ST_OnOff', 'simpleType'),
        strict,
      ),
    },

    // VML exists in Transitional and not in Strict at all.
    'vml is transitional-only': one(
      `SELECT
         (SELECT COUNT(*) FROM symbol_profiles sp JOIN symbols s ON s.id = sp.symbol_id
            JOIN vocabularies v ON v.id = s.vocabulary_id
           WHERE v.key LIKE 'vml-%' AND sp.profile_id = ?) AS in_transitional,
         (SELECT COUNT(*) FROM symbol_profiles sp JOIN symbols s ON s.id = sp.symbol_id
            JOIN vocabularies v ON v.id = s.vocabulary_id
           WHERE v.key LIKE 'vml-%' AND sp.profile_id = ?) AS in_strict`,
      transitional,
      strict,
    ),

    // Namespace aliasing: one vocabulary, two URIs.
    'wml namespaces by profile': all(
      `SELECT p.key AS profile, n.uri, n.preferred_prefix
         FROM namespaces n JOIN profiles p ON p.id = n.profile_id
         JOIN vocabularies v ON v.id = n.vocabulary_id
        WHERE v.key = 'wml' ORDER BY p.id`,
    ),

    // Local scoping: the same element name declared under many owners.
    'local w:p declarations': one(
      `SELECT COUNT(*) AS declarations, COUNT(DISTINCT parent_symbol_id) AS owners,
              COUNT(DISTINCT type_ref) AS distinct_types
         FROM symbols WHERE local_name = 'p' AND kind = 'element' AND parent_symbol_id <> 0`,
    ),

    'row counts': one(
      `SELECT
         (SELECT COUNT(*) FROM symbols) AS symbols,
         (SELECT COUNT(*) FROM symbols WHERE is_anonymous = 1) AS anonymous,
         (SELECT COUNT(*) FROM compositors) AS compositors,
         (SELECT COUNT(*) FROM child_edges) AS child_edges,
         (SELECT COUNT(*) FROM group_edges) AS group_edges,
         (SELECT COUNT(*) FROM attr_edges) AS attr_edges,
         (SELECT COUNT(*) FROM inheritance_edges) AS inheritance_edges,
         (SELECT COUNT(*) FROM enums) AS enums,
         (SELECT COUNT(*) FROM simple_type_facets) AS simple_type_facets,
         (SELECT COUNT(*) FROM union_members) AS union_members`,
    ),
  };
}

describe('goldens', () => {
  test('the graph matches core/fixtures/graph.json', () => {
    const serialised = JSON.stringify(goldenQueries(), null, 2);
    if (process.env.UPDATE_GOLDENS === '1') {
      writeFileSync(GOLDEN, `${serialised}\n`);
      console.log(`wrote ${GOLDEN} — read the diff before committing`);
      return;
    }
    // Compare the JSON round-trip, not the query results directly: node:sqlite
    // hands back null-prototype rows, which deepEqual reports as different from
    // the plain objects JSON.parse produces even when every field matches.
    const actual = JSON.parse(serialised);
    const expected = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    for (const key of Object.keys(expected)) {
      assert.deepEqual(actual[key], expected[key], `golden "${key}" changed`);
    }
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  });
});

// Keep the path join referenced so a future move of GOLDEN is a one-line edit.
export const goldenPath = join(GOLDEN);
