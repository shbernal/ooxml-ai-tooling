import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {after, before, describe, test} from 'node:test';
import {buildDatabase} from '../build/build-db.mjs';
import {explainDiagnostic, parseDiagnosticXPath, SUPPORTED_DIAGNOSTIC_IDS} from './explain.mjs';
import {createGraph} from './graph.mjs';

const DB = 'core/data/ooxml.db';
let graph;

before(() => {
  if (!existsSync(DB)) buildDatabase(DB, {quiet: true});
  graph = createGraph({path: DB});
});
after(() => graph?.close());

describe('xpath parsing', () => {
  test('takes the last element step and keeps the trail', () => {
    assert.deepEqual(parseDiagnosticXPath('/p:sld[1]/p:cSld[1]/p:spTree[1]'), {
      steps: ['p:sld', 'p:cSld', 'p:spTree'],
      element: 'p:spTree',
    });
  });

  test('drops positional predicates, which the schema has no opinion about', () => {
    assert.equal(parseDiagnosticXPath('/w:document[1]/w:body[1]/w:p[3]').element, 'w:p');
    assert.equal(parseDiagnosticXPath('/w:document/w:body').element, 'w:body');
  });

  test('survives an empty or missing xpath', () => {
    assert.deepEqual(parseDiagnosticXPath(''), {steps: [], element: null});
    assert.deepEqual(parseDiagnosticXPath(undefined), {steps: [], element: null});
  });
});

describe('explain', () => {
  test('resolves an undeclared attribute to the legal attribute set', () => {
    const result = explainDiagnostic(graph, {
      id: 'Sch_UndeclaredAttribute',
      description: "The 'bogus' attribute is not declared.",
      partUri: '/word/document.xml',
      xpath: '/w:document[1]/w:body[1]/w:p[1]/w:pPr[1]/w:ind[1]',
    });
    assert.equal(result.resolved, true);
    assert.deepEqual(result.finding, {kind: 'undeclared_attribute', name: 'bogus'});
    assert.equal(result.legal.kind, 'attributes');
    assert.equal(result.legal.type, 'w:CT_Ind');
    assert.ok(result.legal.attributes.some((a) => a.name === 'firstLine'));
  });

  test('resolves an unexpected child to the ordered content model', () => {
    const result = explainDiagnostic(graph, {
      id: 'Sch_UnexpectedElementContentExpectingComplex',
      description: "The element has invalid child element 'w:bogus'.",
      xpath: '/w:document[1]/w:body[1]/w:p[1]/w:pPr[1]',
    });
    assert.equal(result.resolved, true);
    assert.equal(result.finding.kind, 'unexpected_child');
    assert.equal(result.legal.kind, 'children');
    assert.equal(result.legal.order[0].qname, 'w:pStyle');
  });

  test('uses the ancestor path to narrow a name with several content models', () => {
    // This is what `explain` can do that a bare children() call cannot.
    // `w:pPr` has three content models in wml, so children('w:pPr') must return
    // all three — but a pPr inside a w:p is unambiguously CT_PPr, and the
    // diagnostic's xpath says exactly that.
    assert.equal(graph.children('w:pPr').ambiguous, true);

    const result = explainDiagnostic(graph, {
      id: 'Sch_UnexpectedElementContentExpectingComplex',
      description: "The element has invalid child element 'w:bogus'.",
      xpath: '/w:document[1]/w:body[1]/w:p[1]/w:pPr[1]',
    });
    assert.equal(result.legal.ambiguous, undefined);
    assert.equal(result.legal.type, 'w:CT_PPr');
    assert.equal(result.legal.narrowed_by, 'w:p is w:CT_P');
  });

  test('falls back to every variant when the path cannot decide', () => {
    // Narrowing needs a resolvable ancestor chain. Without one, reporting all
    // the candidates beats picking a plausible wrong one.
    const result = explainDiagnostic(graph, {
      id: 'Sch_UnexpectedElementContentExpectingComplex',
      description: "invalid child element 'w:bogus'.",
      xpath: '/w:pPr[1]',
    });
    assert.equal(result.legal.ambiguous, true);
    assert.ok(result.legal.variants.length > 1);
  });

  test('resolves an invalid attribute value to that attribute value space', () => {
    const result = explainDiagnostic(graph, {
      id: 'Sch_AttributeValueDataTypeDetailed',
      description:
        "The attribute 'w:firstLine' has invalid value 'nope'. The string 'nope' is not a valid 'ST_TwipsMeasure' value.",
      xpath: '/w:document[1]/w:body[1]/w:p[1]/w:pPr[1]/w:ind[1]',
    });
    assert.equal(result.resolved, true);
    assert.equal(result.legal.kind, 'attribute_values');
    assert.equal(result.legal.attribute.name, 'firstLine');
    // The point of this branch: the bounds, not the type's name.
    assert.ok(result.legal.values.one_of.length > 0);
  });

  test('says which attribute does not exist when the name itself is wrong', () => {
    const result = explainDiagnostic(graph, {
      id: 'Sch_AttributeValueDataTypeDetailed',
      description: "The attribute 'notAnAttribute' has invalid value 'x'.",
      xpath: '/w:document[1]/w:body[1]/w:p[1]/w:pPr[1]/w:ind[1]',
    });
    assert.equal(result.legal.kind, 'attributes');
    assert.match(result.legal.note, /no attribute named/);
  });

  test('an unrecognised id still answers what is legal there', () => {
    // The degrade-gracefully rule: not a dead end, and honest that the finding
    // itself was not interpreted.
    const result = explainDiagnostic(graph, {
      id: 'Sch_SomethingWeDoNotModel',
      description: 'anything at all',
      xpath: '/w:document[1]/w:body[1]',
    });
    assert.equal(result.resolved, false);
    assert.equal(result.reason, 'unrecognised_id');
    assert.equal(result.legal.kind, 'children');
    assert.equal(result.legal.found, true);
    assert.match(result.message, /Recognised ids:/);
  });

  test('a missing xpath is the one thing it cannot work around', () => {
    const result = explainDiagnostic(graph, {
      id: 'Sch_UndeclaredAttribute',
      description: "The 'x' attribute is not declared.",
    });
    assert.equal(result.resolved, false);
    assert.equal(result.reason, 'no_position');
  });

  test('a mangled description costs the name, not the answer', () => {
    // The regexes are the only text handling here, so a miss must degrade to
    // "here is what is legal" rather than throwing.
    const result = explainDiagnostic(graph, {
      id: 'Sch_UndeclaredAttribute',
      description: 'wording we did not anticipate',
      xpath: '/w:document[1]/w:body[1]/w:p[1]/w:pPr[1]/w:ind[1]',
    });
    assert.equal(result.resolved, true);
    assert.equal(result.finding.name, undefined);
    assert.ok(result.legal.attributes.length > 0);
  });

  test('the allowlist is explicit, not a Sch_ prefix match', () => {
    assert.ok(SUPPORTED_DIAGNOSTIC_IDS.includes('Sch_UndeclaredAttribute'));
    assert.ok(SUPPORTED_DIAGNOSTIC_IDS.every((id) => id.startsWith('Sch_')));
    // A Sch_ id we do not model must not be treated as understood.
    const result = explainDiagnostic(graph, {
      id: 'Sch_UnexpectedElementContentExpectingSimple',
      description: 'x',
      xpath: '/w:document[1]',
    });
    assert.equal(result.resolved, false);
  });
});
