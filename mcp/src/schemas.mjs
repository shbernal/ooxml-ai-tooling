/**
 * Output schemas for the MCP tools.
 *
 * Each describes what one core function returns, so a client knows the shape
 * before calling, and the SDK checks every result against it before it leaves
 * the server. That check is the point: the responses are discriminated
 * (`found: true` carries fields `found: false` does not, an ambiguous name
 * carries `variants` instead of the answer) and nothing else type-checks them —
 * the tests are outside `tsc`.
 *
 * MCP-only, because it needs zod and the core has no runtime dependencies. It
 * is not in `CORE_FILES` and is not vendored anywhere.
 *
 * ## Why every tool's schema is a union
 *
 * Each tool's schema is the exact union of its response shapes, so a client
 * sees which fields go together, not one object where every field is optional.
 * The SDK advertises a union as `anyOf` under a top-level `type: "object"`,
 * which is what MCP requires of an output schema, and checks results against
 * the whole union.
 *
 * Every field the core writes must be named here. Every shape is strict, and
 * the advertised JSON Schema says `additionalProperties: false`, so an unnamed
 * field fails the server's check and a client's. `mcp/schemas.test.mjs` runs
 * the whole corpus through these to catch exactly that.
 */
import {z} from 'zod';
import {PROFILE_KEYS} from './graph.mjs';

/**
 * One tool's schema: the union of its response shapes.
 *
 * @param {string} description
 * @param {[z.ZodType, ...z.ZodType[]]} shapes
 */
const oneOf = (description, shapes) => z.union(shapes).describe(description);

// ---------------------------------------------------------------- shared ---

/**
 * A sub-schema emitted once under `$defs` and referenced from every use.
 * Without it the JSON Schema inlines each use, and `ooxml_explain` — which
 * embeds the children and attributes answers — lists the same particle tree
 * several times over.
 *
 * @template {z.ZodType} T
 * @param {string} id
 * @param {T} schema
 * @returns {T}
 */
const shared = (id, schema) => schema.meta({id});

const PROFILE = z.enum(PROFILE_KEYS);
const QUERY = z.string();
const MESSAGE = z.string();
const COUNT = z.number().int().nonnegative();
const TRUE = z.literal(true);
const FALSE = z.literal(false);
/** min/max occurrence; -1 is unbounded. */
const OCCURS = z.number().int().min(-1);
const SYMBOL_KIND = z.enum([
  'element',
  'attribute',
  'complexType',
  'simpleType',
  'group',
  'attributeGroup',
]);
const NULLABLE_STRING = z.string().nullable();
const STRINGS = z.array(z.string());
const EXTERNAL_SOURCE = z
  .string()
  .optional()
  .describe(
    'Only on a vocabulary ECMA-376 references without defining (Dublin Core): where it is ' +
      'really defined. Its symbols carry no type here.',
  );

/** Why a name did not resolve. The next action differs per reason. */
const LOOKUP_MISS = ['unknown_vocabulary', 'not_in_profile', 'unknown_symbol'];

/** The core's `notFound` envelope, plus any tool-specific reasons. */
const notFound = (/** @type {string[]} */ extra = []) =>
  z.strictObject({
    query: QUERY,
    profile: PROFILE,
    found: FALSE,
    reason: z.enum([...LOOKUP_MISS, ...extra]),
    message: MESSAGE,
    profiles: z
      .array(PROFILE)
      .optional()
      .describe('With reason not_in_profile: the profiles the name does exist in.'),
  });

const NOT_FOUND = notFound();
const NO_CONTENT_MODEL = notFound(['no_content_model']);
/** For the tools that take only some kinds of symbol, and so can miss on kind alone. */
const KIND_MISS = notFound(['wrong_kind']).extend({
  kinds: z
    .array(SYMBOL_KIND)
    .optional()
    .describe('With reason wrong_kind: what the name is instead, in this profile if it is there.'),
});

/** A type reference, resolved. A built-in stays named and carries no symbol. */
const TYPE_REF = shared(
  'TypeRef',
  z.union([
    z.strictObject({qname: NULLABLE_STRING, builtin: TRUE}),
    z.strictObject({qname: z.string(), kind: SYMBOL_KIND, builtin: FALSE, id: COUNT}),
  ]),
);

const SYMBOL = {
  id: COUNT,
  qname: z.string(),
  name: z.string(),
  kind: SYMBOL_KIND,
  vocabulary: z.string(),
  namespace: z.strictObject({uri: z.string(), prefix: NULLABLE_STRING}).nullable(),
  profiles: z.array(PROFILE),
  scope: z.union([z.literal('global'), z.strictObject({declared_in: z.string()})]),
  type: TYPE_REF.nullable(),
  external_source: EXTERNAL_SOURCE,
};

/** How an ambiguous answer is shaped, whatever it is ambiguous about. */
const ambiguous = (/** @type {z.ZodType} */ variant) =>
  z.strictObject({
    query: QUERY,
    profile: PROFILE,
    found: TRUE,
    ambiguous: TRUE,
    message: MESSAGE,
    variants: z.array(variant),
  });

/** Where a variant applies, on the tools that resolve a name to a type. */
const PLACEMENT = {
  type: z.string(),
  resolved_from: z.string().optional(),
  applies_when_declared_in: STRINGS.optional(),
};

// -------------------------------------------------------- value spaces ---

const FACETS = z.partialRecord(
  z.enum([
    'length',
    'minLength',
    'maxLength',
    'pattern',
    'minInclusive',
    'maxInclusive',
    'minExclusive',
    'maxExclusive',
    'totalDigits',
    'fractionDigits',
    'whiteSpace',
  ]),
  z.string(),
);

/** @type {z.ZodType} */
const MEMBER = shared(
  'UnionMember',
  z.lazy(() =>
    z.union([
      z.strictObject({type: NULLABLE_STRING, builtin: TRUE}),
      z.strictObject({type: z.string().optional(), inline: TRUE.optional(), ...VALUE_SPACE}),
    ]),
  ),
);

const VALUE_SPACE = {
  base: NULLABLE_STRING.optional(),
  enumeration: STRINGS.optional(),
  facets: FACETS.optional(),
  one_of: z.array(MEMBER).optional(),
  list_of: z.array(MEMBER).optional(),
  unconstrained: TRUE.optional(),
  truncated: TRUE.optional(),
};

// ---------------------------------------------------------------- tools ---

export const ELEMENT = oneOf('ooxml_element: every symbol the name resolves to.', [
  z.strictObject({
    query: QUERY,
    profile: PROFILE,
    found: TRUE,
    count: COUNT,
    symbols: z.array(z.strictObject(SYMBOL)),
  }),
  NOT_FOUND,
]);

export const TYPE = oneOf('ooxml_type: what each matching type derives from, and its shape.', [
  z.strictObject({
    query: QUERY,
    profile: PROFILE,
    found: TRUE,
    count: COUNT,
    types: z.array(
      z.strictObject({
        ...SYMBOL,
        derivation: z
          .strictObject({
            relation: z.enum(['extension', 'restriction']),
            content_model: z.enum(['simpleType', 'simpleContent', 'complexContent']),
            base: TYPE_REF,
          })
          .nullable(),
        content: z
          .union([
            z.literal('empty'),
            z.strictObject({
              top: z.array(z.enum(['sequence', 'choice', 'all'])),
              direct_children: COUNT,
              group_refs: COUNT,
            }),
          ])
          .optional()
          .describe('complexType only.'),
        attribute_count: COUNT.optional().describe('complexType only.'),
        value_space: z.strictObject(VALUE_SPACE).optional().describe('simpleType only.'),
      }),
    ),
  }),
  KIND_MISS,
]);

const FROM = z.string().optional().describe('The base type or group that contributed this.');

/** @type {z.ZodType} */
const PARTICLE = shared(
  'Particle',
  z.lazy(() =>
    z.union([
      z.strictObject({
        kind: z.enum(['sequence', 'choice', 'all']),
        min: OCCURS,
        max: OCCURS,
        from: FROM,
        children: z.array(PARTICLE),
      }),
      z.strictObject({
        kind: z.literal('element'),
        qname: z.string(),
        type: NULLABLE_STRING,
        min: OCCURS,
        max: OCCURS,
        from: FROM,
      }),
      z.strictObject({
        kind: z.literal('any'),
        namespace: NULLABLE_STRING,
        process_contents: NULLABLE_STRING,
        min: OCCURS,
        max: OCCURS,
        from: FROM,
      }),
      z.strictObject({
        kind: z.literal('group'),
        qname: z.string(),
        min: OCCURS,
        max: OCCURS,
        from: FROM,
        children: z.array(PARTICLE).optional(),
        recursive: TRUE.optional(),
        truncated: TRUE.optional(),
      }),
    ]),
  ),
);

const ORDERED = shared(
  'Ordered',
  z.union([
    z.strictObject({
      qname: z.string(),
      type: NULLABLE_STRING,
      min: OCCURS,
      max: OCCURS,
      in: z.string(),
      from: FROM,
    }),
    z.strictObject({wildcard: NULLABLE_STRING, process_contents: NULLABLE_STRING, in: z.string()}),
  ]),
);

const CONTENT_MODEL = {
  ...PLACEMENT,
  truncated: z.boolean(),
  tree: z.array(PARTICLE),
  order: z.array(ORDERED),
};

const CHILDREN_FOUND = z.strictObject({
  query: QUERY,
  profile: PROFILE,
  found: TRUE,
  ...CONTENT_MODEL,
});
const CHILDREN_AMBIGUOUS = ambiguous(z.strictObject(CONTENT_MODEL));

export const CHILDREN = oneOf('ooxml_children: the content model, as a tree and in order.', [
  CHILDREN_FOUND,
  CHILDREN_AMBIGUOUS,
  NO_CONTENT_MODEL,
]);

const ATTRIBUTE = shared(
  'Attribute',
  z.strictObject({
    name: z.string(),
    qname: z
      .string()
      .optional()
      .describe('Qualified attributes only: the prefixed name a document writes, e.g. r:id.'),
    qualified: z.boolean(),
    use: z.enum(['optional', 'required', 'prohibited']),
    type: TYPE_REF.nullable(),
    default: z.string().optional(),
    fixed: z.string().optional(),
    from: FROM,
  }),
);

const ATTRIBUTE_LIST = {
  ...PLACEMENT,
  truncated: z.boolean(),
  count: COUNT,
  attributes: z.array(ATTRIBUTE),
};

const ATTRIBUTES_FOUND = z.strictObject({
  query: QUERY,
  profile: PROFILE,
  found: TRUE,
  ...ATTRIBUTE_LIST,
});
const ATTRIBUTES_AMBIGUOUS = ambiguous(z.strictObject(ATTRIBUTE_LIST));

export const ATTRIBUTES = oneOf(
  'ooxml_attributes: every attribute the type accepts, inherited and grouped ones included.',
  [ATTRIBUTES_FOUND, ATTRIBUTES_AMBIGUOUS, NO_CONTENT_MODEL],
);

const ENUMERATION = {
  type: NULLABLE_STRING,
  enumerated: z.boolean(),
  reason: z.literal('not_a_simple_type').optional(),
  message: MESSAGE.optional(),
  count: COUNT.optional(),
  values: STRINGS,
};

export const ENUM = oneOf('ooxml_enum: the enumerated values, in schema order.', [
  z.strictObject({query: QUERY, profile: PROFILE, found: TRUE, ...ENUMERATION}),
  ambiguous(z.strictObject(ENUMERATION)),
  KIND_MISS,
]);

const VALUE_ANSWER = {
  type: NULLABLE_STRING,
  builtin: TRUE.optional(),
  message: MESSAGE.optional(),
  external_source: EXTERNAL_SOURCE,
  ...VALUE_SPACE,
};

const VALUES_FOUND = z.strictObject({query: QUERY, profile: PROFILE, found: TRUE, ...VALUE_ANSWER});
const VALUES_AMBIGUOUS = ambiguous(z.strictObject(VALUE_ANSWER));

export const VALUES = oneOf('ooxml_values: the legal value space of a simple type.', [
  VALUES_FOUND,
  VALUES_AMBIGUOUS,
  KIND_MISS,
]);

export const NAMESPACE = oneOf('ooxml_namespace: matching namespaces, in every profile.', [
  z.strictObject({
    query: QUERY,
    found: TRUE,
    count: COUNT,
    namespaces: z.array(
      z.strictObject({
        vocabulary: z.string(),
        uri: z.string(),
        prefix: NULLABLE_STRING,
        profile: PROFILE,
        aliases: z.array(z.strictObject({prefix: z.string(), source: z.string()})).optional(),
        external_source: EXTERNAL_SOURCE,
      }),
    ),
  }),
  z.strictObject({
    query: QUERY,
    found: FALSE,
    reason: z.literal('unknown_namespace'),
    message: MESSAGE,
    known_prefixes: STRINGS,
  }),
]);

const MATCH = z.string().describe('How the search matched. Always a name substring.');

export const SEARCH = oneOf('ooxml_search: symbols whose name contains the text.', [
  z.strictObject({
    query: QUERY,
    profile: PROFILE,
    match: MATCH,
    found: TRUE,
    count: COUNT,
    truncated: z.boolean(),
    results: z.array(
      z.strictObject({
        qname: z.string(),
        kind: SYMBOL_KIND,
        vocabulary: z.string(),
        declared_in: z.string().optional(),
        type: z.string().optional(),
      }),
    ),
  }),
  z.strictObject({query: QUERY, profile: PROFILE, match: MATCH, found: FALSE, message: MESSAGE}),
  z.strictObject({
    query: QUERY,
    profile: PROFILE,
    found: FALSE,
    reason: z.literal('empty_query'),
    message: MESSAGE,
  }),
]);

export const DIFF_PROFILES = oneOf('ooxml_diff_profiles: what Transitional adds to Strict.', [
  z.strictObject({
    query: QUERY,
    found: TRUE,
    count: COUNT,
    symbols: z.array(
      z.strictObject({
        qname: z.string(),
        kind: SYMBOL_KIND,
        in_profiles: z.array(PROFILE),
        absent_from: z.array(PROFILE).optional(),
        differences: STRINGS,
        detail: z.partialRecord(
          PROFILE,
          z.strictObject({
            namespace: NULLABLE_STRING,
            children: COUNT,
            attributes: COUNT,
            enumeration: STRINGS,
            union_members: z.array(NULLABLE_STRING),
          }),
        ),
      }),
    ),
  }),
  // The one not-found answer with no profile: this tool spans both.
  NOT_FOUND.omit({profile: true}),
]);

// -------------------------------------------------------------- explain ---

/** A variant `explain` picked by walking the xpath. */
const NARROWED = {narrowed_by: z.string().optional()};

/** Shared because two of the answers below carry it. */
const LEGAL = shared(
  'Legal',
  z.union([
    ...[CHILDREN_FOUND.extend(NARROWED), CHILDREN_AMBIGUOUS, NO_CONTENT_MODEL].map((shape) =>
      shape.extend({kind: z.literal('children')}),
    ),
    ...[ATTRIBUTES_FOUND.extend(NARROWED), ATTRIBUTES_AMBIGUOUS, NO_CONTENT_MODEL].map((shape) =>
      shape.extend({kind: z.literal('attributes'), note: z.string().optional()}),
    ),
    z.strictObject({
      kind: z.literal('attribute_values'),
      attribute: ATTRIBUTE,
      on: z.string(),
      values: z.union([VALUES_FOUND, VALUES_AMBIGUOUS, NOT_FOUND]).nullable(),
    }),
  ]),
);

const EXPLAINED = {
  diagnostic: z.strictObject({
    id: NULLABLE_STRING,
    part: NULLABLE_STRING,
    xpath: NULLABLE_STRING,
    description: NULLABLE_STRING,
  }),
  profile: PROFILE,
  position: z.strictObject({path: STRINGS, element: NULLABLE_STRING, truncated: z.boolean()}),
  message: MESSAGE,
};

export const EXPLAIN = oneOf('ooxml_explain: what the finding means and what is legal there.', [
  z.strictObject({
    ...EXPLAINED,
    resolved: TRUE,
    finding: z.strictObject({kind: z.string(), name: z.string().optional()}),
    legal: LEGAL,
  }),
  z.strictObject({
    ...EXPLAINED,
    resolved: FALSE,
    reason: z.enum(['no_id', 'unrecognised_id']),
    legal: LEGAL,
  }),
  z.strictObject({...EXPLAINED, resolved: FALSE, reason: z.literal('no_position')}),
]);
