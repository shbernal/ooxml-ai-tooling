-- The ECMA-376 schema graph.
--
-- Adapted in *shape* from superdoc-dev/ooxml-dev's db/schema.sql, which got the
-- hard part right. Independent implementation — no code is shared. Everything a
-- hosted service needs and a local file does not is gone: the vector column and
-- its index, spec prose, usage events, migrations, SERIAL, JSONB, and every
-- timestamp (see "Determinism" below).
--
-- ============================================================================
-- Identity: the vocabulary is the key, namespace URIs are per-profile aliases
-- ============================================================================
--
-- This is the single most important decision in the file, so it is the first
-- comment in it.
--
-- Transitional and Strict describe the *same* vocabulary under *different*
-- namespace URIs:
--
--     http://schemas.openxmlformats.org/wordprocessingml/2006/main   (transitional)
--     http://purl.oclc.org/ooxml/wordprocessingml/main               (strict)
--
-- Key symbols on the URI and every symbol doubles, the two profiles stop being
-- comparable, and "is this element in Strict too?" becomes unanswerable. Key on
-- the vocabulary and profile membership is a join — which is what makes
-- diff_profiles fall out for free rather than needing its own ingest.
--
-- So `symbols` is keyed by (vocabulary_id, kind, local_name, parent_symbol_id)
-- and carries no profile. The URI lives on `namespaces`, one row per
-- (vocabulary, profile). Everything genuinely profile-dependent — every edge —
-- carries `profile_id`.
--
-- That model asserts the profiles share symbol identity and differ only in
-- edges and URIs. It was verified before this file was written, not assumed:
-- across all 2,118 top-level symbols the two archives share, `@type` and
-- `@substitutionGroup` agree in every single case, and Strict contains no
-- symbol that Transitional lacks. Strict is a subset.
--
-- ============================================================================
-- Determinism
-- ============================================================================
--
-- The built database is committed, so a rebuild has to reproduce it — otherwise
-- the committed binary is an assertion rather than a derived artifact.
--
-- Nothing here may depend on wall-clock time, filesystem order, or insertion
-- order. There are no `created_at` columns and no timestamps of any kind.
-- Integer ids are assigned by inserting in a sorted order, never by discovery
-- order, so a rebuild lands on the same ids. `build/dump.mjs` serialises the
-- whole file to canonical text and CI compares its hash.
--
-- ============================================================================
-- Conventions
-- ============================================================================
--
-- * `min_occurs` / `max_occurs` are integers, with **-1 meaning `unbounded`**.
--   Storing the string 'unbounded' would make every numeric comparison a
--   special case at the call site.
-- * `order_index` is 0-based document order. It is what makes "what may go
--   inside this element, in order" answerable, so it is never optional.
-- * `type_ref` and friends hold a **canonical** QName: `vocabularyKey:localName`
--   for OOXML types (`wml:CT_P`), `xsd:localName` for built-ins (`xsd:string`).
--   Deliberately *not* Clark notation `{uri}local` — the URI is profile-scoped
--   and these columns are not, so a URI here would make Transitional and Strict
--   disagree on a column that must not vary. `type_symbol_id` is the resolved
--   id, NULL for built-ins.

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------

CREATE TABLE profiles (
  id    INTEGER PRIMARY KEY,
  key   TEXT NOT NULL UNIQUE,   -- 'transitional' | 'strict'
  label TEXT NOT NULL
);

-- One row per schema *file stem*, shared across profiles: 'wml', 'sml', 'pml',
-- 'dml-main', 'shared-commonSimpleTypes', … Both archives use the same
-- filenames, which is what makes this stable across profiles.
CREATE TABLE vocabularies (
  id  INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE
);

-- The profile-scoped alias. `uri` is globally unique because no two vocabularies
-- share a target namespace in either archive (the ingest asserts this).
CREATE TABLE namespaces (
  id               INTEGER PRIMARY KEY,
  vocabulary_id    INTEGER NOT NULL REFERENCES vocabularies(id),
  profile_id       INTEGER NOT NULL REFERENCES profiles(id),
  uri              TEXT NOT NULL UNIQUE,
  preferred_prefix TEXT,        -- the prefix the schema binds to its own target namespace
  UNIQUE (vocabulary_id, profile_id)
);

-- Elements, attributes, and the named definitions they refer to.
--
-- `parent_symbol_id` is 0 for a top-level (global) declaration and otherwise the
-- owning complexType or group. It exists because **local element declarations
-- are not the same symbol as a global one of the same name**: `w:p` declared
-- inside two different complexTypes is two declarations, and neither is the
-- top-level `w:p`. In this corpus that is the common case, not an edge case —
-- wml.xsd has 14 global elements and roughly 1,400 local ones.
--
-- `parent_symbol_id` is `NOT NULL DEFAULT 0` rather than nullable because
-- SQLite has no `UNIQUE NULLS NOT DISTINCT`: with NULL for "top-level", the
-- UNIQUE below would permit unlimited duplicate global symbols, since NULL
-- never equals NULL. 0 is a sentinel, not a foreign key. Do not "fix" this to
-- NULL for tidiness.
-- `is_anonymous` marks a synthesised symbol for an unnamed inline type. XSD
-- allows a union member to be written inline instead of named, and ECMA-376
-- does it exactly once: sml's `ST_TextRotation` is a union of "0–180" and
-- "the literal 255", both anonymous. Dropping them would leave that type
-- reporting a union with no members — a confidently wrong answer about a real
-- spreadsheet attribute.
--
-- Their `local_name` is `<owner>#<n>`, which cannot collide with a real symbol
-- because `#` is not legal in an NCName. Queries that search by name must
-- filter `is_anonymous = 0`; queries that resolve a union member must not.
CREATE TABLE symbols (
  id               INTEGER PRIMARY KEY,
  vocabulary_id    INTEGER NOT NULL REFERENCES vocabularies(id),
  local_name       TEXT NOT NULL,
  kind             TEXT NOT NULL
                     CHECK (kind IN ('element', 'attribute', 'complexType',
                                     'simpleType', 'group', 'attributeGroup')),
  parent_symbol_id INTEGER NOT NULL DEFAULT 0,
  type_ref         TEXT,        -- canonical QName, NULL for definitions
  type_symbol_id   INTEGER REFERENCES symbols(id),
  is_anonymous     INTEGER NOT NULL DEFAULT 0 CHECK (is_anonymous IN (0, 1)),
  UNIQUE (vocabulary_id, kind, local_name, parent_symbol_id)
);

-- Which profiles a symbol appears in. A symbol present in both has two rows;
-- this is the table that answers "is this Transitional-only?".
CREATE TABLE symbol_profiles (
  symbol_id  INTEGER NOT NULL REFERENCES symbols(id),
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  PRIMARY KEY (symbol_id, profile_id)
) WITHOUT ROWID;

-- The content-model tree: xsd:sequence / xsd:choice / xsd:all.
--
-- Exactly one of `parent_symbol_id` and `parent_compositor_id` is set — a
-- compositor either sits directly under a type/group definition or nests inside
-- another compositor. The ingest asserts this; a CHECK enforces it here too.
CREATE TABLE compositors (
  id                   INTEGER PRIMARY KEY,
  profile_id           INTEGER NOT NULL REFERENCES profiles(id),
  kind                 TEXT NOT NULL CHECK (kind IN ('sequence', 'choice', 'all')),
  parent_symbol_id     INTEGER REFERENCES symbols(id),
  parent_compositor_id INTEGER REFERENCES compositors(id),
  min_occurs           INTEGER NOT NULL,
  max_occurs           INTEGER NOT NULL,
  order_index          INTEGER NOT NULL,
  CHECK ((parent_symbol_id IS NULL) <> (parent_compositor_id IS NULL))
);

-- An element that may appear inside a compositor.
--
-- `child_symbol_id` is NULL exactly when `is_wildcard` is 1 — an `xsd:any`, the
-- mc:AlternateContent extension point. A type that accepts a wildcard and one
-- that does not are materially different, so wildcards are recorded rather than
-- dropped; `wildcard_namespace` and `wildcard_process_contents` carry the
-- payload that says how open the hole actually is.
--
-- The occurs recorded here are the **reference site's**, which is the only
-- correct choice: `<xsd:element ref="w:p" maxOccurs="unbounded"/>` says nothing
-- about how `w:p` is declared elsewhere.
CREATE TABLE child_edges (
  id                        INTEGER PRIMARY KEY,
  profile_id                INTEGER NOT NULL REFERENCES profiles(id),
  parent_symbol_id          INTEGER NOT NULL REFERENCES symbols(id),
  compositor_id             INTEGER NOT NULL REFERENCES compositors(id),
  child_symbol_id           INTEGER REFERENCES symbols(id),
  min_occurs                INTEGER NOT NULL,
  max_occurs                INTEGER NOT NULL,
  order_index               INTEGER NOT NULL,
  is_wildcard               INTEGER NOT NULL DEFAULT 0 CHECK (is_wildcard IN (0, 1)),
  wildcard_namespace        TEXT,
  wildcard_process_contents TEXT,
  CHECK ((child_symbol_id IS NULL) = (is_wildcard = 1))
);

-- `xsd:group ref` and `xsd:attributeGroup ref`.
--
-- The cardinality here is the **ref site's**, not the group definition's:
-- `<xsd:group ref="EG_X" maxOccurs="unbounded"/>` wrapping a sequence is a
-- different content model from the group's own min/max, and conflating them
-- silently produces a plausible, wrong answer. attributeGroup refs carry no
-- cardinality and store 1/1.
--
-- `compositor_id` is NULL for attributeGroup refs and for group refs that hang
-- directly off a type definition rather than inside a compositor.
CREATE TABLE group_edges (
  id               INTEGER PRIMARY KEY,
  profile_id       INTEGER NOT NULL REFERENCES profiles(id),
  parent_symbol_id INTEGER NOT NULL REFERENCES symbols(id),
  compositor_id    INTEGER REFERENCES compositors(id),
  group_symbol_id  INTEGER NOT NULL REFERENCES symbols(id),
  ref_kind         TEXT NOT NULL CHECK (ref_kind IN ('group', 'attributeGroup')),
  min_occurs       INTEGER NOT NULL,
  max_occurs       INTEGER NOT NULL,
  order_index      INTEGER NOT NULL
);

-- An attribute declared on, or referenced by, a type or attributeGroup.
-- `attr_symbol_id` is set when the attribute is a global declaration reached by
-- `ref`, NULL when it is declared inline (the common case).
--
-- Inline attributes are edges rather than symbols, while local *elements* are
-- symbols. The asymmetry is deliberate: an element is a node other things point
-- at, an attribute is a leaf property of exactly one owner, so giving it an
-- identity would buy nothing and cost a join.
--
-- `is_qualified` says whether the attribute is written with a namespace prefix
-- (`w:val`) or bare (`val`). It comes from the schema's `attributeFormDefault`
-- — which genuinely varies across these files, unlike `elementFormDefault`,
-- which is `qualified` in all 47 — overridden by a per-attribute `form`. It is
-- recorded because getting it wrong produces a document that looks right and
-- does not load.
CREATE TABLE attr_edges (
  id             INTEGER PRIMARY KEY,
  profile_id     INTEGER NOT NULL REFERENCES profiles(id),
  symbol_id      INTEGER NOT NULL REFERENCES symbols(id),
  attr_symbol_id INTEGER REFERENCES symbols(id),
  local_name     TEXT NOT NULL,
  attr_use       TEXT NOT NULL CHECK (attr_use IN ('optional', 'required', 'prohibited')),
  is_qualified   INTEGER NOT NULL CHECK (is_qualified IN (0, 1)),
  default_value  TEXT,
  fixed_value    TEXT,
  type_ref       TEXT,
  type_symbol_id INTEGER REFERENCES symbols(id),
  order_index    INTEGER NOT NULL
);

-- xsd:extension / xsd:restriction.
--
-- `base_symbol_id` is NULL when the base is a built-in (`xsd:string`), in which
-- case `base_type_ref` still names it. `content_model` records which shell the
-- derivation appeared in, because it changes what the derivation means:
-- complexContent extension prepends the base's particle to the derived one,
-- simpleContent extension adds attributes to a simple value, and a simpleType
-- restriction narrows a value space.
--
-- **The particle order matters and is the hazard this table exists to serve.**
-- For an extended type the legal child order is base children first, then the
-- derived sequence. Resolving that is a query concern (core/graph.mjs), but it
-- is only possible because the relation is recorded rather than flattened here.
CREATE TABLE inheritance_edges (
  id             INTEGER PRIMARY KEY,
  profile_id     INTEGER NOT NULL REFERENCES profiles(id),
  symbol_id      INTEGER NOT NULL REFERENCES symbols(id),
  base_symbol_id INTEGER REFERENCES symbols(id),
  base_type_ref  TEXT NOT NULL,
  relation       TEXT NOT NULL CHECK (relation IN ('extension', 'restriction')),
  content_model  TEXT NOT NULL
                   CHECK (content_model IN ('complexContent', 'simpleContent', 'simpleType'))
);

-- xsd:enumeration values of a simpleType restriction.
--
-- There is deliberately no `annotation` column. The plan called for one, but
-- **the ECMA-376 XSDs contain no xsd:annotation or xsd:documentation elements
-- at all** — zero, in both profiles. A column that is structurally always NULL
-- reads to a later maintainer as data that got lost in ingest. Instead the
-- ingest asserts the count is zero and fails if a future edition adds any, at
-- which point adding the column is a deliberate act.
CREATE TABLE enums (
  id          INTEGER PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id),
  symbol_id   INTEGER NOT NULL REFERENCES symbols(id),
  value       TEXT NOT NULL,
  order_index INTEGER NOT NULL
);

-- The legal value space of a simpleType: pattern, minInclusive, maxInclusive,
-- minExclusive, maxExclusive, length, minLength, maxLength.
--
-- Not in the incumbent's model, and the reason it is here: without facets,
-- ST_Percentage, ST_UniversalMeasure, ST_TwipsMeasure and the whole numeric
-- family answer "it is a restriction of xsd:string" and nothing more. An agent
-- *writing* OOXML needs the bounds and the pattern, not just the base type.
CREATE TABLE simple_type_facets (
  id          INTEGER PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id),
  symbol_id   INTEGER NOT NULL REFERENCES symbols(id),
  facet       TEXT NOT NULL,
  value       TEXT NOT NULL,
  order_index INTEGER NOT NULL
);

-- xsd:union memberTypes and xsd:list itemType, distinguished by `member_kind`.
--
-- OOXML leans on unions for the measure types — ST_TwipsMeasure is a union of
-- ST_UnsignedDecimalNumber and ST_PositiveUniversalMeasure — so dropping this
-- makes those types unresolvable, which is most of the interesting ones.
--
-- It is also where the clearest Transitional/Strict difference lives:
-- ST_OnOff is `union of (xsd:boolean, ST_OnOff1)` in Transitional and
-- `union of (xsd:boolean)` in Strict. Same symbol, same type_ref, different
-- edges — exactly the shape the profile model predicts.
CREATE TABLE union_members (
  id               INTEGER PRIMARY KEY,
  profile_id       INTEGER NOT NULL REFERENCES profiles(id),
  symbol_id        INTEGER NOT NULL REFERENCES symbols(id),
  member_kind      TEXT NOT NULL CHECK (member_kind IN ('union', 'list')),
  member_type_ref  TEXT NOT NULL,
  member_symbol_id INTEGER REFERENCES symbols(id),
  order_index      INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
-- Indexes. Every one of these serves a query in core/, not a hypothetical.

-- `element` / `type` / `search`: look a symbol up by name. NOCASE because the
-- tools accept `ct_p` for `CT_P`, and because a scan of 30k rows per lookup is
-- exactly the cost the database exists to avoid.
CREATE INDEX idx_symbols_name        ON symbols (local_name COLLATE NOCASE);
CREATE INDEX idx_symbols_vocab_kind  ON symbols (vocabulary_id, kind);
CREATE INDEX idx_symbols_parent      ON symbols (parent_symbol_id);
CREATE INDEX idx_symbols_type        ON symbols (type_symbol_id);

-- `children`: walk down from a type.
CREATE INDEX idx_child_parent        ON child_edges (parent_symbol_id, profile_id);
CREATE INDEX idx_child_compositor    ON child_edges (compositor_id);
CREATE INDEX idx_child_target        ON child_edges (child_symbol_id);
CREATE INDEX idx_compositors_symbol  ON compositors (parent_symbol_id, profile_id);
CREATE INDEX idx_compositors_nested  ON compositors (parent_compositor_id);
CREATE INDEX idx_group_edges_parent  ON group_edges (parent_symbol_id, profile_id);
CREATE INDEX idx_group_edges_target  ON group_edges (group_symbol_id);

-- `attributes` / `values`.
CREATE INDEX idx_attr_symbol         ON attr_edges (symbol_id, profile_id);
CREATE INDEX idx_enums_symbol        ON enums (symbol_id, profile_id);
CREATE INDEX idx_facets_symbol       ON simple_type_facets (symbol_id, profile_id);
CREATE INDEX idx_union_symbol        ON union_members (symbol_id, profile_id);

-- Inheritance, in both directions: `children` resolves bases upward, and
-- "what extends this?" reads downward.
CREATE INDEX idx_inherit_symbol      ON inheritance_edges (symbol_id, profile_id);
CREATE INDEX idx_inherit_base        ON inheritance_edges (base_symbol_id);
