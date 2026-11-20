import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { HostTool, HostToolResult } from './shell';

/**
 * The app's side of `host-tool-relay.cjs`: one loopback HTTP server for the whole app. Each agent session registers
 * its own tools under a fresh token; the relay the agent starts asks here for the list and for each call. Only
 * 127.0.0.1, only with the token, and a token stops working when its session closes.
 */

interface Seat { tools: HostTool[]; call(name: string, args: unknown): Promise<HostToolResult> }

let server: Server | null = null;
let port: Promise<number> | null = null;
const seats = new Map<string, Seat>();
const MAX_BODY = 4 * 1024 * 1024;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function listen(): Promise<number> {
  port ??= new Promise<number>((resolve, reject) => {
    server = createServer((req, res) => {
      const answer = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const key = [...seats.keys()].find(k => same(k, auth));
      const seat = key ? seats.get(key) : undefined;
      if (req.method !== 'POST' || !seat) { answer(403, { error: 'not allowed' }); req.resume(); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { answer(413, { error: 'too large' }); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        let body: { op?: unknown; name?: unknown; args?: unknown };
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body; } catch { answer(400, { error: 'bad json' }); return; }
        if (body.op === 'list') {
          answer(200, { tools: seat.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
          return;
        }
        if (body.op === 'call' && typeof body.name === 'string') {
          seat.call(body.name, body.args ?? {}).then(
            r => answer(200, r.ok ? { ok: true, text: r.text } : { ok: false, text: r.error }),
            err => answer(200, { ok: false, text: err instanceof Error ? err.message : String(err) }),
          );
          return;
        }
        answer(400, { error: 'unknown op' });
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (addr && typeof addr === 'object') resolve(addr.port); else reject(new Error('V8_TOOL_BRIDGE_NO_PORT'));
    });
    server.unref();
  });
  return port;
}

/**
 * The copy of a packaged file that sits outside the app's archive (electron-builder's asarUnpack). A file another
 * program runs (the relay an agent starts, the npm that installs agents) must be a real file on disk.
 */
export function outsideAsar(file: string): string {
  return file.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
}

/** Where the relay script is: next to the built main file, or next to this source file in tests. */
export function relayScript(): string {
  const here = path.join(__dirname, 'host-tool-relay.cjs');
  if (existsSync(here)) return outsideAsar(here);
  return path.join(__dirname, 'v8', 'host-tool-relay.cjs');
}

export interface ToolSeat {
  /** The ACP `mcpServers` entry that makes the agent start the relay for this session. */
  server: { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };
  close(): void;
}

/** Register one session's tools. `node` runs the relay script (Electron as Node in the app). */
export async function openToolSeat(tools: HostTool[], call: Seat['call'], node: { command: string; env?: Record<string, string> }): Promise<ToolSeat> {
  const p = await listen();
  const token = randomBytes(24).toString('hex');
  seats.set(token, { tools, call });
  const env = { ...(node.env ?? {}), BEASTIE_TOOLS_URL: `http://127.0.0.1:${p}/`, BEASTIE_TOOLS_TOKEN: token };
  return {
    server: { name: 'beastie', command: node.command, args: [relayScript()], env: Object.entries(env).map(([name, value]) => ({ name, value })) },
    close: () => { seats.delete(token); },
  };
}
