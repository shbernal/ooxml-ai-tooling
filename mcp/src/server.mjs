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
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import pkg from '../package.json' with {type: 'json'};
import {explainDiagnostic} from './explain.mjs';
import {createGraph} from './graph.mjs';

const graph = createGraph();
const server = new McpServer({name: 'ooxml', version: pkg.version});

const PROFILE = z
  .enum(['transitional', 'strict'])
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

/** Compact JSON: an MCP response is going straight into a context window. */
const reply = (value) => ({content: [{type: 'text', text: JSON.stringify(value)}]});

server.registerTool(
  'ooxml_element',
  {
    title: 'Look up an OOXML element or attribute',
    description:
      'The canonical record for a name: what kind of thing it is, the type it declares, its ' +
      'namespace in the requested profile, and which profiles it exists in. Start here when you ' +
      'have a name and need to know what it is. Returns several symbols when the name is ' +
      'declared in more than one place — that is normal in OOXML, where the same element name ' +
      'is declared locally inside many types and can carry a different type in each. If nothing ' +
      'matches, the reason distinguishes an unknown name from one that exists only in the other ' +
      'profile, because those need opposite next steps.',
    inputSchema: {qname: NAME, profile: PROFILE},
  },
  ({qname, profile = 'transitional'}) => reply(graph.element(qname, {profile})),
);

server.registerTool(
  'ooxml_children',
  {
    title: 'What may go inside this element, and in what order',
    description:
      "The legal content model: the sequence/choice/all tree with each node's own cardinality, " +
      'plus a flat list in schema order for the common case. This is the tool for "can I put ' +
      'this here, and where". Inheritance is resolved — for an extended type the base\'s ' +
      'children come first, and each entry names the type that contributed it. Group references ' +
      'are expanded in place, which matters because many DrawingML types have no direct children ' +
      "at all and consist entirely of a group reference. Cardinalities are the reference site's: " +
      'min/max of -1 means unbounded. Accepts an element or a type name.',
    inputSchema: {qname: NAME, profile: PROFILE},
  },
  ({qname, profile = 'transitional'}) => reply(graph.children(qname, {profile})),
);

server.registerTool(
  'ooxml_attributes',
  {
    title: 'Attributes of an element or type',
    description:
      'Every attribute the type accepts, including ones inherited from a base type and ones ' +
      'reached through attributeGroup references, all expanded and resolved. Each carries its ' +
      'use (optional/required/prohibited), its resolved type, any default or fixed value, and ' +
      'whether it is written with a namespace prefix — that last one varies across OOXML and ' +
      'getting it wrong produces a document that looks right and does not load. An empty list is ' +
      'a real answer: plenty of OOXML types carry their properties as child elements instead.',
    inputSchema: {qname: NAME, profile: PROFILE},
  },
  ({qname, profile = 'transitional'}) => reply(graph.attributes(qname, {profile})),
);

server.registerTool(
  'ooxml_values',
  {
    title: 'The legal value space of a simple type',
    description:
      'What may actually be written: the base type, enumeration values, facets (pattern, ' +
      'minInclusive, maxInclusive, length and friends), and union members resolved recursively. ' +
      'Use this when writing a value rather than reading one — it is the difference between ' +
      '"it restricts xsd:string" and the pattern the string has to match. Also handles the ' +
      'measure types, which are unions, and reports inline union alternatives that have no name ' +
      'of their own. Accepts a simple type, or an element/attribute whose type you want.',
    inputSchema: {qname: NAME, profile: PROFILE},
  },
  ({qname, profile = 'transitional'}) => reply(graph.values(qname, {profile})),
);

server.registerTool(
  'ooxml_enum',
  {
    title: 'Enumeration values of a simple type',
    description:
      'Just the enumerated values, in schema order. Narrower and cheaper than ooxml_values when ' +
      'you already know the type is an enumeration. If it is not enumerated this says so and ' +
      'points at ooxml_values rather than returning an empty list that reads like "no legal ' +
      'values".',
    inputSchema: {qname: NAME, profile: PROFILE},
  },
  ({qname, profile = 'transitional'}) => reply(graph.enum(qname, {profile})),
);

server.registerTool(
  'ooxml_type',
  {
    title: 'Describe a complexType or simpleType',
    description:
      'What a type derives from and by what relation (extension or restriction, and in which ' +
      'content model), plus a summary of its shape — its top-level compositors, how many direct ' +
      'children and group references it has, how many attributes. Use it to orient before ' +
      'asking for the full content model.',
    inputSchema: {qname: NAME, profile: PROFILE},
  },
  ({qname, profile = 'transitional'}) => reply(graph.type(qname, {profile})),
);

server.registerTool(
  'ooxml_search',
  {
    title: 'Find symbols by name substring',
    description:
      'Substring match on symbol names, case-insensitive. This is a NAME search and not a ' +
      'semantic one — there are no embeddings here by design, so it will not find "how do I ' +
      'make text bold". Use it when you half-remember a name. For prose-level search over the ' +
      'specification text, this project deliberately does not compete: ooxml.dev does that.',
    inputSchema: {
      text: z.string().describe('A substring of the name, e.g. "tblPr" or "ST_Border".'),
      profile: PROFILE,
      limit: z.number().int().positive().max(200).optional().describe('Default 40.'),
    },
  },
  ({text, profile = 'transitional', limit}) => reply(graph.search(text, {profile, limit})),
);

server.registerTool(
  'ooxml_namespace',
  {
    title: 'Resolve a namespace, prefix or vocabulary',
    description:
      'Maps between namespace URIs, conventional prefixes and vocabularies, in both directions ' +
      'and for both profiles. The common use is working out which profile a document is in from ' +
      'a namespace URI it declares, or which URI to write for a prefix.',
    inputSchema: {
      query: z.string().describe('A namespace URI, a prefix like "w", or a vocabulary like "wml".'),
    },
  },
  ({query}) => reply(graph.namespace(query)),
);

server.registerTool(
  'ooxml_diff_profiles',
  {
    title: 'Transitional vs Strict for one symbol',
    description:
      'What differs between the two profiles for a given name: namespace URI, child and ' +
      'attribute counts, enumeration values and union members. Strict is a subset — every ' +
      'difference is something Transitional adds back for legacy compatibility — so this ' +
      'answers "will this still be valid in Strict".',
    inputSchema: {qname: NAME},
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
      'is legal at that position. This tool CONSUMES validator output; it does not validate ' +
      'anything, and nothing needs to be installed for it.',
    inputSchema: {
      id: z.string().optional().describe('The Open XML SDK id, e.g. "Sch_UndeclaredAttribute".'),
      description: z
        .string()
        .optional()
        .describe('The diagnostic message; quoted names are read from it.'),
      xpath: z.string().describe('Where the problem is, e.g. "/w:document[1]/w:body[1]/w:p[1]".'),
      partUri: z.string().optional().describe('The part inside the package, echoed back.'),
      profile: PROFILE,
    },
  },
  ({id, description, xpath, partUri, profile = 'transitional'}) =>
    reply(explainDiagnostic(graph, {id, description, xpath, partUri}, {profile})),
);

await server.connect(new StdioServerTransport());
