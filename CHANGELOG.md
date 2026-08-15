# Changelog

Notable changes to both surfaces. The npm package (`mcp-server-ooxml`) and the
skill (`ooxml-lookup`) version independently; an entry names which it affects
when only one is involved.

This file ships in neither artifact. It is where a breaking change is announced,
because nothing else announces one — there are no deprecation shims and no
runtime notices.

## Unreleased

Everything so far. Nothing has been published yet.

- The ECMA-376 schema graph: 51 vendored XSDs (Transitional, Strict, and the
  OPC set, the last vendored ahead of use) ingested into a 2.2 MB SQLite
  database of 5,606 symbols across both profiles.
- Nine query tools plus `explain`, on two surfaces over one zero-dependency
  core.
- `explain` resolves an `ooxml-validate` diagnostic into "here is what would
  have been legal at that position", reading four fields of the report and no
  more.
