'use strict';
// The app's own tools, as an MCP server an agent starts over stdio (the way OpenMausBot's harness-mcp-proxy.ts,
// T3 Code and LobeHub hand their tools to an ACP agent). It holds nothing itself: the tool list and every call go
// to the app over loopback HTTP, with a token only this one session knows.
//   BEASTIE_TOOLS_URL    http://127.0.0.1:<port>/
//   BEASTIE_TOOLS_TOKEN  the session's token
const http = require('node:http');

const url = process.env.BEASTIE_TOOLS_URL || '';
const token = process.env.BEASTIE_TOOLS_TOKEN || '';
const MAX_LINE = 4 * 1024 * 1024;

const write = message => process.stdout.write(JSON.stringify(message) + '\n');
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

function ask(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: 'Bearer ' + token } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const out = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.statusCode === 200 ? resolve(out) : reject(new Error(out.error || 'HTTP ' + res.statusCode));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function handle(m) {
  const id = m.id;
  switch (m.method) {
    case 'initialize':
      return write({ jsonrpc: '2.0', id, result: {
        protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'beastie', version: '1' },
      } });
    case 'ping':
      return write({ jsonrpc: '2.0', id, result: {} });
    case 'tools/list': {
      const r = await ask({ op: 'list' });
      return write({ jsonrpc: '2.0', id, result: { tools: r.tools } });
    }
    case 'tools/call': {
      const p = m.params || {};
      const r = await ask({ op: 'call', name: p.name, args: p.arguments || {} });
      return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], isError: !r.ok } });
    }
    default:
      if (id !== undefined && id !== null) fail(id, -32601, 'Method not found: ' + m.method);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > MAX_LINE) { process.exitCode = 1; process.stdin.destroy(); return; }
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); continue; }
    handle(m).catch(e => { if (m.id !== undefined && m.id !== null) fail(m.id, -32603, 'The app did not answer: ' + (e && e.message || e)); });
  }
});
process.stdin.on('end', () => process.exit(0));
