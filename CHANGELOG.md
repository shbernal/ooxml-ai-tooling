# Changelog

Notable changes to both surfaces. The npm package (`mcp-server-ooxml`) and the
skill (`ooxml-lookup`) version independently; an entry names which it affects
when only one is involved.

This file ships in neither artifact. It is where a breaking change is announced,
because nothing else announces one — there are no deprecation shims and no
runtime notices.

## Unreleased

Nothing yet.

## 0.0.1 — npm (`mcp-server-ooxml`)

First published version. The skill (`ooxml-lookup`) is not released yet.

- The ECMA-376 schema graph: 51 vendored XSDs (Transitional, Strict, and the
  OPC set, the last vendored ahead of use) ingested into a 2.2 MB SQLite
  database of 5,606 symbols across both profiles.
- Nine query tools plus `explain`, on two surfaces over one zero-dependency
  core.
- `explain` resolves an `ooxml-validate` diagnostic into "here is what would
  have been legal at that position", reading four fields of the report and no
  more.

### Fixed before first release

- **A bare name matching several vocabularies no longer answers with one of
  them.** `children`, `attributes`, `values` and `enum` picked the first match
  and returned it unlabelled, so `enum ST_Direction` answered `norm|rev`
  (dml-diagram) to a question that was as likely about wml's `ltr|rtl` or pml's
  `horz|vert`, and `children CT_Shape` reported the one of six declarations
  that has no children. They now return `ambiguous: true` with a `variants`
  array, the same way `element` and `type` already did. Answers for *qualified*
  names are unchanged — no local name collides with itself inside a single
  vocabulary.
- `enum` on a name with no simple type now returns `found: true` with
  `enumerated: false` and a `reason`, rather than `found: false`. It found the
  name; what it lacks is an enumeration.
