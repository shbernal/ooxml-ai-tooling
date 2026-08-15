# schemas/

The ECMA-376 XSDs, vendored verbatim. `PROVENANCE.md` records where each set
came from and how to reproduce the extraction.

```
ooxml-transitional/  26 files  Part 4, Transitional — what Office emits
ooxml-strict/        21 files  Part 1, Strict — no VML
opc/                  4 files  Part 2, Open Packaging Conventions — not ingested
```

## These are build input, not a runtime path

This is the difference from `../../ts-xlsx/schemas/`, where the XSDs are read
directly by whoever needs them. **Here nothing reads them at runtime.** They are
consumed once by `build/` and turned into a SQLite database; the database is the
artifact both surfaces query, and it is the only thing that ships.

Concretely:

- **Do not wire a runtime path to this directory.** Neither `skill/` nor `mcp/`
  receives it — it is vendored into no surface — and code that reads it would
  work in a checkout and fail everywhere the tools are actually installed.
- **Do not grep it to answer a question.** The root `.ignore` makes `rg` skip it
  by default for exactly this reason: 940 KB of XML that an agent can drown in,
  when the same question has a cheap structured answer. `rg --no-ignore` reaches
  it when you are genuinely working on the ingest.
- **Do not hand-edit.** `node build/check-schemas.mjs` fails on any byte change,
  including a line-ending rewrite.

## Why both profiles are here

Transitional is what Office writes and is the profile the ingest completes
first. Strict is here because the profile dimension is load-bearing in the graph
model, and a dimension shipped with exactly one value is an untested dimension.

The two are not independent vocabularies. They are the same symbols under two
namespace spellings — `schemas.openxmlformats.org/<area>/2006/<name>` versus
`purl.oclc.org/ooxml/<area>/<name>` — which is why the database keys on a
vocabulary id and treats the URIs as aliases.

That was verified rather than assumed, before any ingest was written: across all
2,118 symbols the profiles share, `@type` and `@substitutionGroup` agree in
every case, and Strict contains **no** symbol absent from Transitional. Strict is
a subset. The 255 Transitional-only symbols are 216 VML plus 39 named
migration artifacts — the `ST_TrueFalse` laxity family, percentage-as-decimal
types, legacy crypto enums, `AG_TransitionalPassword`.
