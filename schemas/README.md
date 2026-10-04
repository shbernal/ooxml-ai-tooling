# schemas/

The ECMA-376 XSDs, vendored verbatim. `PROVENANCE.md` records where each set
came from and how to reproduce the extraction.

```
ooxml-transitional/  26 files  Part 4, Transitional: what Office emits
ooxml-strict/        21 files  Part 1, Strict: no VML
opc/                  4 files  Part 2, Open Packaging Conventions: read into both profiles
```

## These are build input, not a runtime path

In `../../ts-xlsx/schemas/`, code reads the XSDs directly. Here nothing reads
them at runtime. `build/` reads them once and writes a SQLite database. Both
surfaces query that database, and it is the only thing that ships.

So:

- **Do not wire a runtime path to this directory.** No surface receives it.
  Code that reads it would work in a checkout and fail everywhere the tools are
  installed.
- **Do not grep it to answer a question.** The root `.ignore` makes `rg` skip
  it by default. It is 940 KB of XML, and the database answers the same
  question in a few lines. `rg --no-ignore` reaches it when you are working on
  the ingest.
- **Do not hand-edit.** `node build/check-schemas.mjs` fails on any byte
  change, including a line-ending rewrite.

## Why both profiles are here

Transitional is what Office writes, and the ingest completes it first. Strict
is here because the graph has a profile dimension, and a dimension with one
value never gets tested.

The two are not independent vocabularies. They are the same symbols under two
namespace spellings, `schemas.openxmlformats.org/<area>/2006/<name>` and
`purl.oclc.org/ooxml/<area>/<name>`. That is why the database keys on a
vocabulary id and treats the URIs as aliases.

I checked this before writing any ingest. Across all 2,118 symbols the profiles
share, `@type` and `@substitutionGroup` agree in every case, and Strict has no
symbol that Transitional lacks. Strict is a subset. The 255 Transitional-only
symbols are 216 VML plus 39 named migration artifacts: the `ST_TrueFalse`
laxity family, percentage-as-decimal types, legacy crypto enums, and
`AG_TransitionalPassword`.
