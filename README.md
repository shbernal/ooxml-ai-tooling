# ooxml-ai-tooling

The ECMA-376 (Office Open XML) schema, as structured data an AI agent can query
— **locally, offline, with no account and no network call**.

Two surfaces over one core:

- **`ooxml-lookup`** — an agent skill: a CLI for any agent with a shell.
- **`mcp-server-ooxml`** — an MCP server over stdio, for MCP clients.

Both answer the same questions. What may go inside `w:tblPr`? What attributes
does `a:solidFill` take, and what values are legal for each? What is the
difference between the Transitional and Strict definitions of this element?

> **Status: pre-release.** Nothing is published yet and everything is subject to
> change.

## Why this exists

[`superdoc-dev/ooxml-dev`](https://github.com/superdoc-dev/ooxml-dev) is the
incumbent and good prior art — its data model informed the shape of ours. But
its MCP server is a **thin client of a hosted service**: `api.ooxml.dev/mcp`,
backed by Postgres + pgvector behind an authentication requirement, with usage
metering. There is no local mode, and its ingest cannot produce one without
Postgres, pgvector and an embedding model.

This project is not a clone of it. It is the half that **can** be fully local,
deterministic and offline — the XSD graph — built from committed schemas into a
committed SQLite database, queried by a core with zero runtime dependencies.

It deliberately does not compete on the half that cannot be local. If you want
semantic search over the specification prose, use ooxml.dev; that is a real
thing this does not do, and it is not on the roadmap. See `AGENTS.md` for why.

## Which surface do I want?

TODO — the comparison table, filled in once both surfaces exist.

## Install and use

TODO.

## Scope

The ECMA-376 XSD graph, and nothing else. No specification prose, no PDFs, no
embeddings, no "what Word actually does" behaviour notes. The reasoning is in
`AGENTS.md`.

Its sibling `ooxml-validate` answers a different question — *is this file
valid?* — by wrapping Microsoft's `OpenXmlValidator`. This repo answers *what is
legal here?* It never grows a second validation path.

## Development

TODO — `pnpm install`, `make db`, `make test`.

## License

MIT © shbernal
