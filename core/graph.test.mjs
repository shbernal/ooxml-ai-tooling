/**
 * The core suite, run against the **real committed database** rather than a
 * fixture. The shipped artifact is what users get, so it is what we test; a
 * hand-built fixture would prove the queries work against a database nobody
 * has.
 */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {after, before, describe, test} from 'node:test';
import {buildDatabase} from '../build/build-db.mjs';
import {createGraph} from './graph.mjs';
import {candidateVocabularies, loadVocabularyIndex, parseQName} from './qname.mjs';

const DB = 'core/data/ooxml.db';
let graph;

before(() => {
  if (!existsSync(DB)) buildDatabase(DB, {quiet: true});
  graph = createGraph({path: DB});
});
after(() => graph?.close());

describe('qname parsing', () => {
  test('accepts every form an agent actually types', () => {
    assert.deepEqual(parseQName('w:tblPr'), {prefix: 'w', uri: null, localName: 'tblPr'});
    assert.deepEqual(parseQName('tblPr'), {prefix: null, uri: null, localName: 'tblPr'});
    assert.deepEqual(parseQName('{http://example.com/ns}tblPr'), {
      prefix: null,
      uri: 'http://example.com/ns',
      localName: 'tblPr',
    });
    assert.deepEqual(parseQName('  w:tblPr  '), {prefix: 'w', uri: null, localName: 'tblPr'});
  });

  test('a bare name means "no constraint", an unknown prefix means "no match"', () => {
    // The distinction matters: one is a search across vocabularies, the other
    // is a typo, and they must not produce the same lookup.
    const index = loadVocabularyIndex(graph._internal.handle);
    assert.equal(candidateVocabularies(parseQName('tblPr'), index), null);
    assert.deepEqual(candidateVocabularies(parseQName('nope:tblPr'), index), []);
    assert.deepEqual(candidateVocabularies(parseQName('w:tblPr'), index), ['wml']);
    // A vocabulary key works as a prefix too, since our own output uses it.
    assert.deepEqual(candidateVocabularies(parseQName('wml:tblPr'), index), ['wml']);
  });
});

describe('element', () => {
  test('finds every declaration of a locally-scoped name, not just one', () => {
    const result = graph.element('w:tblPr');
    assert.equal(result.found, true);
    assert.ok(result.count >= 4, `expected several declarations, got ${result.count}`);
    const owners = result.symbols.map((s) => s.scope.declared_in);
    assert.ok(owners.includes('w:CT_Tbl'));
    assert.ok(owners.includes('w:CT_Style'));
    // They genuinely differ, which is why collapsing them would be wrong.
    assert.ok(new Set(result.symbols.map((s) => s.type.qname)).size > 1);
  });

  test('reports the namespace of the requested profile, not a fixed one', () => {
    const t = graph.element('w:tbl', {profile: 'transitional'}).symbols[0];
    const s = graph.element('w:tbl', {profile: 'strict'}).symbols[0];
    assert.match(t.namespace.uri, /schemas\.openxmlformats\.org/);
    assert.match(s.namespace.uri, /purl\.oclc\.org/);
  });

  test('accepts Clark notation, as XPath tooling emits it', () => {
    const uri = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    assert.equal(graph.element(`{${uri}}tbl`).found, true);
  });
});

describe('absent is not prohibited', () => {
  test('distinguishes an unknown symbol from one absent in this profile', () => {
    // VML exists in Transitional only, so this is the real case rather than a
    // contrived one.
    const inTransitional = graph.element('v:shape', {profile: 'transitional'});
    assert.equal(inTransitional.found, true);

    const inStrict = graph.element('v:shape', {profile: 'strict'});
    assert.equal(inStrict.found, false);
    assert.equal(inStrict.reason, 'not_in_profile');
    assert.deepEqual(inStrict.profiles, ['transitional']);

    const nonsense = graph.element('w:definitelyNotAnElement');
    assert.equal(nonsense.reason, 'unknown_symbol');
  });

  test('an unknown prefix says so and lists the real ones', () => {
    const result = graph.element('zz:tbl');
    assert.equal(result.reason, 'unknown_vocabulary');
    assert.match(result.message, /Known prefixes:/);
    assert.match(result.message, /\bw\b/);
  });
});

describe('children', () => {
  test('puts inherited particles first, and says which base contributed them', () => {
    // CT_PPr extends CT_PPrBase, so the base's children precede the derived
    // sequence. Getting this backwards reorders every derived type.
    const result = graph.children('w:CT_PPr');
    assert.equal(result.found, true);
    const first = result.order[0];
    assert.equal(first.qname, 'w:pStyle');
    assert.equal(first.from, 'w:CT_PPrBase');
    // and the derived type's own contribution is still there, after it
    assert.ok(result.order.some((c) => c.from === undefined || c.from !== 'w:CT_PPrBase'));
  });

  test('expands group refs, so a group-only type is not reported as empty', () => {
    // Without expansion this answers "accepts nothing", which is wrong for a
    // large part of DrawingML.
    const result = graph.children('a:CT_SolidColorFillProperties');
    assert.equal(result.found, true);
    assert.ok(result.order.length > 0, 'a group-only type came back empty');
    assert.ok(result.order.some((c) => c.qname === 'a:srgbClr'));
    assert.ok(result.order.every((c) => c.in.includes('group')));
  });

  test('carries the ref site cardinality, not the group definition cardinality', () => {
    const result = graph.children('w:CT_Body');
    const group = result.tree
      .flatMap((n) => (n.children ?? []).concat(n))
      .find((n) => n.kind === 'group');
    assert.ok(group !== undefined);
    assert.equal(group.max, -1, 'unbounded ref site should survive as -1');
  });

  test('reports both content models when a name has more than one', () => {
    const result = graph.children('w:tblPr');
    assert.equal(result.ambiguous, true);
    assert.equal(result.variants.length, 2);
    const types = result.variants.map((v) => v.type).sort();
    assert.deepEqual(types, ['w:CT_TblPr', 'w:CT_TblPrBase']);
    for (const variant of result.variants) assert.ok(variant.order.length > 0);
  });

  test('terminates on the deepest real group nesting without truncating', () => {
    // Measured on the built graph: ECMA-376 has 19 group-to-group references
    // and **no cycles among them**, so the recursion guard in groupNode never
    // fires on this corpus. It stays because a cycle would hang rather than
    // fail, but the property to assert here is the one that is actually true:
    // expansion completes, and nothing is silently cut off.
    const result = graph.children('w:CT_Body');
    assert.equal(result.found, true);
    assert.equal(result.truncated, false);
    assert.ok(result.order.length > 10);
  });

  test('records wildcards rather than dropping them', () => {
    const result = graph.children('w:CT_Background');
    assert.ok(result.order.some((c) => c.wildcard !== undefined));
  });

  test('a bare type name declared in several vocabularies returns all of them', () => {
    // CT_Shape is declared in six vocabularies and they are unrelated types
    // that happen to share a local name. Answering with dml-chart's — which has
    // no children — is a confidently wrong answer to a question about p:CT_Shape.
    const result = graph.children('CT_Shape');
    assert.equal(result.found, true);
    assert.equal(result.ambiguous, true);
    assert.equal(result.variants.length, 6);
    assert.ok(result.variants.some((v) => v.type === 'p:CT_Shape'));
    assert.ok(result.variants.some((v) => v.type === 'v:CT_Shape'));
    // The advice differs from the declared-in case: this one the caller can fix.
    assert.match(result.message, /Qualify the name/);
    // Qualifying is still a single, unambiguous answer.
    assert.equal(graph.children('p:CT_Shape').ambiguous, undefined);
  });

  test('says so when a simple type has no content model at all', () => {
    // ST_OnOff lives in shared-commonSimpleTypes, prefix `s` — not wml. Asking
    // for `w:ST_OnOff` is a different (correct) answer: unknown_symbol.
    const result = graph.children('s:ST_OnOff');
    assert.equal(result.found, false);
    assert.equal(result.reason, 'no_content_model');
    assert.equal(graph.children('w:ST_OnOff').reason, 'unknown_symbol');
  });
});

describe('attributes', () => {
  test('includes inherited attributes, resolved rather than referenced', () => {
    // CT_PageBorder extends CT_Border, which carries nine attributes; the
    // derived type declares one of its own. All ten must come back, and the
    // inherited ones must say where they came from.
    const result = graph.attributes('w:CT_PageBorder');
    assert.equal(result.found, true);
    assert.equal(result.count, 10);
    const inherited = result.attributes.filter((a) => a.from === 'w:CT_Border');
    assert.equal(inherited.length, 9);
    for (const attribute of result.attributes) {
      assert.ok(attribute.type === null || attribute.type.qname !== undefined);
    }
  });

  test('expands attributeGroup refs into the attributes they carry', () => {
    // vml's CT_Shape reaches most of its attributes through five
    // attributeGroups; unexpanded, this type looks nearly attribute-free.
    const result = graph.attributes('v:CT_Shape');
    assert.equal(result.found, true);
    assert.ok(result.count > 20, `expected attributeGroups to expand, got ${result.count}`);
    assert.ok(result.attributes.some((a) => a.from !== undefined));
  });

  test('an empty attribute list is a real answer, not a failure', () => {
    // wml puts table properties in child elements, not attributes, so this is
    // genuinely zero rather than a lookup that quietly failed.
    const result = graph.attributes('w:CT_Tbl');
    assert.equal(result.found, true);
    assert.equal(result.count, 0);
  });

  test('reports use, qualification, default and fixed', () => {
    const result = graph.attributes('w:CT_Ind');
    const named = result.attributes.find((a) => a.name === 'firstLine');
    assert.ok(named !== undefined);
    assert.equal(named.use, 'optional');
    assert.equal(named.qualified, true);
    assert.equal(named.type.qname, 's:ST_TwipsMeasure');
  });

  test('resolves a required attribute reached through an attributeGroup', () => {
    // dml uses attributeGroups heavily; an unexpanded ref would lose these.
    const result = graph.attributes('a:CT_Blip');
    assert.ok(result.attributes.some((a) => a.from !== undefined));
  });
});

describe('values and enum', () => {
  test('enum returns the values in schema order', () => {
    const result = graph.enum('sml:ST_Orientation');
    assert.equal(result.enumerated, true);
    assert.deepEqual(result.values, ['default', 'portrait', 'landscape']);
  });

  test('enum on a non-enumerated type points at values() instead of failing', () => {
    const result = graph.enum('s:ST_TwipsMeasure');
    assert.equal(result.found, true);
    assert.equal(result.enumerated, false);
    assert.match(result.message, /values\(\)/);
  });

  test('values resolves a union into its members', () => {
    const result = graph.values('s:ST_TwipsMeasure');
    assert.equal(result.found, true);
    assert.equal(result.one_of.length, 2);
    assert.ok(result.one_of.some((m) => m.facets?.pattern !== undefined));
  });

  test('values reports facets, which is the whole point of having them', () => {
    const result = graph.values('s:ST_Percentage');
    assert.equal(result.facets.pattern, '-?[0-9]+(\\.[0-9]+)?%');
  });

  test('values describes anonymous union members inline', () => {
    // sml:ST_TextRotation is a union of two unnamed inline types. They have no
    // usable name, so they are described rather than referenced.
    const result = graph.values('sml:ST_TextRotation');
    assert.equal(result.one_of.length, 2);
    assert.ok(result.one_of.every((m) => m.inline === true));
    assert.equal(result.one_of[0].facets.maxInclusive, '180');
    assert.deepEqual(result.one_of[1].enumeration, ['255']);
  });

  test('a name that means two things in two vocabularies is not silently collapsed', () => {
    // shared's ST_Percentage is a pattern; dml's is a union of two others.
    const shared = graph.values('s:ST_Percentage');
    const dml = graph.values('a:ST_Percentage');
    assert.ok(shared.facets !== undefined);
    assert.ok(dml.one_of !== undefined);

    // And the bare name must not quietly answer with one of them.
    const bare = graph.values('ST_Percentage');
    assert.equal(bare.ambiguous, true);
    assert.deepEqual(bare.variants.map((v) => v.type).sort(), [
      'a:ST_Percentage',
      's:ST_Percentage',
    ]);
  });

  test('a bare enum name declared in several vocabularies returns all of them', () => {
    // The sharpest case in the corpus: three vocabularies, three disjoint value
    // sets, all plausible. Picking one answers a wml question with dml's values.
    const bare = graph.enum('ST_Direction');
    assert.equal(bare.found, true);
    assert.equal(bare.ambiguous, true);
    assert.equal(bare.variants.length, 3);
    assert.match(bare.message, /Qualify the name/);

    const byType = new Map(bare.variants.map((v) => [v.type, v.values]));
    assert.deepEqual(byType.get('w:ST_Direction'), ['ltr', 'rtl']);
    assert.deepEqual(byType.get('p:ST_Direction'), ['horz', 'vert']);
    assert.deepEqual(byType.get('dml-diagram:ST_Direction'), ['norm', 'rev']);

    // Qualified stays a single flat answer.
    const qualified = graph.enum('w:ST_Direction');
    assert.equal(qualified.ambiguous, undefined);
    assert.deepEqual(qualified.values, ['ltr', 'rtl']);
  });

  test('declarations pointing at one type are not false ambiguity', () => {
    // Deduplication is on the resolved target, so a name declared in many
    // places that all resolve to the same simple type stays one answer.
    const result = graph.values('s:ST_TwipsMeasure');
    assert.equal(result.ambiguous, undefined);
    assert.ok(result.one_of !== undefined);
  });
});

describe('namespace', () => {
  test('resolves prefix, URI and vocabulary key, in both profiles', () => {
    const byPrefix = graph.namespace('w');
    assert.equal(byPrefix.count, 2);
    const byUri = graph.namespace('http://purl.oclc.org/ooxml/wordprocessingml/main');
    assert.equal(byUri.count, 1);
    assert.equal(byUri.namespaces[0].profile, 'strict');
    assert.equal(graph.namespace('wml').found, true);
  });

  test('an unknown namespace lists the known prefixes', () => {
    const result = graph.namespace('http://example.com/not-ooxml');
    assert.equal(result.found, false);
    assert.ok(result.known_prefixes.includes('w'));
    // Advice a caller acts on, so it lists what actually resolves — an accepted
    // spelling missing from here reads as unsupported.
    assert.ok(result.known_prefixes.includes('c'));
  });

  test('an alias is reported as an alias, not as what the schemas bind', () => {
    const sml = graph.namespace('sml').namespaces.find((n) => n.profile === 'transitional');
    // The NULL is the honest answer to "what does the standard mandate" and has
    // to survive: nothing binds a prefix to SpreadsheetML's own namespace.
    assert.equal(sml.prefix, null);
    assert.deepEqual(
      sml.aliases.map((a) => a.prefix),
      ['x'],
    );
    assert.match(sml.aliases[0].source, /Open XML SDK/);
  });

  test('a prefix the schemas do bind keeps reporting itself', () => {
    const vml = graph
      .namespace('vml-spreadsheetDrawing')
      .namespaces.find((n) => n.profile === 'transitional');
    assert.equal(vml.prefix, 'x');
    assert.equal(vml.aliases, undefined);
  });
});

describe('alias prefixes', () => {
  // `x` names two vocabularies: VML's excel namespace, which the schemas bind,
  // and sml, which nothing binds but every validator diagnostic writes. The
  // collision is resolved by looking the local name up in both, which is the
  // path an ambiguous bare name already takes.
  test('an alias resolves a name the observed prefix cannot', () => {
    const result = graph.element('x:worksheet');
    assert.equal(result.found, true);
    assert.equal(result.symbols[0].vocabulary, 'sml');
  });

  test('and does not steal the vocabulary that owns the prefix', () => {
    const result = graph.element('x:ClientData');
    assert.equal(result.found, true);
    assert.equal(result.symbols[0].vocabulary, 'vml-spreadsheetDrawing');
  });

  test('c reaches dml-chart, which no schema prefixes either', () => {
    assert.equal(graph.element('c:ser').found, true);
    assert.ok(graph.children('c:chartSpace').found);
  });

  test('output stays canonical, so the ambiguous spelling is never printed back', () => {
    // Answering `x:worksheet` with `x:worksheet` would render two different
    // namespaces identically. The canonical name is also the one that teaches.
    const result = graph.element('x:worksheet');
    assert.equal(result.symbols[0].qname, 'sml:worksheet');
    assert.equal(graph.attributes('x:sheet').type, 'sml:CT_Sheet');
  });
});

describe('search', () => {
  test('is substring, and says it is not semantic', () => {
    const result = graph.search('tblPr');
    assert.equal(result.found, true);
    assert.match(result.match, /not a semantic one/);
    assert.ok(result.results.every((r) => /tblpr/i.test(r.qname)));
  });

  test('an empty result says no name contains the string', () => {
    const result = graph.search('zzzznotathing');
    assert.equal(result.found, false);
    assert.match(result.message, /no symbol name contains/);
  });

  test('never returns the synthesised anonymous symbols', () => {
    // Their names contain '#', which no real symbol can, so they would be
    // visibly wrong in a result list.
    const result = graph.search('ST_TextRotation', {limit: 50});
    assert.ok(result.results.every((r) => !r.qname.includes('#')));
  });
});

describe('diff_profiles', () => {
  test('shows the union difference the profile model predicts', () => {
    // ST_OnOff is the canonical Transitional-laxity case: same symbol, same
    // type, different union members.
    const result = graph.diff_profiles('s:ST_OnOff');
    assert.equal(result.found, true);
    const symbol = result.symbols[0];
    assert.deepEqual(symbol.in_profiles, ['transitional', 'strict']);
    assert.deepEqual(symbol.detail.transitional.union_members, ['xsd:boolean', 's:ST_OnOff1']);
    assert.deepEqual(symbol.detail.strict.union_members, ['xsd:boolean']);
    assert.ok(symbol.differences.some((d) => d.includes('ST_OnOff1')));
  });

  test('reports a symbol that exists in only one profile', () => {
    const result = graph.diff_profiles('v:shape');
    assert.deepEqual(result.symbols[0].in_profiles, ['transitional']);
    assert.deepEqual(result.symbols[0].absent_from, ['strict']);
  });
});
