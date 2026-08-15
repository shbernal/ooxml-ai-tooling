# Provenance — vendored ECMA-376 schemas

Every `.xsd` here was extracted **verbatim and unmodified** from an archive
published by Ecma International. Do not hand-edit them. If a correction is ever
needed, re-extract from the source archive so provenance stays intact, then
regenerate `SHA256SUMS`.

`node build/check-schemas.mjs` verifies all 51 files against `SHA256SUMS` and
runs in CI. `.gitattributes` marks them `-text` so no checkout normalises their
line endings — they are CRLF as published, and a hash that only matches after
git rewrote the file is not a hash.

- **Standard:** ECMA-376, *Office Open XML File Formats*
- **Publisher:** Ecma International —
  <https://ecma-international.org/publications-and-standards/standards/ecma-376/>
- **Retrieved:** 2026-08-15

## `ooxml-transitional/` — 26 files, 941,846 bytes

- **Part 4** — *Transitional Migration Features*, 5th edition (December 2016)
- **Archive:** `ECMA-376-4_5th_edition_december_2016.zip`
  SHA-256 `bd25da1109f73762356596918bf5ff8b74a1331642dba5f1c1d1dfc6bed34ecd`
- **Inner archive:** `OfficeOpenXML-XMLSchema-Transitional.zip`
  SHA-256 `d34187520749998af306faf1b730e568b0ca6d88ad24638a407c0a9bb4ca04fc`

What Office actually emits, and the profile the ingest completes first.

Both hashes were verified against a fresh download on 2026-08-15, and the
extraction was additionally confirmed byte-for-byte identical to the independent
copy in `../../ts-xlsx/schemas/ooxml-transitional/`. Two chains, same bytes.

## `ooxml-strict/` — 21 files, 855,792 bytes

- **Part 1** — *Fundamentals and Markup Language Reference*, 5th edition
  (December 2016)
- **Archive:** `ECMA-376-1_5th_edition_december_2016.zip`
  SHA-256 `9d0bcad9cf06054785b03762fcfadbf6bab7e54a5f9d69434e34b7fd464d4129`
- **Inner archive:** `OfficeOpenXML-XMLSchema-Strict.zip`
  SHA-256 `73fab4b04ddd93da020ed07583f755466dcaf69f115b2ff6649af7ae16a816f7`

Five fewer files than Transitional: the whole VML set
(`vml-*.xsd`, `urn:schemas-microsoft-com:*`) is absent, which is the single
largest difference between the profiles.

## `opc/` — 4 files, 8,852 bytes

- **Part 2** — *Open Packaging Conventions*, 5th edition (**December 2021**)
- **Archive:** `ECMA-376-2_5th_edition_december_2021.zip`
  SHA-256 `1d489dc491168ea1f9e9a59063acc8dd5f02b4ad1d21aa7ec19ba9a58d020c70`
- **Inner archive:** `OpenPackagingConventions-XMLSchema.zip`
  SHA-256 `e5a0a7c1f43ac8b8f66d850f48545c2ead09f6d632bb8539fab79962c7fd55df`

Note the date: Part 2's 5th edition is **December 2021**, not December 2016 like
Parts 1 and 4. The `…december_2016` URL for Part 2 does not exist.

**Vendored ahead of use, and not ingested.** `[Content_Types].xml` and `.rels`
are where a large share of real-world OOXML bugs live, but nothing queries them
yet. They are small and stable, so vendoring now costs ~9 KB and saves repeating
this exercise when the package-inspection tool arrives. Unlike the other two
sets these carry a UTF-8 BOM, which an ingest will have to strip rather than
treat as document content.

## Licensing

Ecma International makes ECMA-376 and its schemas **freely available** and
permits their reproduction. The Office Open XML schemas are additionally covered
by Microsoft's **Open Specification Promise (OSP)**. They are redistributed here
unmodified, as development-time reference material, under those terms. This does
not alter the license of this project's own source code (see `../LICENSE`).

## Reproduce

```sh
cd "$(mktemp -d)"
base=https://ecma-international.org/wp-content/uploads
curl -sLO $base/ECMA-376-4_5th_edition_december_2016.zip
curl -sLO $base/ECMA-376-1_5th_edition_december_2016.zip
curl -sLO $base/ECMA-376-2_5th_edition_december_2021.zip
sha256sum -c <<'EOF'
bd25da1109f73762356596918bf5ff8b74a1331642dba5f1c1d1dfc6bed34ecd  ECMA-376-4_5th_edition_december_2016.zip
9d0bcad9cf06054785b03762fcfadbf6bab7e54a5f9d69434e34b7fd464d4129  ECMA-376-1_5th_edition_december_2016.zip
1d489dc491168ea1f9e9a59063acc8dd5f02b4ad1d21aa7ec19ba9a58d020c70  ECMA-376-2_5th_edition_december_2021.zip
EOF

unzip -p ECMA-376-4_5th_edition_december_2016.zip OfficeOpenXML-XMLSchema-Transitional.zip > t.zip
unzip -p ECMA-376-1_5th_edition_december_2016.zip OfficeOpenXML-XMLSchema-Strict.zip       > s.zip
unzip -p ECMA-376-2_5th_edition_december_2021.zip OpenPackagingConventions-XMLSchema.zip   > o.zip

unzip -q t.zip -d ooxml-transitional
unzip -q s.zip -d ooxml-strict
unzip -q o.zip -d opc
```
