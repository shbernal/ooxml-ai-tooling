/**
 * XSD -> a light, normalised AST.
 *
 * Build-time only. `build/` is never vendored into a surface, so a dev
 * dependency is fine here — `@rgrove/parse-xml` yields an ordered
 * `{name, attributes, children}` tree, and order is semantic in XSD: the
 * children of an `xsd:sequence` are the legal child order.
 *
 * This module deliberately does no resolution. It turns bytes into a tree and
 * canonicalises QNames; deciding what a reference *points at* is ingest.mjs's
 * job, and it cannot be done file-by-file anyway because references cross
 * files freely.
 */
import {readdirSync, readFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {parseXml} from '@rgrove/parse-xml';

const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

/**
 * The `xml` prefix is bound by the XML spec itself and is never declared — no
 * `xmlns:xml` appears in any of these files, yet `shared-math.xsd` refers to
 * `xml:space`. Treating an undeclared prefix as an error is right; treating
 * this one as undeclared is not.
 */
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
 * Prefixes whose symbols are named but never defined here: XSD built-ins and
 * the XML namespace's own attributes. References to them resolve to NULL by
 * design, which is why the integrity assertions exempt exactly these two.
 */
export const FOREIGN_PREFIXES = ['xsd', 'xml'];

export const isForeign = (qname) =>
  qname !== null && qname !== undefined && FOREIGN_PREFIXES.some((p) => qname.startsWith(`${p}:`));

/**
 * Transitional spells a vocabulary `…openxmlformats.org/<area>/2006/<name>`,
 * Strict spells the same one `…purl.oclc.org/ooxml/<area>/<name>`. Neither
 * spelling is the identity — the file stem is (see schema.sql) — so this maps a
 * namespace URI to the vocabulary key it belongs to, which is what lets a QName
 * in one profile resolve to a symbol shared with the other.
 *
 * Built from the files themselves rather than hardcoded: every schema declares
 * its own `targetNamespace`, so the mapping is observed, and a future edition
 * that renames a namespace needs no change here.
 */
export function buildNamespaceIndex(profileDirs) {
  const byUri = new Map(); // uri -> vocabulary key
  for (const dir of profileDirs) {
    for (const file of listSchemaFiles(dir)) {
      const {targetNamespace, vocabulary} = readSchemaHeader(file);
      const seen = byUri.get(targetNamespace);
      if (seen !== undefined && seen !== vocabulary) {
        throw new Error(
          `namespace ${targetNamespace} maps to two vocabularies: ${seen} and ${vocabulary}`,
        );
      }
      byUri.set(targetNamespace, vocabulary);
    }
  }
  return byUri;
}

export function listSchemaFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.xsd'))
    .sort()
    .map((f) => join(dir, f));
}

/** The vocabulary key is the file stem: `wml.xsd` -> `wml`. */
export function vocabularyOf(path) {
  return basename(path, '.xsd');
}

function readSchemaHeader(path) {
  const root = parseDocument(path);
  return {
    targetNamespace: root.attributes.targetNamespace,
    vocabulary: vocabularyOf(path),
  };
}

function parseDocument(path) {
  // Read as a string and let the XML parser handle line endings. The vendored
  // XSDs are CRLF as published (part 02) and nothing here may split on '\n' —
  // that is the one Windows-shaped bug this corpus can actually produce.
  let text = readFileSync(path, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // the OPC set is BOM'd
  const doc = parseXml(text);
  const root = doc.root;
  if (localName(root.name) !== 'schema') {
    throw new Error(`${path}: root element is ${root.name}, expected xsd:schema`);
  }
  return root;
}

function localName(qname) {
  const i = qname.indexOf(':');
  return i === -1 ? qname : qname.slice(i + 1);
}

/** Element children only — the parser also yields text and comment nodes. */
export function elements(node) {
  return node.children.filter((c) => c.type === 'element');
}

/** `xsd:sequence` -> `sequence`, after checking the prefix really is the XSD one. */
export function xsdName(node, prefixes) {
  const i = node.name.indexOf(':');
  const prefix = i === -1 ? null : node.name.slice(0, i);
  const uri = prefixes.get(prefix);
  return uri === XSD_NS ? node.name.slice(i + 1) : null;
}

/**
 * Parse one schema file into the shape ingest.mjs consumes.
 *
 * `namespaceIndex` maps URI -> vocabulary key, so every QName comes back
 * already canonicalised as `vocabularyKey:localName` (or `xsd:localName` for a
 * built-in). Canonicalising here rather than at each use site is what keeps the
 * profile-independence of `symbols.type_ref` a property of the data instead of
 * a rule everyone has to remember.
 */
export function parseSchema(path, namespaceIndex) {
  const root = parseDocument(path);
  const vocabulary = vocabularyOf(path);
  const targetNamespace = root.attributes.targetNamespace;

  // Namespace bindings, including the default one under the key `null`. The
  // conventional prefix for *this* schema's own namespace is deliberately not
  // derived here: a schema usually binds its target namespace to the default
  // `xmlns=` and never names a prefix for it, so the evidence lives in the
  // files that import it. See `observedPrefixes` in ingest.mjs.
  const prefixes = new Map();
  for (const [name, value] of Object.entries(root.attributes)) {
    if (name === 'xmlns') prefixes.set(null, value);
    else if (name.startsWith('xmlns:')) prefixes.set(name.slice(6), value);
  }

  /** A QName as written in this file -> `vocabularyKey:localName`. */
  const canonical = (qname) => {
    if (qname === undefined || qname === null) return null;
    const i = qname.indexOf(':');
    const prefix = i === -1 ? null : qname.slice(0, i);
    const local = i === -1 ? qname : qname.slice(i + 1);
    const uri =
      prefixes.get(prefix) ??
      (prefix === null ? targetNamespace : prefix === 'xml' ? XML_NS : undefined);
    if (uri === XSD_NS) return `xsd:${local}`;
    if (uri === XML_NS) return `xml:${local}`;
    const vocab = namespaceIndex.get(uri);
    if (vocab === undefined) {
      throw new Error(`${path}: QName ${qname} resolves to unknown namespace ${uri}`);
    }
    return `${vocab}:${local}`;
  };

  return {
    path,
    vocabulary,
    targetNamespace,
    prefixes,
    root,
    canonical,
    name: (node) => xsdName(node, prefixes),
  };
}

/**
 * `minOccurs`/`maxOccurs` as integers, with -1 for `unbounded`.
 *
 * Both default to 1 when absent, per the XSD spec — an omitted `minOccurs` is
 * `1` (required), not `0`, and getting that backwards would silently mark every
 * required child optional.
 */
export function occurs(node) {
  const min = node.attributes.minOccurs;
  const max = node.attributes.maxOccurs;
  return {
    min: min === undefined ? 1 : Number.parseInt(min, 10),
    max: max === undefined ? 1 : max === 'unbounded' ? -1 : Number.parseInt(max, 10),
  };
}
