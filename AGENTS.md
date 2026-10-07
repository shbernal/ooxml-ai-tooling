# AGENTS.md

Guidance for AI agents working in this repo.

## What this is

An agent skill and an MCP server over one shared core. Both give an agent
offline, structured access to the ECMA-376 schema graph: what an element is,
what may go inside it, what attributes it takes, and what values those
attributes accept. `README.md` has the pitch and usage.

```
core/     the implementation and its tests, the only real source
schemas/  vendored ECMA-376 XSDs + PROVENANCE.md
build/    XSD -> SQLite ingest, and the checks on the database (never shipped)
scripts/  repo tooling that does not make or check the database
skill/    SKILL.md, a CLI, and a vendored copy of the core
mcp/      the mcp-server-ooxml npm package, a thin adapter over the core
```

The shipped core has **zero runtime dependencies**, Node 24+ and nothing else.
Keep it that way. It is what lets `skill/` run from a bare checkout with no
`package.json` and no install step. Build-time dev dependencies are fine,
including the XML parser, because `build/` never ships.

Node 24+ is the floor because of `node:sqlite`, which is unflagged from 23.4.
That is the only reason for `.nvmrc` and `engines.node`.

## Pre-release

`0.0.x`. Both artifacts are published, `mcp-server-ooxml` on npm and
`ooxml-lookup` on ClawHub. Publishing a version does not commit us to its
shape. Treat everything here as free to change:

- No backwards compatibility obligation, on any surface, in any direction.
- No deprecation shims, no compatibility aliases, no "kept for the old callers".
- Existing code, file layout and written plans are context, not constraints.
  When the better design is incompatible with what is here, ship the better
  design.

Delete this section when `v0.1.0` ships. From then on compatibility is a real
constraint, and a breaking change needs a reason.

## Versioning and what a change has to ship on

The two artifacts have independent version numbers. A change bumps both only
when it reaches both.

| Change | Ships on |
| --- | --- |
| `core/` | Usually both, since both vendor it. |
| `skill/SKILL.md` | The skill only. The artifact embeds it, so a trigger or description fix reaches users only with a release. |
| `mcp/README.md` | npm only. It is the npm project page and updates only on a release. |
| Root `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/` | Neither. Commit them and publish nothing. |

**A database rebuild is a release on both surfaces**, even when no `.mjs`
changed. This is the one most likely to be missed. `data/ooxml.db` is copied
into both, so a schema-graph correction reaches both. `make check-vendor`
catches it, and so does the release workflow's `git diff … -- skill/`, because
the database lives under `skill/`.

Registries treat a version as permanent. Never delete or re-publish a released
version. Fix forward with a bump.

### Breaking changes are welcome

After `v0.1.0`, a published version is fixed, but the next one can still
break it. When the better behaviour is incompatible with the old one, remove
the old one and bump.

Do not add a deprecation period, a compatibility shim, or a runtime warning
that behaviour changed. Put the notice in `CHANGELOG.md` under the version that
made the change. Say what moved and, where possible, how to get the old
outcome. A user reads a migration note once. Code that carries its own history
costs something on every read.

## The scope boundary

Two sibling projects answer one question each.

`ooxml-validate` answers "is this file valid?" by wrapping Microsoft's
`OpenXmlValidator`. This repo answers "what is legal here, and what does the
schema say?" from the ECMA-376 graph. **This repo never grows a second
validation path.** `ts-xlsx` ADR-0007 rejected one, and the reasoning holds. A
second validator is redundant and would drift from the first.

`ooxml-validate` has not shipped yet (`0.0.1`, no release). Its integrations in
`ts-xlsx` and `ts-pptx` are provisional, and its own contract may change after
it ships. The split above is the intended one, not a stable published
relationship.

### Where data crosses the boundary

In exactly one place. The `explain` tool reads four fields of an
`ooxml-validate` JSON diagnostic, `id`, `description`, `partUri` and `xpath`,
and turns them into a schema answer.

That is a data shape, not a dependency. Nothing is imported and nothing needs
installing, so the boundary holds. But `ooxml-validate` has not frozen that
shape before 1.0, so it is a cross-repo contract. Reading only four fields
keeps the damage small when the report changes.

Do not widen `explain` to read the whole report. If a change needs more of it,
argue against this paragraph first.

`explain` also accepts a diagnostic as pasted text and fills the same four
fields from it on a best-effort basis. That is a second input format, not more
of the report. It reads nothing the four fields do not carry, and resolution
still goes through the same id allowlist.

## Scope: ECMA-376 and nothing else

A future session will want to add both of the following. Neither is missing by
accident.

**No spec prose, no PDFs, no embeddings.** We have no way to query them, and
shipping ~100 MB we cannot search does nothing for users. For semantic search
over the specification text there is ooxml.dev, and the README says so.

**No behaviour notes and no Microsoft implementation deltas** (MS-OI29500 and
friends). They pull in documentation outside the standard we model. And the
behaviour corpus that is easy to get is mostly about xlsx, which would skew a
tool that has to serve wml, sml, pml and dml equally.

The graph holds one thing from outside ECMA-376: the Dublin Core elements that
Part 2's core properties reference. They are untyped, and their vocabulary's
`external_source` says where they are defined. Do not "complete" them by
vendoring the Dublin Core schemas. That would bring in a standard this repo
does not model, for fields that hold plain text anyway.

The tools return structured answers, not XML. No tool returns raw XSD source at
v1. Ship the structured answers first and see what people actually miss.

## The XSDs are build input

`schemas/` holds ~940 KB of ECMA-376 XSD, vendored verbatim. **Do not grep it or
read it to answer a question. Query the database.** The answer is smaller and
more accurate than the file.

A root `.ignore` makes `rg` skip `schemas/` by default, so the easy wrong move
does not work. `rg --no-ignore` still reaches the files when you are working on
the ingest.

The XSDs are stored byte-for-byte as extracted, and `.gitattributes` marks them
`-text` so git never normalises their line endings. The checksums in
`schemas/PROVENANCE.md` are over those exact bytes. A checksum that only
matches after git rewrote the file proves nothing.

## The graph ships as SQLite, not JSON

"Ship JSON, it is simpler" is the obvious simplification, and it was considered
and rejected. Argue with this section before changing the format.

**The format controls what an agent can cheaply do.** `SKILL.md` only advises,
and an agent takes the cheap obvious path. With JSON that path works, badly and
silently. `rg` on pretty-printed JSON returns a matching line without its
record, so the agent reads a multi-MB file next. On minified JSON a single hit
puts the whole graph in context. A binary `.db` has no cheap wrong path. `rg`
says `binary file matches` and stops, `Read` refuses it, and the only way in is
the query layer.

Other reasons:

- JSONL per table survives grep but loses joins. "What can go inside
  `w:tblPr`" becomes a hand-join across four files.
- The CLI starts a process per call, and agents call it in a loop. JSON parses
  the whole graph every time. SQLite reads only the pages a query touches.
- The graph is recursive (transitive inheritance, nested compositors). SQLite
  handles that with a recursive CTE. Otherwise the vendored core needs
  hand-written traversal.

`node:sqlite` being experimental does not count against it. It is still a
`node:` builtin, so the core keeps zero runtime dependencies.

## The vendoring rule

`core/` is the only implementation. Every file under `skill/scripts/` and
`mcp/src/` named in `CORE_FILES` in `build/vendor.mjs` is a byte-identical copy
of a core file, the built database included. That list is the only one: the
copy, the check and the tests all read it.

- **Never edit a vendored copy directly.** Edit the core, then run
  `make sync-core`.
- `make check-vendor` fails on drift and runs as a `pre-commit` hook.
- Files not in `CORE_FILES`, meaning the tests and everything in `build/` and
  `scripts/`, are for development and must never reach a surface.
- `make sync-core` is not automated on purpose. Vendoring is a decision to
  record in the commit, not a side effect of it.

The core is plain ESM with JSDoc types, not TypeScript, so the vendored copies
need no build step on either surface. Keep it that way. A compile step would
have to run in both places, and the vendoring check would stop being a byte
comparison.

`core/data/ooxml.db` is build output and is not committed. CI rebuilds it on
every run. The two committed copies live in `skill/scripts/data/` and
`mcp/src/data/`. The surfaces ship separately, as an npm tarball and a bare
checkout, so each must carry its own.

## Commands

```bash
pnpm install        # both package trees at once
make db             # build core/data/ooxml.db from schemas/
make test           # the core suite, plus the MCP output schemas against the graph
make sync-core      # copy the core into both surfaces; run after any core edit
make check-vendor   # verify the vendored copies match
make smoke          # drive the MCP server over real stdio JSON-RPC
pnpm run verify     # lint + typecheck + schemas + tests + smoke, the gate CI runs
```

Run `make sync-core test check-vendor` before committing any core change.

## The package manager

pnpm, pinned by `packageManager` in the root `package.json`. Two of its
properties matter here:

- **One install, two package trees.** `pnpm-workspace.yaml` lists `mcp` as a
  member, so one root `pnpm install` covers the root devDependencies and
  `mcp/`'s runtime deps. `mcp/` gets the core by file copy, never as a package,
  so there is no cross-package dependency. The workspace only coordinates the
  install. `skill/` is not a member on purpose. It has no `package.json` and
  must keep running from a bare checkout with no install step.
- **No phantom dependencies.** pnpm's isolated `node_modules` lets a module
  import only what its own `package.json` declares. That makes module
  resolution enforce "the core ships zero runtime dependencies". Do not add
  `node-linker=hoisted` or otherwise flatten the store.

pnpm blocks dependency lifecycle scripts and fails the install until each one
is allowed or denied in `pnpm-workspace.yaml` under `allowBuilds`. Only
`lefthook` has one. If a new dependency wants a build script, decide on purpose.

## Prior art and credit

`superdoc-dev/ooxml-dev` is the incumbent and good prior art. Its
`db/schema.sql` informed the shape of our graph model. **No code is shared.**
This is not a fork and not a drop-in replacement.

Its README has an MIT badge, but the repo has no LICENSE file and GitHub's
license API returns 404 for it. That is why the ingest is reimplemented rather
than borrowed. Credit it in the README the way `ooxml-validate` credits
`mikeebowen/OOXML-Validator`.

The real difference is where it runs. ooxml-dev's MCP server is a thin client
of a hosted service (Postgres + pgvector + auth) with no local mode. This repo
runs entirely locally, deterministically and offline.

## Conventions

- Node 24+. Zero runtime dependencies in the core. `mcp/` carries only the MCP
  SDK and `zod`.
- `node:sqlite` is still flagged experimental on Node 24 and prints an
  `ExperimentalWarning` on stderr. Both surfaces suppress that one warning at
  process entry. **Every `node:sqlite` call lives in a single module**, so an
  API break costs one file.
- Tests use `node:test`, run entirely offline, and stay deterministic.
- Biome, not oxlint as elsewhere in the house stack. Biome here also formats
  and organises imports, so swapping only the linter would mean two tools on
  every commit. No lint problem so far has justified that.
- Author metadata is `shbernal`.
