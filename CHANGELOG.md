# Changelog

Notable changes to both surfaces. The npm package (`mcp-server-ooxml`) and the
skill (`ooxml-lookup`) version independently; an entry names which it affects
when only one is involved.

This file ships in neither artifact. It is where a breaking change is announced,
because nothing else announces one — there are no deprecation shims and no
runtime notices.

## Unreleased

Nothing yet.

## 0.0.3 — both surfaces

A database rebuild, so both artifacts ship it even though the reason is one
table and two `.mjs` files.

### Added

- **`x:` and `c:` resolve.** The schemas never bind a prefix to spreadsheetml's
  own namespace or to charts, so `observedPrefixes` recorded NULL for both —
  honest about the standard, and unable to answer in the spelling its own inputs
  arrive in. A validator diagnostic for a `.xlsx` is written
  `/x:worksheet[1]/x:pageSetup[1]`; every one of them resolved to `found: false`,
  which meant `explain` was dark across the whole of SpreadsheetML on real
  unmodified input.

  A new `prefix_aliases` table records the ecosystem's spelling as a **second
  evidence source** rather than a fallback invention. Nothing XSD-derived is
  overwritten: `namespaces.preferred_prefix` still reports what the schemas bind
  and still returns null for these, `ooxml_namespace` reports the alias
  separately under `aliases`, and every row carries the citation it came from.
  Two rows, `x` → `sml` and `c` → `dml-chart`; the other seven nulls stay null,
  because a plausible guess is worth less than a missing answer.

  `x` names two vocabularies — VML's excel namespace genuinely binds it — and
  that is resolved by looking the local name up in both, which is the path an
  ambiguous bare name already took. `x:worksheet` finds sml, `x:ClientData`
  finds VML. **Output stays canonical**: `x:worksheet` answers `sml:worksheet`,
  so the two namespaces never print identically.

### Fixed

- **`explain` narrows an ambiguous attribute owner by the ancestor path**, which
  it already did for content models but not for attributes. `pageSetup` is
  `CT_PageSetup` on a worksheet and `CT_CsPageSetup` on a chartsheet with
  different attribute sets, and the answer came from whichever variant sorted
  first. The xpath settles it. Latent before now — it took `x:` resolving for a
  spreadsheet diagnostic to reach this path at all.

- **`explain` no longer invents an attribute called `it`.** When the quoted name
  could not be read out of a diagnostic's `description`, the fallback pronoun was
  substituted into the slot the template *quotes*, producing
  `The 'it' attribute is not allowed on x:sheet` — which reads as a real
  attribute named `it`, the one thing this tool must never do. Every phrasing
  that quotes a name now has a nameless variant, and the two value-space ids say
  "every attribute it accepts is listed below" in that case, because without a
  name `explain` cannot narrow to one attribute and returns the whole list. A
  missed capture was always meant to cost the name and not the answer; now it
  costs only the name. Affects both surfaces.

## 0.0.2 — skill (`ooxml-lookup`)

First published version of the skill, cut from the `v0.0.2` tag and therefore
**identical in content to the npm release below** — same core, same database.
The skill starts at `0.0.2` rather than `0.0.1` so that the version a release
publishes is the tag it came from, which is the invariant
`.github/workflows/publish.yml` enforces from here on.

Uploaded by hand, for the same class of reason `0.0.1` was on npm: the workflow
publishes a skill version only when `skill/` differs from the previous tag, and
`skill/` has not changed since `v0.0.2` — so no release could ever have minted
the *first* version. The gate is correct for every version after this one.

Two release-path fixes landed alongside it, neither of which reaches an
artifact:

- **`CLAWHUB_TOKEN` is an *environment* secret**, so `publish-skill` now
  declares `environment: release`. Without it the token resolved to an empty
  string. `publish-mcp` deliberately stays out of the environment: npm's trusted
  publisher for this package is configured without one, which a job running in
  `release` would contradict in its OIDC claims.
- **The "is ClawHub configured?" gate is gone.** It was written when no token
  existed and turned a missing or expired one into a silently skipped release —
  a green workflow that published nothing, which is how `v0.0.2` shipped without
  the skill. Authentication now fails loudly.

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

First published version, npm only — the skill's first release is `0.0.2` above.

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
