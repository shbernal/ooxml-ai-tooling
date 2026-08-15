# AGENTS.md

Guidance for AI agents working in this repo.

## What this is

Two surfaces (an agent skill and an MCP server) over one shared core, giving an
agent structured, offline access to the **ECMA-376 schema graph** — what an
element is, what may go inside it, what attributes it takes, what values those
attributes accept. See `README.md` for the full pitch and usage.

```
core/     the implementation and its tests — the only real source
schemas/  vendored ECMA-376 XSDs + PROVENANCE.md
build/    XSD -> SQLite ingest (build-time only, never shipped)
skill/    SKILL.md, a CLI, and a vendored copy of the core
mcp/      the mcp-server-ooxml npm package, a thin adapter over the core
```

The shipped core has **zero runtime dependencies**. Node 24+ and nothing else.
That is a property to preserve, not an accident: it is what lets `skill/` run
from a bare checkout with no `package.json` and no install step. Build-time dev
dependencies are fine — the XML parser lives there — because `build/` never
ships.

**Node 24+ is required by `node:sqlite`**, which is unflagged from 23.4 onward.
That is the whole reason for `.nvmrc` and `engines.node`; without it they would
read as an arbitrary pin.

## Pre-release

**`0.0.x`.** `mcp-server-ooxml` is on npm; the skill is not released yet.
Publishing a version does not make its shape a commitment — treat everything
here as free to change:

- No backwards compatibility obligation, on any surface, in any direction.
- No deprecation shims, no compatibility aliases, no "kept for the old callers".
- Existing code, file layout and written plans are **context, not constraints**.
  When the better design is incompatible with what is here, ship the better
  design.

The one thing a published version *does* fix is itself: never delete or
re-publish `0.0.1`, fix forward with a bump.

Delete this section when `v0.1.0` ships; from that point compatibility is a real
constraint and breaking changes are evaluated, not assumed.

## Versioning and what a change has to ship on

Two artifacts — `mcp-server-ooxml` on npm and `ooxml-lookup` on ClawHub — with
**independent version numbers**, coupled only when a change actually reaches
both.

- **`core/`** — normally both, since both vendor it.
- **`skill/SKILL.md`** — the skill only. The artifact embeds it, so a trigger or
  description fix does not reach users without a release.
- **`mcp/README.md`** — npm only. It is the project page and only updates on a
  release.
- **Root `README.md`, `AGENTS.md`, `CHANGELOG.md`** — ship in neither. Commit
  them; publish nothing.

**A database rebuild is a change to both surfaces.** This is the non-obvious
consequence of vendoring a *data* artifact and it is the thing most likely to be
missed: `data/ooxml.db` is copied into both, so a schema-graph correction is a
release on both even though no `.mjs` changed. `make check-vendor` is what
notices; the release workflow's `git diff … -- skill/` sees it too, because the
database lives under `skill/`.

Registries treat a version as permanent. Never delete or re-publish a released
version; fix forward with a bump.

### Breaking changes are welcome

Pre-release this is unconstrained (see above). Once released, "released"
constrains what a *published version* means, not what the next one may do. When
the better behaviour is incompatible with the old one, ship the better
behaviour: remove the old one and bump.

No deprecation period, no compatibility shims, no runtime warning that a
behaviour has changed. The notice goes in `CHANGELOG.md` under the version that
made the change, naming what moved and how to get the old outcome where one
exists. A migration is read once; code carrying a record of its own history is
paid for on every read after that.

## The scope boundary

Two sibling projects, one question each:

> `ooxml-validate` answers **"is this file valid?"** — it wraps Microsoft's
> `OpenXmlValidator`. This repo answers **"what is legal here, and what does the
> schema say?"** — it serves the ECMA-376 graph. **This repo never grows a second
> validation path.** `ts-xlsx` ADR-0007 rejected one and the reasoning holds: a
> second validator is redundant and would drift from the first.
>
> `ooxml-validate` has not shipped yet (`0.0.1`, no release). Its integrations in
> `ts-xlsx` and `ts-pptx` are provisional and its own contract may change after
> it ships. The boundary above is the **intended split**, not a description of a
> stable published relationship.

### Where the boundary is crossed by data

Exactly one place. The `explain` tool reads **four fields** of `ooxml-validate`'s
JSON diagnostic — `id`, `description`, `partUri` and `xpath` — and turns them
into a schema answer.

That is a *data shape*, not a dependency: nothing is imported and nothing needs
installing, so the boundary above holds. But that shape is explicitly unfrozen
before 1.0, which makes it a **cross-repo contract**. Reading only those four
fields is the deliberate mitigation — the narrower the surface, the smaller the
blast radius when the report changes.

Do not widen `explain` to consume the whole report. If a future change needs
more of it, argue against this paragraph first.

## Scope: ECMA-376 and nothing else

Both of these are the kind of thing a future session will helpfully try to
"improve". Neither is an oversight.

> **No spec prose, no PDFs, no embeddings.** We have no query path for them and
> shipping ~100 MB we cannot search is not a feature. People who want semantic
> search over the specification text have ooxml.dev; the README says so.
>
> **No behaviour notes, no Microsoft implementation deltas** (MS-OI29500 and
> friends). Two reasons: it drags in documentation outside the standard we are
> modelling, and the readily available behaviour corpus is **xlsx-shaped**, which
> would bias a tool that must serve wml, sml, pml and dml equally.

The surfaces serve **the table, not the XML**: no tool returns raw XSD source at
v1. Ship the structured answers first and see what is actually missing.

## The XSDs are build input

`schemas/` holds ~940 KB of ECMA-376 XSD, vendored verbatim. **Do not grep it and
do not read it to answer a question — query the database.** That is what it is
for, and the structured answer is smaller and more accurate than the file.

A root `.ignore` makes `rg` skip `schemas/` by default, so the cheap wrong path
is closed rather than merely discouraged. `rg --no-ignore` still reaches the
source when you are genuinely working on the ingest.

The XSDs are stored byte-for-byte as extracted, and `.gitattributes` marks them
`-text` so nothing normalises line endings. Their bytes *are* the provenance
claim in `schemas/PROVENANCE.md`; a checksum that only matches after git rewrote
the file is not a checksum.

## The vendoring rule

`core/` is the single implementation. Everything under `skill/scripts/` and
`mcp/src/` named in the Makefile's `CORE_FILES` is a byte-identical vendored
copy, not independent code — the built database included.

- **Never edit a vendored copy directly.** Edit the core, then `make sync-core`.
- `make check-vendor` fails on drift and runs as a `pre-commit` hook.
- Files not in `CORE_FILES` — the tests, everything in `build/` — are
  development-only and must never reach a surface.
- `make sync-core` is deliberately *not* automated: vendoring is a decision to
  record in the commit, not a side effect of it.

The core is plain ESM with JSDoc types rather than TypeScript, specifically so
the vendored copies need no build step on either surface. Keep it that way — a
compile step would have to run in both places and the vendoring guarantee would
stop being a byte comparison.

`core/data/ooxml.db` is **build output and is not committed**; CI rebuilds it
every run. The two copies that *are* committed live in `skill/scripts/data/` and
`mcp/src/data/`, because the surfaces are distributed separately (npm tarball,
bare checkout) and each must be self-contained.

## Commands

```bash
pnpm install        # both package trees at once
make db             # build core/data/ooxml.db from schemas/
make test           # the core suite
make sync-core      # copy the core into both surfaces — run after any core edit
make check-vendor   # verify the vendored copies match
make smoke          # drive the MCP server over real stdio JSON-RPC
pnpm run verify     # lint + test, the gate CI runs
```

Run `make sync-core test check-vendor` before committing any core change.

## The package manager

pnpm, pinned by `packageManager` in the root `package.json`. Two properties
matter here and both are load-bearing:

- **One install, two package trees.** `pnpm-workspace.yaml` lists `mcp` as a
  member, so a single root `pnpm install` covers the root devDependencies *and*
  `mcp/`'s runtime deps. There is no cross-package dependency to model — `mcp/`
  gets the core by byte-identical file copy, never as a package — so the
  workspace is install orchestration and nothing more. `skill/` is deliberately
  not a member: it has no `package.json` and must keep running from a bare
  checkout with no install step.
- **No phantom dependencies.** pnpm's isolated `node_modules` means a module can
  only import what its own `package.json` declares, so "the core ships zero
  runtime dependencies" is enforced by resolution rather than by discipline. Do
  not add `node-linker=hoisted` or otherwise flatten the store.

pnpm blocks dependency lifecycle scripts and **fails the install until every one
is answered** in `pnpm-workspace.yaml` under `allowBuilds`. Only `lefthook` has
one. If a new dependency demands a build script, decide deliberately.

## Prior art and credit

`superdoc-dev/ooxml-dev` is the incumbent and good prior art; its `db/schema.sql`
informed the *shape* of our graph model. **No code is shared.** This is not a
fork and not a drop-in replacement.

Its README carries an MIT badge but the repo has **no LICENSE file** and GitHub's
license API 404s for it — which is *why* the ingest is reimplemented rather than
borrowed. Credit it in the README the way `ooxml-validate` credits
`mikeebowen/OOXML-Validator`.

The substantive difference is architectural, not competitive: ooxml-dev's MCP is
a thin client of a hosted service (Postgres + pgvector + auth), with no local
mode. This repo is the half that can be fully local, deterministic and offline.

## Conventions

- Node 24+. Zero runtime dependencies in the core; `mcp/` carries nothing beyond
  the MCP SDK and `zod`.
- `node:sqlite` is still flagged experimental on Node 24 and prints an
  `ExperimentalWarning` on stderr. Both surfaces suppress that one warning at
  process entry, and **every `node:sqlite` call is confined to a single module**
  so an API break costs one file.
- Tests use `node:test`, run entirely offline, and stay deterministic.
- Author metadata is `shbernal`.
