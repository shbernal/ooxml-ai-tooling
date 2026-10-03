/**
 * The output schemas against the whole graph.
 *
 * A schema that misses a shape the core really returns turns a working answer
 * into a protocol error, and the smoke test asks about a dozen names. So this
 * asks every tool about every name in the database, in both profiles, plus the
 * misses and the diagnostics, and checks two things per answer:
 *
 * - it passes the exact union, which is what the server enforces; and
 * - parsing dropped nothing, which is what a client validating against the
 *   advertised JSON Schema (`additionalProperties: false`) enforces. The SDK's
 *   own check strips unnamed fields and passes, so only this catches them.
 */
import assert from 'node:assert/strict';
import {after, describe, test} from 'node:test';
import {explainDiagnostic, parseDiagnosticText} from './src/explain.mjs';
import {createGraph, PROFILE_KEYS} from './src/graph.mjs';
import * as OUTPUT from './src/schemas.mjs';

const graph = createGraph();
after(() => graph.close());

/** Every field must survive a parse: zod strips what a schema does not name. */
function conforms(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) {
    assert.fail(`${label}: ${JSON.stringify(result.error.issues).slice(0, 2000)}`);
  }
  assert.deepEqual(result.data, value, `${label}: a field is missing from the schema`);
}

const names = graph._internal.handle
  .all(
    `SELECT DISTINCT v.key || ':' || s.local_name AS name
       FROM symbols s JOIN vocabularies v ON v.id = s.vocabulary_id
      WHERE s.is_anonymous = 0 ORDER BY name`,
  )
  .map((row) => row.name);

/** Unprefixed too, which is where the cross-vocabulary ambiguity is. */
const bare = [...new Set(names.map((name) => name.slice(name.indexOf(':') + 1)))];

const MISSES = ['w:notARealElement', 'nosuchprefix:p', 'w:', '', 'v:shape'];

describe('every answer conforms to its output schema', () => {
  const tools = [
    ['element', OUTPUT.ELEMENT],
    ['type', OUTPUT.TYPE],
    ['children', OUTPUT.CHILDREN],
    ['attributes', OUTPUT.ATTRIBUTES],
    ['enum', OUTPUT.ENUM],
    ['values', OUTPUT.VALUES],
  ];
  for (const [tool, schema] of tools) {
    test(tool, () => {
      for (const profile of PROFILE_KEYS) {
        for (const name of [...names, ...bare, ...MISSES]) {
          conforms(schema, graph[tool](name, {profile}), `${tool}(${name}, ${profile})`);
        }
      }
    });
  }

  test('diff_profiles', () => {
    for (const name of [...names, ...bare, ...MISSES]) {
      conforms(OUTPUT.DIFF_PROFILES, graph.diff_profiles(name), `diff_profiles(${name})`);
    }
  });

  test('search', () => {
    for (const text of ['tbl', 'ST_', '_', '%', '', 'zzzz', 'a']) {
      for (const profile of PROFILE_KEYS) {
        conforms(OUTPUT.SEARCH, graph.search(text, {profile}), `search(${text})`);
        conforms(OUTPUT.SEARCH, graph.search(text, {profile, limit: 1}), `search(${text}, 1)`);
      }
    }
  });

  test('namespace', () => {
    const queries = graph._internal.index.all.flatMap((v) => [
      v.key,
      ...v.namespaces.flatMap((n) => [n.uri, n.prefix ?? '']),
      ...v.aliasPrefixes.map((a) => a.prefix),
    ]);
    for (const query of [...queries, 'nope']) {
      conforms(OUTPUT.NAMESPACE, graph.namespace(query), `namespace(${query})`);
    }
  });

  test('explain', () => {
    const p = '/w:document[1]/w:body[1]/w:p[1]/w:pPr[1]';
    const diagnostics = [
      {
        id: 'Sch_UndeclaredAttribute',
        description: "The 'bogus' attribute is not declared.",
        xpath: `${p}/w:ind[1]`,
      },
      {id: 'Sch_MissRequiredAttribute', description: 'no name here', xpath: `${p}/w:ind[1]`},
      {
        id: 'Sch_InvalidAttributeValue',
        description: "The attribute 'w:firstLine' has invalid value.",
        xpath: `${p}/w:ind[1]`,
      },
      {
        id: 'Sch_InvalidAttributeValue',
        description: "The attribute 'w:val' has invalid value.",
        xpath: `${p}/w:jc[1]`,
      },
      {
        id: 'Sch_InvalidAttributeValue',
        description: "The attribute 'nope' has invalid value.",
        xpath: `${p}/w:jc[1]`,
      },
      {
        id: 'Sch_AttributeValueDataTypeDetailed',
        description: "attribute 'w:rsidR'",
        xpath: '/w:document[1]/w:body[1]/w:p[1]',
      },
      {
        id: 'Sch_UnexpectedElementContentExpectingComplex',
        description: "element 'w:bogus'",
        xpath: p,
      },
      {
        id: 'Sch_IncompleteContentExpectingComplex',
        xpath: '/w:document[1]/w:body[1]/w:tbl[1]/w:tblPr[1]',
      },
      {id: 'Sch_EmptyContentExpectingComplex', xpath: '/w:tblPr'},
      {id: 'Sch_UnexpectedElementQNameOrText', xpath: '/w:notReal'},
      {id: 'Sch_SomethingElse', xpath: p},
      {xpath: p},
      {id: 'Sch_UndeclaredAttribute', description: 'x'},
      {},
      parseDiagnosticText(
        `Sch_UndeclaredAttribute: The 'bogus' attribute is not declared. at ${p}`,
      ),
      parseDiagnosticText('nothing useful'),
    ];
    for (const diagnostic of diagnostics) {
      for (const profile of PROFILE_KEYS) {
        conforms(
          OUTPUT.EXPLAIN,
          explainDiagnostic(graph, diagnostic, {profile}),
          `explain(${JSON.stringify(diagnostic)}, ${profile})`,
        );
      }
    }
  });
});

describe('the exact union is enforced, not just the advertised superset', () => {
  test('found: true without its answer is refused', () => {
    assert.equal(
      OUTPUT.ELEMENT.safeParse({query: 'x', profile: 'strict', found: true}).success,
      false,
    );
  });

  test('a miss carrying a found-only field is refused', () => {
    const miss = graph.element('w:notARealElement');
    assert.equal(OUTPUT.ELEMENT.safeParse({...miss, count: 1, symbols: []}).success, false);
  });

  test('an ambiguous answer without variants is refused', () => {
    const answer = graph.children('tblPr');
    assert.equal(answer.ambiguous, true);
    const {variants: _, ...rest} = answer;
    assert.equal(OUTPUT.CHILDREN.safeParse(rest).success, false);
  });
});
