/**
 * XSD AST -> graph rows.
 *
 * Two passes, and the split is not stylistic: XSD references cross files freely
 * and forward-reference constantly, so nothing can be resolved until every
 * declaration in every file of the profile has been seen.
 *
 *   Pass 1  declare every symbol, assign ids in a sorted order
 *   Pass 2  walk the content models and write edges, resolving as we go
 *
 * Determinism is a property of pass 1: ids come from sorting, never from the
 * order the filesystem handed us files. See schema.sql.
 */
import {elements, isForeign, occurs, parseSchema} from './parse.mjs';

/**
 * Symbols are keyed by identity, not by id — ids do not exist until pass 1 ends.
 *
 * '|' is a safe separator because no field can contain one: vocabulary keys are
 * filenames, `kind` is a fixed set, and local names are XSD NCNames.
 */
const key = (vocabulary, kind, localName, parentKey) =>
  `${vocabulary}|${kind}|${localName}|${parentKey}`;

const GLOBAL = ''; // the parent key of a top-level declaration

const DEFINITION_KINDS = new Set(['complexType', 'simpleType', 'group', 'attributeGroup']);
const FACETS = new Set([
  'pattern',
  'minInclusive',
  'maxInclusive',
  'minExclusive',
  'maxExclusive',
  'length',
  'minLength',
  'maxLength',
  'whiteSpace',
  'totalDigits',
  'fractionDigits',
]);

/**
 * Constructs this corpus does not use. Rather than half-handle them, assert
 * they are absent and fail loudly if a future edition introduces one — a
 * half-handled construct produces a plausible, wrong graph, which is the
 * failure mode this whole file is designed against.
 */
const REJECTED = new Set(['redefine', 'override', 'include', 'notation', 'anyAttribute']);

/**
 * There is no xsd:annotation anywhere in ECMA-376 — zero elements across both
 * profiles — which is why `enums` has no annotation column. Assert it stays
 * that way rather than silently dropping documentation if it ever appears.
 */
const ABSENT = new Set(['annotation', 'documentation', 'appinfo']);

/** Parse every file of every profile once. */
export function parseProfiles(profiles, namespaceIndex) {
  return profiles.map((profile) => ({
    ...profile,
    schemas: profile.files.map((file) => parseSchema(file, namespaceIndex)),
  }));
}

/**
 * Pass 1 — every symbol in every profile, with ids assigned by sorting.
 *
 * The symbol universe is the *union* across profiles, because `symbols` is not
 * profile-scoped: one row serves both, and `symbol_profiles` records which
 * profiles it appears in.
 */
export function declareSymbols(parsed) {
  const symbols = new Map(); // key -> {vocabulary, kind, localName, parentKey, typeRef, profiles:Set}
  const problems = [];

  const declare = (
    vocabulary,
    kind,
    localName,
    parentKey,
    typeRef,
    profileKey,
    isAnonymous = false,
  ) => {
    const k = key(vocabulary, kind, localName, parentKey);
    let symbol = symbols.get(k);
    if (symbol === undefined) {
      symbol = {vocabulary, kind, localName, parentKey, typeRef, isAnonymous, profiles: new Set()};
      symbols.set(k, symbol);
    } else if (symbol.typeRef !== typeRef) {
      // Two declarations of one name in one scope must agree on their type —
      // XSD's "Element Declarations Consistent" rule. If they ever disagree,
      // the profile model's non-profile-scoped `type_ref` column is wrong and
      // we want to know here rather than from a bad answer later.
      problems.push(
        `${vocabulary}:${localName} (${kind}, parent ${parentKey || 'global'}) ` +
          `declares type ${symbol.typeRef} and ${typeRef}`,
      );
    }
    symbol.profiles.add(profileKey);
    return k;
  };

  for (const profile of parsed) {
    for (const schema of profile.schemas) {
      for (const node of elements(schema.root)) {
        const kind = schema.name(node);
        if (kind === null)
          throw new Error(`${schema.path}: non-XSD top-level element ${node.name}`);
        if (kind === 'import') continue;
        if (REJECTED.has(kind))
          throw new Error(`${schema.path}: unsupported construct xsd:${kind}`);

        const localName = node.attributes.name;
        if (localName === undefined) {
          throw new Error(`${schema.path}: top-level xsd:${kind} without a name`);
        }

        const typeRef = schema.canonical(node.attributes.type);
        const parent = declare(schema.vocabulary, kind, localName, GLOBAL, typeRef, profile.key);

        // Local element declarations, scoped to the definition that owns them.
        // `w:p` declared inside two complexTypes is two symbols, and neither is
        // a top-level `w:p`. In this corpus that is the common case: wml.xsd
        // has 14 global elements and well over a thousand local ones.
        if (DEFINITION_KINDS.has(kind)) {
          for (const local of localElements(schema, node)) {
            declare(
              schema.vocabulary,
              'element',
              local.attributes.name,
              parent,
              schema.canonical(local.attributes.type),
              profile.key,
            );
          }
          for (const anonymous of anonymousMembers(schema, node, localName)) {
            declare(
              schema.vocabulary,
              'simpleType',
              anonymous.name,
              parent,
              null,
              profile.key,
              true,
            );
          }
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`conflicting declarations:\n  ${problems.join('\n  ')}`);
  }

  return assignIds(symbols);
}

/**
 * Unnamed `xsd:simpleType` children of an `xsd:union`, in document order.
 *
 * XSD lets a union member be written inline instead of named. ECMA-376 does it
 * exactly once — sml's `ST_TextRotation` — but "once" is not "never", and the
 * one occurrence is a real spreadsheet attribute whose value space would
 * otherwise come back empty.
 *
 * The synthesised name is `<owner>#<n>`, unforgeable as a real symbol because
 * `#` is not legal in an NCName.
 */
function anonymousMembers(schema, node, ownerName) {
  const found = [];
  for (const child of elements(node)) {
    if (schema.name(child) !== 'union') continue;
    for (const member of elements(child)) {
      if (schema.name(member) !== 'simpleType') {
        throw new Error(`${schema.path}: xsd:${schema.name(member)} inside a union`);
      }
      if (member.attributes.name !== undefined) {
        throw new Error(`${schema.path}: named simpleType nested inside a union`);
      }
      found.push({name: `${ownerName}#${found.length + 1}`, node: member});
    }
  }
  return found;
}

/** Every descendant `xsd:element` carrying a `name` (a declaration, not a ref). */
function localElements(schema, node, found = []) {
  for (const child of elements(node)) {
    const kind = schema.name(child);
    if (ABSENT.has(kind)) throw new Error(`${schema.path}: unexpected xsd:${kind}`);
    if (REJECTED.has(kind)) throw new Error(`${schema.path}: unsupported construct xsd:${kind}`);
    if (kind === 'element' && child.attributes.name !== undefined) {
      found.push(child);
      // A named local element with children would be an inline type, which this
      // corpus does not contain (verified: zero). Recursing anyway would
      // silently mis-scope its descendants to the wrong owner.
      if (elements(child).length > 0) {
        throw new Error(`${schema.path}: inline type under element ${child.attributes.name}`);
      }
      continue;
    }
    localElements(schema, child, found);
  }
  return found;
}

/**
 * Ids by sorted insertion.
 *
 * Globals first, sorted by (vocabulary, kind, localName); then locals, sorted
 * by (parentId, vocabulary, kind, localName). Two levels is all this corpus has
 * — a local element cannot own another, since inline types do not occur — and
 * the assertion below keeps that true rather than assumed.
 */
function assignIds(symbols) {
  const ids = new Map();
  const byKey = (a, b) => {
    const x = symbols.get(a);
    const y = symbols.get(b);
    return (
      x.vocabulary.localeCompare(y.vocabulary, 'en') ||
      x.kind.localeCompare(y.kind, 'en') ||
      x.localName.localeCompare(y.localName, 'en')
    );
  };

  const globals = [...symbols.keys()].filter((k) => symbols.get(k).parentKey === GLOBAL);
  for (const k of globals.sort(byKey)) ids.set(k, ids.size + 1);

  const locals = [...symbols.keys()].filter((k) => symbols.get(k).parentKey !== GLOBAL);
  for (const k of locals) {
    if (!ids.has(symbols.get(k).parentKey)) {
      throw new Error(`symbol nested more than one level deep: ${k}`);
    }
  }
  locals.sort(
    (a, b) => ids.get(symbols.get(a).parentKey) - ids.get(symbols.get(b).parentKey) || byKey(a, b),
  );
  for (const k of locals) ids.set(k, ids.size + 1);

  return {symbols, ids};
}

/** Write `profiles`, `vocabularies`, `namespaces`, `symbols`, `symbol_profiles`. */
export function writeSymbols(db, parsed, universe) {
  const {symbols, ids} = universe;

  const profileIds = new Map();
  const insertProfile = db.prepare('INSERT INTO profiles (id, key, label) VALUES (?, ?, ?)');
  for (const [i, profile] of parsed.entries()) {
    profileIds.set(profile.key, i + 1);
    insertProfile.run(i + 1, profile.key, profile.label);
  }

  const vocabIds = new Map();
  const insertVocab = db.prepare('INSERT INTO vocabularies (id, key) VALUES (?, ?)');
  const vocabKeys = [...new Set([...symbols.values()].map((s) => s.vocabulary))].sort();
  for (const [i, vocabulary] of vocabKeys.entries()) {
    vocabIds.set(vocabulary, i + 1);
    insertVocab.run(i + 1, vocabulary);
  }

  const insertNs = db.prepare(
    'INSERT INTO namespaces (vocabulary_id, profile_id, uri, preferred_prefix) VALUES (?, ?, ?, ?)',
  );
  for (const profile of parsed) {
    const prefixes = observedPrefixes(profile.schemas);
    for (const schema of [...profile.schemas].sort((a, b) =>
      a.vocabulary.localeCompare(b.vocabulary, 'en'),
    )) {
      insertNs.run(
        vocabIds.get(schema.vocabulary),
        profileIds.get(profile.key),
        schema.targetNamespace,
        prefixes.get(schema.targetNamespace) ?? null,
      );
    }
  }

  // Insert in id order so the rowids the file ends up with match the ids we
  // computed — belt and braces, since the id is given explicitly anyway.
  const ordered = [...ids.keys()].sort((a, b) => ids.get(a) - ids.get(b));
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (id, vocabulary_id, local_name, kind, parent_symbol_id, type_ref,
                          is_anonymous)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMembership = db.prepare(
    'INSERT INTO symbol_profiles (symbol_id, profile_id) VALUES (?, ?)',
  );
  for (const k of ordered) {
    const symbol = symbols.get(k);
    insertSymbol.run(
      ids.get(k),
      vocabIds.get(symbol.vocabulary),
      symbol.localName,
      symbol.kind,
      symbol.parentKey === GLOBAL ? 0 : ids.get(symbol.parentKey),
      symbol.typeRef,
      symbol.isAnonymous ? 1 : 0,
    );
    for (const profileKey of [...symbol.profiles].sort()) {
      insertMembership.run(ids.get(k), profileIds.get(profileKey));
    }
  }

  return {profileIds, vocabIds};
}

/**
 * The prefix each namespace is conventionally written with, observed across the
 * whole profile rather than from the defining file alone.
 *
 * A schema usually does *not* bind a prefix to its own target namespace —
 * wml.xsd puts it on the default `xmlns=` and never mentions `w:` — so reading
 * only the defining file yields NULL for the most important vocabularies. The
 * evidence is in the *importers*: wml.xsd binds `s:` to sharedTypes, dml files
 * bind `a:` to drawingml/main, and so on.
 *
 * Ties break alphabetically, so this stays deterministic. A namespace no file
 * ever prefixes stays NULL, which is the honest answer: the standard does not
 * mandate a prefix, and inventing one here would be inventing convention rather
 * than reporting the schema.
 */
function observedPrefixes(schemas) {
  const counts = new Map(); // uri -> Map<prefix, count>
  for (const schema of schemas) {
    for (const [prefix, uri] of schema.prefixes) {
      if (prefix === null) continue; // the default binding names no prefix
      if (!counts.has(uri)) counts.set(uri, new Map());
      const forUri = counts.get(uri);
      forUri.set(prefix, (forUri.get(prefix) ?? 0) + 1);
    }
  }

  const chosen = new Map();
  for (const [uri, forUri] of counts) {
    const best = [...forUri.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'),
    );
    chosen.set(uri, best[0][0]);
  }
  return chosen;
}

/**
 * Resolve every canonical QName to a symbol id, once.
 *
 * Built after all symbols exist, keyed `vocabularyKey:localName` over *global*
 * symbols only — which is exactly right, because a QName reference in XSD can
 * only ever name a global declaration. Built-ins (`xsd:string`) resolve to
 * NULL by design; they are named in `type_ref` and have no row.
 */
export function buildResolver(db, universe) {
  const {symbols, ids} = universe;
  const byQName = new Map();
  for (const [k, symbol] of symbols) {
    if (symbol.parentKey !== GLOBAL) continue;
    byQName.set(`${symbol.kind}|${symbol.vocabulary}:${symbol.localName}`, ids.get(k));
  }

  const resolve = (kind, qname) => {
    if (qname === null || qname === undefined) return null;
    if (isForeign(qname)) return null; // xsd:/xml: — named, deliberately unresolved
    const id = byQName.get(`${kind}|${qname}`);
    if (id === undefined) throw new Error(`unresolved ${kind} reference: ${qname}`);
    return id;
  };

  // A type reference may name either a complexType or a simpleType and the
  // reference site never says which, so try both rather than guessing.
  const resolveType = (qname) => {
    if (qname === null || qname === undefined || isForeign(qname)) return null;
    const id = byQName.get(`complexType|${qname}`) ?? byQName.get(`simpleType|${qname}`);
    if (id === undefined) throw new Error(`unresolved type reference: ${qname}`);
    return id;
  };

  const update = db.prepare('UPDATE symbols SET type_symbol_id = ? WHERE id = ?');
  for (const [k, symbol] of symbols) {
    if (symbol.typeRef === null) continue;
    update.run(resolveType(symbol.typeRef), ids.get(k));
  }

  return {
    resolve,
    resolveType,
    id: (vocabulary, kind, localName, parentKey) =>
      ids.get(key(vocabulary, kind, localName, parentKey)),
  };
}

/**
 * Pass 2 — walk every definition's content model and write its edges.
 *
 * Everything written here carries `profile_id`, because everything here is what
 * the two profiles actually differ in.
 */
export function writeEdges(db, parsed, universe, resolver, profileIds) {
  const {ids} = universe;
  const stmt = {
    compositor: db.prepare(
      `INSERT INTO compositors (profile_id, kind, parent_symbol_id, parent_compositor_id,
                                min_occurs, max_occurs, order_index)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    child: db.prepare(
      `INSERT INTO child_edges (profile_id, parent_symbol_id, compositor_id, child_symbol_id,
                                min_occurs, max_occurs, order_index,
                                is_wildcard, wildcard_namespace, wildcard_process_contents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    group: db.prepare(
      `INSERT INTO group_edges (profile_id, parent_symbol_id, compositor_id, group_symbol_id,
                                ref_kind, min_occurs, max_occurs, order_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    attr: db.prepare(
      `INSERT INTO attr_edges (profile_id, symbol_id, attr_symbol_id, local_name, attr_use,
                               is_qualified, default_value, fixed_value, type_ref,
                               type_symbol_id, order_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    inherit: db.prepare(
      `INSERT INTO inheritance_edges (profile_id, symbol_id, base_symbol_id, base_type_ref,
                                      relation, content_model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    enumeration: db.prepare(
      'INSERT INTO enums (profile_id, symbol_id, value, order_index) VALUES (?, ?, ?, ?)',
    ),
    facet: db.prepare(
      `INSERT INTO simple_type_facets (profile_id, symbol_id, facet, value, order_index)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    member: db.prepare(
      `INSERT INTO union_members (profile_id, symbol_id, member_kind, member_type_ref,
                                  member_symbol_id, order_index)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
  };

  for (const profile of parsed) {
    const profileId = profileIds.get(profile.key);
    const schemas = [...profile.schemas].sort((a, b) =>
      a.vocabulary.localeCompare(b.vocabulary, 'en'),
    );

    for (const schema of schemas) {
      // Definitions in symbol-id order, so edge rowids do not depend on the
      // order declarations happen to appear in the file.
      const definitions = elements(schema.root)
        .filter((node) => DEFINITION_KINDS.has(schema.name(node)))
        .map((node) => ({
          node,
          kind: schema.name(node),
          id: resolver.id(schema.vocabulary, schema.name(node), node.attributes.name, GLOBAL),
        }))
        .sort((a, b) => a.id - b.id);

      for (const definition of definitions) {
        writeDefinition(stmt, schema, resolver, profileId, definition, ids);
      }
    }
  }
}

function writeDefinition(stmt, schema, resolver, profileId, definition, ids) {
  const {node, kind, id} = definition;
  // Local element symbols are keyed by their owner's *key*, not its id, because
  // that is how pass 1 recorded them — see `declare`.
  const ownerKey = key(schema.vocabulary, kind, node.attributes.name, GLOBAL);
  const context = {
    stmt,
    schema,
    resolver,
    profileId,
    ownerId: id,
    ownerKey,
    ownerName: node.attributes.name,
    ids,
  };

  if (kind === 'simpleType') {
    writeSimpleType(context, node, id);
    return;
  }

  // complexType / group / attributeGroup all reduce to: an optional derivation
  // shell, then particles, then attributes.
  let body = node;
  for (const child of elements(node)) {
    const name = schema.name(child);
    if (name === 'complexContent' || name === 'simpleContent') {
      const derivation = elements(child)[0];
      const relation = schema.name(derivation);
      if (relation !== 'extension' && relation !== 'restriction') {
        throw new Error(`${schema.path}: ${name} contains xsd:${relation}`);
      }
      const baseRef = schema.canonical(derivation.attributes.base);
      stmt.inherit.run(profileId, id, resolver.resolveType(baseRef), baseRef, relation, name);
      body = derivation;
      break;
    }
  }

  writeParticles(context, body);
  writeAttributes(context, body);
}

/** Compositors, element children, wildcards and group refs, in document order. */
function writeParticles(context, body, compositorId = null, depth = 0) {
  const {stmt, schema, resolver, profileId, ownerId} = context;
  let order = 0;

  for (const child of elements(body)) {
    const name = schema.name(child);

    if (name === 'sequence' || name === 'choice' || name === 'all') {
      const {min, max} = occurs(child);
      const result = stmt.compositor.run(
        profileId,
        name,
        compositorId === null ? ownerId : null,
        compositorId,
        min,
        max,
        order++,
      );
      writeParticles(context, child, Number(result.lastInsertRowid), depth + 1);
      continue;
    }

    if (name === 'element') {
      if (compositorId === null) {
        throw new Error(`${schema.path}: element particle outside a compositor`);
      }
      const {min, max} = occurs(child);
      const target =
        child.attributes.ref !== undefined
          ? resolver.resolve('element', schema.canonical(child.attributes.ref))
          : context.ids.get(
              key(schema.vocabulary, 'element', child.attributes.name, context.ownerKey),
            );
      stmt.child.run(profileId, ownerId, compositorId, target, min, max, order++, 0, null, null);
      continue;
    }

    if (name === 'any') {
      if (compositorId === null) {
        throw new Error(`${schema.path}: wildcard outside a compositor`);
      }
      const {min, max} = occurs(child);
      stmt.child.run(
        profileId,
        ownerId,
        compositorId,
        null,
        min,
        max,
        order++,
        1,
        child.attributes.namespace ?? '##any',
        child.attributes.processContents ?? 'strict',
      );
      continue;
    }

    if (name === 'group') {
      const {min, max} = occurs(child);
      stmt.group.run(
        profileId,
        ownerId,
        compositorId,
        resolver.resolve('group', schema.canonical(child.attributes.ref)),
        'group',
        min,
        max,
        order++,
      );
    }
  }
}

/** Inline attributes, attribute refs, and attributeGroup refs. */
function writeAttributes(context, body) {
  const {stmt, schema, resolver, profileId, ownerId} = context;
  let order = 0;

  for (const child of elements(body)) {
    const name = schema.name(child);

    if (name === 'attribute') {
      const isRef = child.attributes.ref !== undefined;
      const qname = isRef ? schema.canonical(child.attributes.ref) : null;
      const attrSymbolId = isRef ? resolver.resolve('attribute', qname) : null;
      const localName = isRef ? qname.slice(qname.indexOf(':') + 1) : child.attributes.name;
      const typeRef = schema.canonical(child.attributes.type);
      stmt.attr.run(
        profileId,
        ownerId,
        attrSymbolId,
        localName,
        child.attributes.use ?? 'optional',
        isQualified(schema, child) ? 1 : 0,
        child.attributes.default ?? null,
        child.attributes.fixed ?? null,
        typeRef,
        resolver.resolveType(typeRef),
        order++,
      );
      continue;
    }

    if (name === 'attributeGroup') {
      // An attributeGroup ref has no cardinality of its own; 1/1 records that
      // rather than leaving two columns meaningless.
      stmt.group.run(
        profileId,
        ownerId,
        null,
        resolver.resolve('attributeGroup', schema.canonical(child.attributes.ref)),
        'attributeGroup',
        1,
        1,
        order++,
      );
    }
  }
}

/**
 * Whether an attribute is written with a prefix. A per-attribute `form` wins
 * over the schema's `attributeFormDefault`, which itself defaults to
 * `unqualified` per the XSD spec. A ref always names a global attribute, and
 * global attributes are always qualified.
 */
function isQualified(schema, node) {
  if (node.attributes.ref !== undefined) return true;
  const form = node.attributes.form ?? schema.root.attributes.attributeFormDefault ?? 'unqualified';
  return form === 'qualified';
}

/** Enumerations, facets, unions, lists, and the base of a restriction. */
function writeSimpleType(context, node, id) {
  const {stmt, schema, resolver, profileId} = context;

  for (const child of elements(node)) {
    const name = schema.name(child);

    if (name === 'restriction') {
      const baseRef = schema.canonical(child.attributes.base);
      stmt.inherit.run(
        profileId,
        id,
        resolver.resolveType(baseRef),
        baseRef,
        'restriction',
        'simpleType',
      );

      let enumOrder = 0;
      let facetOrder = 0;
      for (const facet of elements(child)) {
        const facetName = schema.name(facet);
        if (facetName === 'enumeration') {
          stmt.enumeration.run(profileId, id, facet.attributes.value, enumOrder++);
        } else if (FACETS.has(facetName)) {
          stmt.facet.run(profileId, id, facetName, facet.attributes.value, facetOrder++);
        } else {
          throw new Error(`${schema.path}: unexpected xsd:${facetName} inside a restriction`);
        }
      }
      continue;
    }

    if (name === 'union') {
      // Named members come from @memberTypes, anonymous ones are inline
      // children. Both are members of the same union, so they share one
      // order_index sequence — @memberTypes first, per the XSD spec's ordering.
      let order = 0;
      const named = (child.attributes.memberTypes ?? '').split(/\s+/).filter(Boolean);
      for (const member of named) {
        const ref = schema.canonical(member);
        stmt.member.run(profileId, id, 'union', ref, resolver.resolveType(ref), order++);
      }
      for (const [i, member] of elements(child).entries()) {
        if (context.nestedAnonymous) {
          // Pass 1 only synthesises one level of anonymous member, so a union
          // inside a union would resolve against the wrong owner. Fail rather
          // than write an edge pointing somewhere plausible and wrong.
          throw new Error(`${schema.path}: anonymous union nested inside an anonymous union`);
        }
        const anonymousName = `${context.ownerName}#${i + 1}`;
        const anonymousId = context.ids.get(
          key(schema.vocabulary, 'simpleType', anonymousName, context.ownerKey),
        );
        const ref = `${schema.vocabulary}:${anonymousName}`;
        stmt.member.run(profileId, id, 'union', ref, anonymousId, order++);
        // Recurse so the anonymous member's own base, facets and enumerations
        // are recorded against it — that is where the value space actually is.
        writeSimpleType(
          {...context, ownerId: anonymousId, nestedAnonymous: true},
          member,
          anonymousId,
        );
      }
      continue;
    }

    if (name === 'list') {
      const ref = schema.canonical(child.attributes.itemType);
      stmt.member.run(profileId, id, 'list', ref, resolver.resolveType(ref), 0);
      continue;
    }

    throw new Error(`${schema.path}: unexpected xsd:${name} inside a simpleType`);
  }
}
