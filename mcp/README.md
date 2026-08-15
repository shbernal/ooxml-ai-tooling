# mcp-server-ooxml

An MCP server for the **ECMA-376 (Office Open XML) schema**. Local, offline, no
account, no network call.

Answers what is legal in a `.docx`, `.xlsx` or `.pptx`: what may go inside an
element and in what order, what attributes it takes, what values those
attributes accept, which namespace to write, and what changes between the
Transitional and Strict profiles.

> **Pre-release.** Nothing is published yet and the tool surface may change.

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

Node 24 or newer. The schema database ships inside the package — there is no
first-run download, no data directory, and nothing to configure.

## Tools

| Tool | Answers |
|---|---|
| `ooxml_element` | What a name is: kind, type, namespace, which profiles it exists in |
| `ooxml_children` | Legal children **in schema order**, with cardinality and the compositor tree |
| `ooxml_attributes` | Attributes, including inherited ones and expanded attributeGroups |
| `ooxml_values` | The legal value space: facets, patterns, bounds, union members |
| `ooxml_enum` | Enumeration values of a simple type |
| `ooxml_type` | A complexType/simpleType: what it derives from and its shape |
| `ooxml_search` | Find symbols by name substring |
| `ooxml_namespace` | Namespace ↔ prefix ↔ vocabulary, both directions |
| `ooxml_diff_profiles` | What Transitional adds to Strict for one symbol |
| `ooxml_explain` | Resolve a validation diagnostic into "here is what would be legal" |

Three things the tools do that a naive schema browser does not, because each is
otherwise a confidently wrong answer:

- **Group references are expanded.** Many DrawingML types have no direct
  children at all — their entire content is a group reference — so a tool that
  reads only the direct edges reports them as accepting nothing.
- **Inheritance is resolved in the right order.** For an extended type the base
  type's children come *first*, and every entry names the type that contributed
  it.
- **An ambiguous name returns every meaning.** OOXML declares element names
  locally, so `w:tblPr` genuinely has two different content models depending on
  where it appears. Both come back, each labelled with where it applies.

## Profiles

Answers default to **Transitional**, which is what Word, Excel and PowerPoint
actually write. Strict is the ISO profile: the same vocabulary under *different
namespace URIs*, with VML removed entirely. Pass `profile: "strict"` when a
document declares `purl.oclc.org/ooxml/…` namespaces.

## What this is not

- **It does not validate files.** It never opens your document. For validation,
  see `ooxml-validate`, which wraps Microsoft's `OpenXmlValidator`.
  `ooxml_explain` *consumes* a diagnostic from such a report; it does not
  produce one, and nothing needs to be installed for it.
- **It has no specification prose and no semantic search.** No PDFs, no
  embeddings — it answers from the XSD schema graph only. If you want to search
  the specification text, <https://ooxml.dev> does that, and this project
  deliberately does not compete with it.
- **It has no behaviour notes.** The schema is the standard; implementations
  diverge from it, and those divergences are not modelled here.

## Prefer a CLI?

The same core ships as an agent skill (`ooxml-lookup`) for agents that have a
shell, in the same repository. It additionally exposes read-only SQL against
the graph, which the MCP surface does not.

## Credit

[`superdoc-dev/ooxml-dev`](https://github.com/superdoc-dev/ooxml-dev) is prior
art and its data model informed the shape of this one. No code is shared; this
is not a fork or a drop-in replacement. Its MCP server is a client of a hosted
service, which is the gap this fills.

The vendored ECMA-376 schemas are redistributed unmodified under Ecma
International's free-availability terms and Microsoft's Open Specification
Promise. This does not affect the MIT license on this package's own code.

## License

MIT © shbernal
