# What it answers

The graph holds every ECMA-376 schema as a SQLite database, and both the skill and the MCP server query it.
Here is what they answer:

- **Children in schema order**, with cardinality and the full sequence/choice tree.
- **Attributes and their value space**: inherited attributes, enumerations, patterns, bounds and unions.
- **Validator errors explained**: paste a diagnostic and get back what would have been legal at that position.
- **Transitional and Strict**: answers for either profile, and a diff of what Transitional adds.
- **Every vocabulary**: wordprocessingml, spreadsheetml, presentationml, drawingml, VML and the package parts (`[Content_Types].xml`, `.rels`, `docProps/core.xml`).
- **Local and deterministic**: no account, no network call, no API key.

## Where a naive reading goes wrong

A schema browser that reads the XSDs naively gives confident wrong answers. These are the cases it gets wrong:

| Question | Naive answer | This project |
| --- | --- | --- |
| What goes inside a DrawingML type whose content is a group reference? | Nothing | The expanded group |
| Children of a type that extends a base | Its own children only | Base children first, each tagged with the type that contributed it |
| What is `w:tblPr`? | One content model | Both, each labelled with where it applies |
| Values of bare `ST_Direction` | One of them | All three: `ltr\|rtl` (wml), `horz\|vert` (pml), `norm\|rev` (dml-diagram) |
| Is `x:worksheet` valid input? | No prefix is bound in the schema | Yes, resolved as `sml:worksheet` |
