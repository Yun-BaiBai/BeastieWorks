import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hardKillTree } from '../procKill';
import type { SignInFlow } from '../../shared/v8/agents';

/**
 * Signing in to Antigravity's ACP server (agy_acp_server) from the roster, with the person's own Google account.
 *
 * The way T3 Code does it (MIT, apps/server/src/provider/antigravityAuthSupport.ts), without its Effect plumbing:
 * the server's own settings name the sign-in kind (`auth.type = oauth-personal`), the app asks it to `authenticate`
 * over ACP, and the server prints "Open the following link to authenticate the ACP server: <url>" (and opens the
 * browser itself). The person signs in on Google's page; the server's answer to `authenticate` says it is done. The
 * token stays in the server's own folder (file storage, as T3 Code forces it); the app never sees it.
 */

export const AUTH_PREFIX = 'Open the following link to authenticate the ACP server: ';
const MAX_LINE = 20_000;

/** The server's own folder for its settings and token: ~/.gemini/antigravity-acp (GEMINI_HOME moves ~/.gemini). */
export function antigravityAcpDir(env: NodeJS.ProcessEnv): string {
  const home = env.GEMINI_HOME || path.join(env.USERPROFILE || env.HOME || '', '.gemini');
  return path.join(home, 'antigravity-acp');
}

/** Whether it holds a sign-in already (the token file the server writes with file storage). */
export function antigravitySignedIn(env: NodeJS.ProcessEnv): boolean {
  return existsSync(path.join(antigravityAcpDir(env), 'acp_token.json'));
}

/** A Google sign-in page, https only, with a 127.0.0.1 callback (T3 Code's parseAntigravityAuthorizationUrl, loosely). */
export function antigravityAuthUrl(line: string): string | null {
  if (!line.startsWith(AUTH_PREFIX)) return null;
  try {
    const url = new URL(line.slice(AUTH_PREFIX.length).trim());
    if (url.protocol !== 'https:' || !/(^|\.)google\.com$/.test(url.hostname) || url.username || url.password) return null;
    const back = url.searchParams.get('redirect_uri');
    if (back && !/^http:\/\/(127\.0\.0\.1|localhost):\d{4,5}\/?/.test(back)) return null;
    return url.href;
  } catch { return null; }
}

export interface AgentLaunch { command: string; args: string[]; env?: Record<string, string> }

interface Flow { status: SignInFlow; child: ChildProcessWithoutNullStreams | null; timers: NodeJS.Timeout[] }

export class AntigravityLogin {
  private flow: Flow | null = null;
  constructor(private readonly o: { launch: () => AgentLaunch | null; env: () => NodeJS.ProcessEnv; onSignedIn?: () => void; linkTimeoutMs?: number; lifetimeMs?: number }) {}

  async start(): Promise<SignInFlow> {
    if (this.flow?.status.phase === 'waiting') return { ...this.flow.status };
    const launch = this.o.launch();
    if (!launch) throw new Error('这台电脑上还没装 Antigravity 的接入程序。');
    const env = { ...this.o.env(), ...(launch.env ?? {}), AGY_ACP_FORCE_FILE_STORAGE: '1', PYTHONUNBUFFERED: '1' };
    if (antigravitySignedIn(env)) return { phase: 'succeeded', flowId: randomUUID(), url: null, message: null };
    // The sign-in kind goes in the server's own settings (an existing setting other than this one is kept as it is).
    const dir = antigravityAcpDir(env), file = path.join(dir, 'settings.json');
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* none yet */ }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ ...settings, auth: { type: 'oauth-personal' } }, null, 2));

    const flow: Flow = { status: { phase: 'waiting', flowId: randomUUID(), url: null, message: null }, child: null, timers: [] };
    this.flow = flow;
    return new Promise<SignInFlow>(resolve => {
      const ready = () => resolve({ ...flow.status });
      flow.timers.push(setTimeout(() => { this.finish(flow, 'failed', 'Antigravity 没有及时给出登录网址。确认能连上 Google，再试一次。'); ready(); }, this.o.linkTimeoutMs ?? 60_000));
      flow.timers.push(setTimeout(() => this.finish(flow, 'expired', '登录超时了，重新点"去登录"。'), this.o.lifetimeMs ?? 15 * 60_000));
      let child: ChildProcessWithoutNullStreams;
      try { child = spawn(launch.command, launch.args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { this.finish(flow, 'failed', 'Antigravity 启动不了。'); ready(); return; }
      flow.child = child;
      const send = (m: Record<string, unknown>) => { try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); } catch { /* closed */ } };
      const line = (text: string) => {
        if (flow.status.phase !== 'waiting' || text.length > MAX_LINE) return;
        const url = antigravityAuthUrl(text.trim());
        if (url && !flow.status.url) { flow.status = { ...flow.status, url }; clearTimeout(flow.timers[0]); ready(); return; }
        let m: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try { m = JSON.parse(text) as typeof m; } catch { return; }
        if (m.id === 1) {
          if (m.error) { this.finish(flow, 'failed', 'Antigravity 没回应握手。'); ready(); return; }
          send({ id: 2, method: 'authenticate', params: { methodId: 'oauth-personal' } });
        } else if (m.id === 2) {
          if (m.error) { this.finish(flow, 'failed', '没登录上：' + String(m.error.message ?? '原因没说').slice(0, 200)); ready(); return; }
          this.finish(flow, 'succeeded');
          this.o.onSignedIn?.();
          ready();
        }
      };
      const reader = (stream: NodeJS.ReadableStream) => {
        let buf = '';
        stream.on('data', (d: Buffer) => {
          buf += d.toString('utf8');
          if (buf.length > MAX_LINE * 4) buf = buf.slice(-MAX_LINE);
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
        });
      };
      reader(child.stdout); reader(child.stderr);
      child.once('error', () => { this.finish(flow, 'failed', 'Antigravity 启动不了。'); ready(); });
      child.once('close', () => { if (flow.child === child) flow.child = null; this.finish(flow, 'failed', 'Antigravity 在登录完成前停了。'); ready(); });
      send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'beastie-works', version: '0' }, clientCapabilities: {} } });
    });
  }

  complete(): SignInFlow { throw new Error('Antigravity 登录不用在这里贴代码：在打开的 Google 页面上登录就行。'); }
  current(flowId: string): SignInFlow | null { return this.flow?.status.flowId === flowId ? { ...this.flow.status } : null; }
  cancel(): void { if (this.flow) this.finish(this.flow, 'cancelled', '已取消。'); }

  private finish(flow: Flow, phase: Exclude<SignInFlow['phase'], 'waiting'>, message?: string): void {
    if (flow.status.phase !== 'waiting') return;
    for (const t of flow.timers) clearTimeout(t);
    flow.status = { phase, flowId: flow.status.flowId, url: null, message: phase === 'succeeded' ? null : message ?? null };
    const child = flow.child;
    flow.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (child.pid) hardKillTree(child.pid); else try { child.kill(); } catch { /* gone */ }
    }
  }
}
