#!/usr/bin/env node
/**
 * mcp-server-ooxml — the MCP surface.
 *
 * A thin adapter over the shared core. Every answer comes from `graph.mjs` and
 * `explain.mjs`, which are byte-identical copies of `core/`; this file only maps
 * tool calls onto them and shapes responses.
 *
 * Unlike the skill, this process is long-lived — it lives as long as the client
 * does — so the graph is opened once and held. That is safe here in a way it
 * would not be for a network-backed tool: the database is a committed file that
 * cannot change under us, so there is no staleness to revalidate against.
 *
 * stdio only. There is deliberately no HTTP mode: it would be a hosting promise
 * this project is not making, and a hosted OOXML schema service already exists
 * (ooxml.dev). The README says so rather than half-building an alternative.
 */
import {McpServer} from '@modelcontextprotocol/server';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';
import pkg from '../package.json' with {type: 'json'};
import {explainDiagnostic, parseDiagnosticText} from './explain.mjs';
import {createGraph, PROFILE_KEYS} from './graph.mjs';
import * as OUTPUT from './schemas.mjs';

const graph = createGraph();
const server = new McpServer({name: 'ooxml', version: pkg.version});

const PROFILE = z
  .enum(PROFILE_KEYS)
  .optional()
  .describe(
    'Which ECMA-376 profile to answer for. Default "transitional" — that is what Word, Excel ' +
      'and PowerPoint actually write, so it is almost always the right one. "strict" is the ' +
      'ISO profile: same vocabulary, different namespace URIs, and it drops VML entirely.',
  );

const NAME = z
  .string()
  .describe(
    'A qualified name. Accepts w:tblPr, wml:tblPr, {namespace-uri}tblPr, or a bare tblPr. ' +
      'A bare or ambiguous name returns every match rather than guessing.',
  );

/**
 * The answer twice: as `structuredContent`, which the SDK checks against the
 * tool's output schema, and as compact JSON text for a client that predates
 * structured results. The text goes straight into a context window, hence
 * compact.
 */
const reply = (value) => ({
  structuredContent: value,
  content: [{type: /** @type {const} */ ('text'), text: JSON.stringify(value)}],
});

/** A call the tool refuses, as a tool error the client shows rather than a protocol error. */
const fail = (text) => ({
  isError: true,
  content: [{type: /** @type {const} */ ('text'), text}],
});

/**
 * The tools that take one name and a profile, and answer with the core method
 * of the same name. Only the wording and the output schema differ between
 * them. The descriptions are what a client's model reads to pick a tool, so
 * they are the product, not boilerplate.
 *
 * @type {{name: string, method: 'element' | 'children' | 'attributes' | 'values' | 'enum' | 'type', title: string, description: string, output: any}[]}
 */
const NAME_TOOLS = [
  {
    name: 'ooxml_element',
    method: 'element',
    title: 'Look up an OOXML element or attribute',
    description:
      'The canonical record for a name: what kind of thing it is, the type it declares, its ' +
      'namespace in the requested profile, and which profiles it exists in. Start here when you ' +
      'have a name and need to know what it is. Returns several symbols when the name is ' +
      'declared in more than one place — that is normal in OOXML, where the same element name ' +
      'is declared locally inside many types and can carry a different type in each. If nothing ' +
      'matches, the reason distinguishes an unknown name from one that exists only in the other ' +
      'profile, because those need opposite next steps.',
    output: OUTPUT.ELEMENT,
  },
  {
    name: 'ooxml_children',
    method: 'children',
    title: 'What may go inside this element, and in what order',
    description:
      "The legal content model: the sequence/choice/all tree with each node's own cardinality, " +
      'plus a flat list in schema order for the common case. This is the tool for "can I put ' +
      'this here, and where". Inheritance is resolved — for an extended type the base\'s ' +
      'children come first, and each entry names the type that contributed it. Group references ' +
      'are expanded in place, which matters because many DrawingML types have no direct children ' +
      "at all and consist entirely of a group reference. Cardinalities are the reference site's: " +
      'min/max of -1 means unbounded. Accepts an element or a type name.',
    output: OUTPUT.CHILDREN,
  },
  {
    name: 'ooxml_attributes',
    method: 'attributes',
    title: 'Attributes of an element or type',
    description:
      'Every attribute the type accepts, including ones inherited from a base type and ones ' +
      'reached through attributeGroup references, all expanded and resolved. Each carries its ' +
      'use (optional/required/prohibited), its resolved type, any default or fixed value, and ' +
      'whether it is written with a namespace prefix — that last one varies across OOXML and ' +
      'getting it wrong produces a document that looks right and does not load. An empty list is ' +
      'a real answer: plenty of OOXML types carry their properties as child elements instead.',
    output: OUTPUT.ATTRIBUTES,
  },
  {
    name: 'ooxml_values',
    method: 'values',
    title: 'The legal value space of a simple type',
    description:
      'What may actually be written: the base type, enumeration values, facets (pattern, ' +
      'minInclusive, maxInclusive, length and friends), and union members resolved recursively. ' +
      'Use this when writing a value rather than reading one — it is the difference between ' +
      '"it restricts xsd:string" and the pattern the string has to match. Also handles the ' +
      'measure types, which are unions, and reports inline union alternatives that have no name ' +
      'of their own. Accepts a simple type, or an element/attribute whose type you want.',
    output: OUTPUT.VALUES,
  },
  {
    name: 'ooxml_enum',
    method: 'enum',
    title: 'Enumeration values of a simple type',
    description:
      'Just the enumerated values, in schema order. Narrower and cheaper than ooxml_values when ' +
      'you already know the type is an enumeration. If it is not enumerated this says so and ' +
      'points at ooxml_values rather than returning an empty list that reads like "no legal ' +
      'values".',
    output: OUTPUT.ENUM,
  },
  {
    name: 'ooxml_type',
    method: 'type',
    title: 'Describe a complexType or simpleType',
    description:
      'What a type derives from and by what relation (extension or restriction, and in which ' +
      'content model), plus a summary of its shape — its top-level compositors, how many direct ' +
      'children and group references it has, how many attributes. Use it to orient before ' +
      'asking for the full content model.',
    output: OUTPUT.TYPE,
  },
];

for (const {name, method, title, description, output} of NAME_TOOLS) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: z.object({qname: NAME, profile: PROFILE}),
      outputSchema: output,
    },
    ({qname, profile}) => reply(graph[method](qname, {profile})),
  );
}

server.registerTool(
  'ooxml_search',
  {
    title: 'Find symbols by name substring',
    description:
      'Substring match on symbol names, case-insensitive. This is a NAME search and not a ' +
      'semantic one — there are no embeddings here by design, so it will not find "how do I ' +
      'make text bold". Use it when you half-remember a name. For prose-level search over the ' +
      'specification text, this project deliberately does not compete: ooxml.dev does that.',
    inputSchema: z.object({
      text: z.string().describe('A substring of the name, e.g. "tblPr" or "ST_Border".'),
      profile: PROFILE,
      limit: z.number().int().positive().max(200).optional().describe('Default 40.'),
    }),
    outputSchema: OUTPUT.SEARCH,
  },
  ({text, profile, limit}) => reply(graph.search(text, {profile, limit})),
);

server.registerTool(
  'ooxml_namespace',
  {
    title: 'Resolve a namespace, prefix or vocabulary',
    description:
      'Maps between namespace URIs, conventional prefixes and vocabularies, in both directions ' +
      'and for both profiles. The common use is working out which profile a document is in from ' +
      'a namespace URI it declares, or which URI to write for a prefix.',
    inputSchema: z.object({
      query: z.string().describe('A namespace URI, a prefix like "w", or a vocabulary like "wml".'),
    }),
    outputSchema: OUTPUT.NAMESPACE,
  },
  ({query}) => reply(graph.namespace(query)),
);

server.registerTool(
  'ooxml_diff_profiles',
  {
    title: 'Transitional vs Strict for one symbol',
    description:
      'What differs between the two profiles for a given name: namespace URI, the ' +
      'children and attributes allowed, enumeration values and union members. Strict is a subset — every ' +
      'difference is something Transitional adds back for legacy compatibility — so this ' +
      'answers "will this still be valid in Strict".',
    inputSchema: z.object({qname: NAME}),
    outputSchema: OUTPUT.DIFF_PROFILES,
  },
  ({qname}) => reply(graph.diff_profiles(qname)),
);

server.registerTool(
  'ooxml_explain',
  {
    title: 'Resolve a validation diagnostic against the schema',
    description:
      'Takes a schema validation diagnostic and answers the question that always follows it: ' +
      "then what WOULD be legal here. Pass the diagnostic's id, description and xpath — the " +
      'four fields an ooxml-validate report already gives you. Returns what the finding means ' +
      'plus the legal attributes or the ordered content model at that position. The xpath is ' +
      'used to disambiguate: an element with several content models resolves to the right one ' +
      'from its ancestors. An unrecognised diagnostic id is not an error — it still answers what ' +
      'is legal at that position. With only a pasted message in hand, pass it as `text` instead ' +
      'of the structured fields: the id, xpath and quoted names are recovered from it where ' +
      'present. This tool CONSUMES validator output; it does not validate anything, and nothing ' +
      'needs to be installed for it.',
    inputSchema: z.object({
      id: z.string().optional().describe('The Open XML SDK id, e.g. "Sch_UndeclaredAttribute".'),
      description: z
        .string()
        .max(4096)
        .optional()
        .describe('The diagnostic message; quoted names are read from it.'),
      // Longer than this is not a position, it is a payload.
      xpath: z
        .string()
        .max(4096)
        .optional()
        .describe('Where the problem is, e.g. "/w:document[1]/w:body[1]/w:p[1]".'),
      partUri: z.string().optional().describe('The part inside the package, echoed back.'),
      text: z
        .string()
        .max(4096)
        .optional()
        .describe(
          'The diagnostic as pasted text, when there is no structured report. Use instead of ' +
            'id, description, xpath and partUri, not alongside them.',
        ),
      profile: PROFILE,
    }),
    outputSchema: OUTPUT.EXPLAIN,
  },
  ({id, description, xpath, partUri, text, profile}) => {
    if (text !== undefined) {
      if ([id, description, xpath, partUri].some((field) => field !== undefined)) {
        return fail(
          'Pass either `text` or the structured fields (id, description, xpath, partUri), not both.',
        );
      }
      return reply(explainDiagnostic(graph, parseDiagnosticText(text), {profile}));
    }
    return reply(explainDiagnostic(graph, {id, description, xpath, partUri}, {profile}));
  },
);

// Close the database on the way out rather than leaving it to process exit.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    graph.close();
    process.exit(0);
  });
}

// One line on stderr, not an unhandled-rejection stack trace in the client's log.
await server.connect(new StdioServerTransport()).catch((error) => {
  process.stderr.write(`mcp-server-ooxml: could not connect: ${error.message}\n`);
  graph.close();
  process.exit(1);
});
