# Changelog

Notable changes to both surfaces. The npm package (`mcp-server-ooxml`) and the
skill (`ooxml-lookup`) version independently; an entry names which it affects
when only one is involved.

This file ships in neither artifact. It is where a breaking change is announced,
because nothing else announces one — there are no deprecation shims and no
runtime notices.

## Unreleased

Nothing yet.

## 0.0.2 — npm (`mcp-server-ooxml`)

The code is **identical to `0.0.1`**. This release exists to exercise the
automated path end to end, which `0.0.1` could not: npm trusted publishing is
configured on a package's own settings page, so the package has to exist on the
registry before there is anything to point at. `0.0.1` was therefore uploaded by
hand and `0.0.2` is the first to go through `.github/workflows/publish.yml`.

The one user-visible difference falls out of that: this version carries a
**provenance attestation** linking the tarball to the commit and workflow that
built it. `0.0.1` has none, and cannot be given one — provenance needs OIDC from
CI, and a published version is never re-uploaded.

From here every release goes through the workflow. A second manual `npm publish`
would mean the automation is broken and should be fixed rather than worked
around.

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
