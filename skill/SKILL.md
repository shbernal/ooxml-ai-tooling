---
name: ooxml-lookup
description: >-
  Query the ECMA-376 (Office Open XML) schema offline to find out what is legal
  in a .docx, .xlsx or .pptx file. Use when writing, reading or debugging OOXML
  markup by hand: what may go inside an element and in what order, what
  attributes it takes, what values those attributes accept, which namespace or
  prefix to write, and how the Transitional and Strict profiles differ. Also
  turns a schema validation error into what would have been legal at that
  position. Covers wordprocessingml, spreadsheetml, presentationml, drawingml,
  vml and the package parts ([Content_Types].xml, .rels, docProps/core.xml).
  Does NOT validate files (that is ooxml-validate) and does not generate
  documents. It answers from the XSD schema graph only, with no specification
  prose, behaviour notes or semantic search.
---

# ooxml-lookup

The ECMA-376 schema as a local SQLite graph, queried through one CLI. It needs
no network, no account and no install. Run `node scripts/ooxml.mjs` from a bare
checkout.

Every command prints JSON on stdout and nothing else.

## The loop

Most questions are one of these three, in this order.

**1. What is this thing?**

```bash
node scripts/ooxml.mjs element w:tblPr
```

Returns every declaration of the name. More than one is normal. OOXML declares
element names locally, inside types, so `w:tblPr` is `CT_TblPr` inside
`w:CT_Tbl` and `CT_TblPrBase` in three other places. The `scope.declared_in`
field tells you which is which.

**2. What is legal here?**

```bash
node scripts/ooxml.mjs children w:CT_PPr      # what may go inside, in order
node scripts/ooxml.mjs attributes w:CT_Ind    # what attributes it takes
node scripts/ooxml.mjs values s:ST_TwipsMeasure   # what values are legal
```

`children` returns the same content model twice. `order` is a flat list in
schema order, and it answers "what goes here". `tree` is the nested
sequence/choice/all structure with cardinalities. Read it when the difference
between a choice and a sequence matters.

`min`/`max` of `-1` means unbounded.

**3. What does this validation error mean?**

```bash
node scripts/ooxml.mjs explain '{"id":"Sch_UndeclaredAttribute",
  "description":"The '\''bogus'\'' attribute is not declared.",
  "xpath":"/w:document[1]/w:body[1]/w:p[1]/w:pPr[1]/w:ind[1]"}'
```

Takes one diagnostic from an `ooxml-validate` report and says what would have
been legal there. You can also pass the whole report, and it uses the first
diagnostic. The xpath matters. When a name has several content models, the
ancestors in the xpath pick the right one.

If all you have is a pasted message, pass the text as it is:

```bash
node scripts/ooxml.mjs explain "Sch_UndeclaredAttribute: The 'bogus' attribute
  is not declared. at /w:document[1]/w:body[1]/w:p[1]/w:pPr[1]/w:ind[1]"
```

It picks out the id, the xpath and any quoted names. Without an xpath there is
no position to answer for, so include it if you have it.

An id it does not recognise still gets an answer. You get what the schema
allows at that position.

## Worked example

You are hand-writing a paragraph and want to indent it.

```bash
$ node scripts/ooxml.mjs attributes w:CT_Ind --compact
{"query":"w:CT_Ind","profile":"transitional","found":true,"type":"w:CT_Ind",
 "truncated":false,"count":12,"attributes":[{"name":"end","qualified":true,"use":"optional",
 "type":{"qname":"w:ST_SignedTwipsMeasure",...
```

`firstLine` is typed `s:ST_TwipsMeasure`. What can you write in it?

```bash
$ node scripts/ooxml.mjs values s:ST_TwipsMeasure --compact
{"type":"s:ST_TwipsMeasure","one_of":[
  {"type":"s:ST_UnsignedDecimalNumber","base":"xsd:unsignedLong"},
  {"type":"s:ST_PositiveUniversalMeasure","base":"s:ST_UniversalMeasure",
   "facets":{"pattern":"[0-9]+(\\.[0-9]+)?(mm|cm|in|pt|pc|pi)"}}]}
```

So `w:firstLine="720"` (twips) or `w:firstLine="0.5in"`. The unit suffixes are
a closed set of six.

## Things that will bite you

- **Check the profile.** Answers default to Transitional, which is what Word,
  Excel and PowerPoint write. Strict uses different namespace URIs for the same
  vocabulary and drops VML. If a document declares `purl.oclc.org/ooxml/...`
  namespaces, pass `--profile strict`. `diff` shows what changes for one
  symbol.
- **A name is not an identity.** `ST_Percentage` is a pattern-restricted string
  in `shared-commonSimpleTypes` and a union in `dml-main`. `ST_Direction` is
  `ltr|rtl` in wml, `horz|vert` in pml and `norm|rev` in dml-diagram. A bare
  name like that comes back with `ambiguous:true` and a `variants` array, so
  check for `variants` before you read a result. Qualify names when you can:
  `s:ST_Percentage`, not `ST_Percentage`.
- **An empty answer is often correct.** `attributes w:CT_Tbl` returns nothing
  because wml puts table properties in child elements. `found:true` with
  `count:0` means "none". It does not mean the lookup failed.
- **`search` matches substrings.** It finds `tblPr`. It will not find "how do I
  make a table border".

## Names

Write a name however you have it: `w:tblPr`, `wml:tblPr`,
`{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tblPr`, or bare
`tblPr`. A bare name that matches several vocabularies returns all of them.

Prefixes are the conventional ones (`w`, `a`, `p`, `s`, `m`, `r`, `v`, `x`,
`c`, `o`, `xdr`, `wp` and so on). Run `namespace <uri>` to go from a URI to a
prefix, or `namespace <prefix>` to see which vocabulary a prefix reaches.

No schema binds `x` to spreadsheetml or `c` to charts. The CLI accepts them
because that is what real files use. `namespace` lists them under `aliases`
with a citation and leaves `prefix` null, as the standard does.

Answers come back in the canonical spelling, so `element x:worksheet` replies
`sml:worksheet`. `x` is also the prefix for VML's excel namespace, and printing
both as `x:` would make two namespaces look like one. The lookup tries both and
returns the one that has the name.

The package parts work the same way in both profiles, because packaging does
not change between them. `cp:coreProperties` and `mdssi:` resolve as cited
aliases. `[Content_Types].xml` and `.rels` use the default namespace and have
no prefix. Use the bare name (`Types`, `Relationship`) or the vocabulary key
(`opc-contentTypes:Override`).

The `dc:` and `dcterms:` children of `cp:coreProperties` are Dublin Core.
ECMA-376 references them but does not define them. They answer with `type:null`
and an `external_source` that names where they are defined. Read that `null` as
"not recorded here", not as "untyped".

An ambiguous name returns `ambiguous:true` and a `variants` array with one entry
per meaning. The `message` says which kind of ambiguity it is:

- Several vocabularies share the local name. Qualify it and you get one answer.
- One vocabulary declares the name in several places, like `w:tblPr`. The
  answer depends on the parent, and each variant carries
  `applies_when_declared_in`.

## Direct SQL, when the subcommands do not fit

The database ships with the skill and the connection is read-only:

```bash
node scripts/ooxml.mjs sql "SELECT local_name FROM symbols
  WHERE kind='complexType' AND local_name LIKE 'CT_Tbl%'"
```

Tables: `profiles`, `vocabularies`, `namespaces`, `prefix_aliases`, `symbols`,
`symbol_profiles`, `compositors`, `child_edges`, `group_edges`, `attr_edges`,
`inheritance_edges`, `enums`, `simple_type_facets`, `union_members`.

Two things to know before writing a join:

- Symbols are keyed on the vocabulary, not the namespace URI, because the two
  profiles are the same vocabulary under different URIs. `symbols` has no
  profile column. Every edge table has one.
- `symbols.parent_symbol_id` is `0` for a global declaration, not NULL.

A result holds at most `--limit` rows (default and maximum 200). `truncated:
true` means there were more, so page with `LIMIT … OFFSET …` in the query.

Use the subcommands where they fit. They resolve inheritance and expand group
references. A raw `child_edges` query does neither.

## What this does not do

- **Validate a file.** That is `ooxml-validate`, a separate tool. This one says
  what the schema permits and never opens your document.
- **Explain what Word actually does.** It answers from the standard, and
  implementations diverge from it. There are no behaviour notes.
- **Search the specification text.** It has no prose, PDFs or embeddings. To
  read the specification itself, use <https://ooxml.dev>.
