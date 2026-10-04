# Contributing

Node 24+ and pnpm, pinned in `package.json`. One install covers the root and `mcp/`.

```bash
pnpm install
```

Build the database from `schemas/`.

```bash
make db
```

Run the same gate as CI. It lints, typechecks, checks the schema manifest, runs the tests and smoke-tests the MCP server.

```bash
pnpm run verify
```

`core/` is the only real source. The copies under `skill/scripts/` and `mcp/src/` are vendored byte-for-byte, so run this after any core change.

```bash
make sync-core test check-vendor
```

[`AGENTS.md`](AGENTS.md) has the rest: the scope boundary, the vendoring rule, and which changes ship on which surface.
