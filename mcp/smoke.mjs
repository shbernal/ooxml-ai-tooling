#!/usr/bin/env node
/**
 * Drive the MCP server over a real stdio JSON-RPC session.
 *
 * The core suite tests the core. It cannot test the transport, the tool
 * registrations, or the zod schemas — and those are exactly what breaks a
 * client without breaking a single unit test. This spawns the actual binary and
 * talks to it the way an MCP client does.
 *
 * Run: `make smoke`.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'src', 'server.mjs');

const child = spawn(process.execPath, [SERVER], {stdio: ['pipe', 'pipe', 'pipe']});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const pending = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  // Newline-delimited JSON, one message per line.
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line !== '') {
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve !== undefined) {
        pending.delete(message.id);
        resolve(message);
      }
    }
    newline = buffer.indexOf('\n');
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
    setTimeout(() => reject(new Error(`${method} timed out`)), 15000).unref();
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method, params})}\n`);
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

const init = await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: {name: 'smoke', version: '0'},
});
notify('notifications/initialized', {});

check('handshake names the server', () => {
  assert.equal(init.result.serverInfo.name, 'ooxml');
});

const listed = await request('tools/list', {});
const toolNames = listed.result.tools.map((t) => t.name).sort();

check('every tool is registered', () => {
  assert.deepEqual(toolNames, [
    'ooxml_attributes',
    'ooxml_children',
    'ooxml_diff_profiles',
    'ooxml_element',
    'ooxml_enum',
    'ooxml_explain',
    'ooxml_namespace',
    'ooxml_search',
    'ooxml_type',
    'ooxml_values',
  ]);
});

const call = async (name, args) => {
  const response = await request('tools/call', {name, arguments: args});
  assert.ok(
    response.result !== undefined,
    `${name} returned an error: ${JSON.stringify(response.error)}`,
  );
  return JSON.parse(response.result.content[0].text);
};

const element = await call('ooxml_element', {qname: 'w:tbl'});
check('ooxml_element answers through the transport', () => {
  assert.equal(element.found, true);
  assert.equal(element.symbols[0].qname, 'w:tbl');
});

const children = await call('ooxml_children', {qname: 'a:CT_SolidColorFillProperties'});
check('ooxml_children expands groups through the transport', () => {
  assert.ok(children.order.some((c) => c.qname === 'a:srgbClr'));
});

const values = await call('ooxml_values', {qname: 's:ST_TwipsMeasure'});
check('ooxml_values resolves a union', () => {
  assert.equal(values.one_of.length, 2);
});

const strict = await call('ooxml_element', {qname: 'w:tbl', profile: 'strict'});
check('the profile argument reaches the core', () => {
  assert.match(strict.symbols[0].namespace.uri, /purl\.oclc\.org/);
});

const explained = await call('ooxml_explain', {
  id: 'Sch_UndeclaredAttribute',
  description: "The 'bogus' attribute is not declared.",
  xpath: '/w:document[1]/w:body[1]/w:p[1]/w:pPr[1]/w:ind[1]',
});
check('ooxml_explain resolves a diagnostic', () => {
  assert.equal(explained.resolved, true);
  assert.equal(explained.legal.type, 'w:CT_Ind');
});

const missing = await call('ooxml_element', {qname: 'w:notARealElement'});
check('a miss is a normal result, not a protocol error', () => {
  assert.equal(missing.found, false);
  assert.equal(missing.reason, 'unknown_symbol');
});

check('nothing was written to stderr', () => {
  // The experimental SQLite warning would land here. On an stdio transport that
  // is at best confusing in a client's log, so the filter has to hold.
  assert.equal(stderr.trim(), '', `unexpected stderr:\n${stderr}`);
});

child.stdin.end();
child.kill();

let failed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

console.log(
  failed === 0 ? `\n${checks.length} checks passed` : `\n${failed} of ${checks.length} failed`,
);
process.exit(failed === 0 ? 0 : 1);
