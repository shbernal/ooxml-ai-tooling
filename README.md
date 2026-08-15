# ooxml-ai-tooling

The ECMA-376 (Office Open XML) schema, as structured data an AI agent can query
— **locally, offline, with no account and no network call**.

Two surfaces over one core:

- **`ooxml-lookup`** — an agent skill: a CLI for any agent with a shell.
- **`mcp-server-ooxml`** — an MCP server over stdio, for MCP clients.

> **Status: pre-release.** Nothing is published yet and everything is subject to
> change.

## What it answers

You are hand-writing a paragraph in a `.docx` and want to indent it. What
attributes does `w:ind` take, and what may you write in them?

```console
$ ooxml attributes w:CT_Ind
{"type":"w:CT_Ind","count":12,"attributes":[
  {"name":"firstLine","qualified":true,"use":"optional",
   "type":{"qname":"s:ST_TwipsMeasure","kind":"simpleType"}}, …]}

$ ooxml values s:ST_TwipsMeasure
{"type":"s:ST_TwipsMeasure","one_of":[
  {"type":"s:ST_UnsignedDecimalNumber","base":"xsd:unsignedLong"},
  {"type":"s:ST_PositiveUniversalMeasure",
   "facets":{"pattern":"[0-9]+(\\.[0-9]+)?(mm|cm|in|pt|pc|pi)"}}]}
```

So `w:firstLine="720"` or `w:firstLine="0.5in"` — and the unit suffixes are a
closed set of six.

The other questions it answers: what may go inside an element **and in what
order**, which namespace or prefix to write, what changes between the
Transitional and Strict profiles, and — given a validation error — what *would*
have been legal at that position.

## Which surface do I want?

| Your situation | Use | Why |
|---|---|---|
| An agent with a shell (Claude Code, Codex, Cursor's terminal) | **the skill** | No install, no config. It also exposes read-only SQL over the graph, which the MCP surface does not. |
| An MCP client (Claude Desktop, an editor's MCP integration) | **the MCP server** | `npx -y mcp-server-ooxml`. The database ships in the package. |
| A cloud session with no filesystem and no MCP | **neither** | Both surfaces need a local process. There is nothing to be done about this and pretending otherwise would waste your time. |

Both answer identically — they are thin adapters over one core, kept
byte-identical by `make check-vendor`.

## Why this exists

[`superdoc-dev/ooxml-dev`](https://github.com/superdoc-dev/ooxml-dev) is the
incumbent and good prior art — its data model informed the shape of ours. But
its MCP server is a **thin client of a hosted service**: `api.ooxml.dev/mcp`,
backed by Postgres + pgvector behind an authentication requirement, with usage
metering. There is no local mode, and its ingest cannot produce one without
Postgres, pgvector and an embedding model.

This is not a clone of it. It is the half that **can** be fully local,
deterministic and offline — the XSD graph — built from committed schemas into a
committed SQLite database, queried by a core with zero runtime dependencies.

## Not this project

Being clear about the gaps is more useful than pretending they are not there.

- **Validating a file** — that is [`ooxml-validate`](https://github.com/shbernal/ooxml-validate),
  a sibling project that wraps Microsoft's `OpenXmlValidator`. This repo answers
  *what is legal*; it never opens your document, and it will never grow a second
  validation path. The `explain` tool *consumes* a diagnostic from a validator
  report and turns it into a schema answer — nothing is imported and nothing
  needs installing for that.
- **Reading the specification text** — no prose, no PDFs, no embeddings, no
  semantic search. <https://ooxml.dev> does that and does it well. If your
  question is "what does the spec say about X" rather than "what is structurally
  legal here", go there; it is a genuine recommendation, not a footnote.
- **What Word actually does** — the schema is the standard, and implementations
  diverge from it. Those divergences are not modelled here, deliberately: the
  readily available corpus is xlsx-shaped and would bias a tool that has to
  serve wordprocessingml, spreadsheetml, presentationml and drawingml equally.

## How it is built

`schemas/` holds 51 ECMA-376 XSDs vendored verbatim, with their archive
checksums recorded in `schemas/PROVENANCE.md`. `build/` turns them into a
2.2 MB SQLite graph — 5,606 symbols, both profiles — and the build is
deterministic: CI rebuilds it from the schemas and compares a canonical dump, so
the committed database is a derived artifact rather than an assertion.

The graph keys symbols on the **vocabulary**, not the namespace URI. That is the
decision everything else rests on: Transitional and Strict are the same
vocabulary under different URIs, so keying on the URI would double every symbol
and make "is this in Strict too?" unanswerable. Keyed on the vocabulary, it is a
join.

```
core/     the implementation and its tests — the only real source
schemas/  vendored ECMA-376 XSDs + PROVENANCE.md
build/    XSD -> SQLite ingest (build-time only, never shipped)
skill/    SKILL.md, a CLI, and a vendored copy of the core
mcp/      the mcp-server-ooxml npm package, a thin adapter over the core
```

## Development

```bash
pnpm install
make db             # build core/data/ooxml.db from schemas/
pnpm run verify     # lint + typecheck + schema manifest + tests
make sync-core      # copy the core into both surfaces after any core change
make check-vendor   # fail if a vendored copy has drifted
make smoke          # drive the MCP server over real stdio JSON-RPC
```

`AGENTS.md` has the conventions, the scope boundary and the vendoring rule.

## Credit and licensing

`superdoc-dev/ooxml-dev` is prior art; its `db/schema.sql` informed the shape of
this graph. **No code is shared** — its README carries an MIT badge but the
repository has no LICENSE file and GitHub's license API returns 404, which is
why the ingest here is an independent implementation rather than a borrowing.

The vendored ECMA-376 schemas are redistributed unmodified under Ecma
International's free-availability terms and Microsoft's Open Specification
Promise. This does not affect the MIT license on this project's own code.

MIT © shbernal
