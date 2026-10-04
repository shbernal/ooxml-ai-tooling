# mcp-server-ooxml

An MCP server for the ECMA-376 (Office Open XML) schema. It runs locally and
offline, with no account.

It answers what is legal in a `.docx`, `.xlsx` or `.pptx`: what may go inside an
element and in what order, what attributes it takes, what values those
attributes accept, which namespace to write, and what changes between the
Transitional and Strict profiles.

> **Early release (`0.0.x`).** The tools may change between versions without a
> deprecation period. Pin a version if that matters to you.

## Install

```jsonc
// claude_desktop_config.json, or any MCP client's server config
{
  "mcpServers": {
    "ooxml": {
      "command": "npx",
      "args": ["-y", "mcp-server-ooxml"]
    }
  }
}
```

Needs Node 24 or newer. The schema database ships inside the package, so there
is no first-run download and nothing to configure.

## Tools

| Tool | Answers |
|---|---|
| `ooxml_element` | What a name is: kind, type, namespace, which profiles it exists in |
| `ooxml_children` | Legal children in schema order, with cardinality and the compositor tree |
| `ooxml_attributes` | Attributes, including inherited ones and expanded attributeGroups |
| `ooxml_values` | The legal value space: facets, patterns, bounds, union members |
| `ooxml_enum` | Enumeration values of a simple type |
| `ooxml_type` | A complexType/simpleType: what it derives from and its shape |
| `ooxml_search` | Find symbols by name substring |
| `ooxml_namespace` | Namespace, prefix and vocabulary, looked up from any of the three |
| `ooxml_diff_profiles` | What Transitional adds to Strict for one symbol |
| `ooxml_explain` | What would have been legal where a validation diagnostic points, given as JSON or pasted text |

Every tool declares an output schema and returns its answer as
`structuredContent`, with the same JSON in a text block for clients that do
not read structured results. A miss is an answer, not an error: `found: false`
with a `reason` that says which kind of miss it is.

A naive reading of the schemas gets three things wrong. The tools handle each:

- **Group references are expanded.** Many DrawingML types have no direct
  children. Their whole content is a group reference, so a tool that reads only
  direct edges says they accept nothing.
- **Inheritance resolves in the right order.** For an extended type the base
  type's children come first, and every entry names the type that contributed
  it.
- **An ambiguous name returns every meaning.** OOXML declares element names
  locally, so `w:tblPr` has two content models depending on where it appears.
  Both come back, each labelled with where it applies. The same goes across
  vocabularies. Bare `ST_Direction` is `ltr|rtl` in wml, `horz|vert` in pml and
  `norm|rev` in dml-diagram. Picking one would be wrong two times in three.

## Prefixes

Write a name however you have it: `w:tblPr`, `wml:tblPr`, Clark notation
`{uri}tblPr`, or bare.

The schemas do not bind a prefix to every namespace. Nothing binds one to
spreadsheetml or to charts. The tools accept `x` and `c` because that is what
real files use, and `ooxml_namespace` lists them under `aliases` with a
citation. The standard's own answer, `prefix: null`, stays as it is.

Answers come back in the canonical spelling, so `x:worksheet` resolves and
replies `sml:worksheet`. `x` is also the prefix for VML's excel namespace, and
printing both as `x:` would make two namespaces look like one.

The package parts work the same way, in both profiles. `cp:` covers core
properties and `mdssi:` covers signatures. `[Content_Types].xml` and `.rels`
use the default namespace, so you reach them by bare name or vocabulary key.
Their `dc:` and `dcterms:` children are Dublin Core, which ECMA-376 references
without defining. Those come back untyped, with an `external_source` that says
where they are defined.

This is why `ooxml_explain` takes a spreadsheet diagnostic exactly as the
validator emits it, `/x:worksheet[1]/x:pageSetup[1]`, with no rewriting.

## Profiles

Answers default to Transitional, which is what Word, Excel and PowerPoint
write. Strict is the ISO profile: the same vocabulary under different namespace
URIs, with VML removed. Pass `profile: "strict"` when a document declares
`purl.oclc.org/ooxml/…` namespaces.

## What this is not

- **It does not validate files.** It never opens your document. For
  validation, see `ooxml-validate`, which wraps Microsoft's `OpenXmlValidator`.
  `ooxml_explain` reads a diagnostic from such a report. It does not produce
  one, and you do not need to install anything for it.
- **It has no specification prose and no semantic search.** It answers from the
  XSD schema graph only. To search the specification text, use
  <https://ooxml.dev>.
- **It has no behaviour notes.** The schema is the standard. Implementations
  diverge from it, and this server does not model how.

## Prefer a CLI?

The same core ships as an agent skill, `ooxml-lookup`, for agents that have a
shell. It lives in the same repository and also offers read-only SQL over the
graph, which the MCP server does not.

## Credit

[`superdoc-dev/ooxml-dev`](https://github.com/superdoc-dev/ooxml-dev) is prior
art, and its data model informed the shape of this one. No code is shared, and
this is not a fork or a drop-in replacement. Its MCP server is a client of a
hosted service. This one runs entirely on your machine.

## License

MIT © shbernal
