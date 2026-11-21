import { tr } from '../../shared/i18n';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { hardKillTree } from '../procKill';
import type { SignInFlow } from '../../shared/v8/agents';
import type { SignIn } from './agentSignIn';
import { grokSignedIn, kimiSignedIn } from './moreAgents';
import { cursorStatus, exec, MAX_OUTPUT, type DeviceCli } from './cursorStatus';
export type { DeviceCli } from './cursorStatus';

/**
 * A9: signing in to Grok, Kimi and Cursor from the roster page, with each one's own sign-in command.
 *
 * Ported from OpenMausBot (Apache-2.0): `shared/device-sign-in.ts` (the rules for reading the page and the code out of
 * each program's output, never turning anything else into a link) and `server/drivers/device-auth.ts` with the specs
 * in `server/drivers/acp/{grok,kimi,cursor}.ts`.
 * - Grok (`grok login --device-auth`) and Kimi (`kimi-code login`) print a page and a one-time code: the person opens
 *   the page, signs in with their own account and types the code there.
 * - Cursor (`cursor-agent login`, told not to open a browser) prints one link that finishes the sign-in; the app opens
 *   it in the browser, and there is no code.
 * The program finishes by itself and its sign-in is checked again. The app never sees a password or a token.
 */

export type DeviceProvider = 'grok' | 'kimi' | 'cursor';
type Env = NodeJS.ProcessEnv;

/** An https page on one of the provider's hosts, with no login, port or fragment. */
function providerPage(value: string, hosts: RegExp): URL | null {
  if (!/^https:\/\/[^\s#]+$/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  return url.username || url.password || url.port || !hosts.test(url.hostname) ? null : url;
}

const RULES: Record<DeviceProvider, { page(value: string): string | null; code: RegExp | null; label?: RegExp }> = {
  grok: {
    // xAI's own hosts. The page may carry the code itself; nothing else may ride in its query.
    page: value => {
      const url = providerPage(value, /(^|\.)(x\.ai|grok\.com)$/);
      return url && [...url.searchParams.keys()].every(k => k === 'user_code') ? url.href : null;
    },
    code: /^[A-Z0-9]{4,12}(?:-[A-Z0-9]{2,12}){0,3}$/,
  },
  kimi: {
    // Moonshot's hosts for both regions; only the code is kept of the query. kimi-code prints
    // "…device login: <page>" and "…enter code: <code>".
    page: value => {
      const url = providerPage(value, /(^|\.)kimi\.(com|ai)$/);
      if (!url) return null;
      const code = url.searchParams.get('user_code');
      url.search = '';
      if (code !== null) url.searchParams.set('user_code', code);
      return url.href;
    },
    code: /^[A-Z0-9]{4,12}(?:-[A-Z0-9]{2,12}){0,3}$/,
    label: /^[^:]*\b(?:login|code):\s+/i,
  },
  cursor: {
    // "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?…": the query names the sign-in
    // request (a PKCE challenge and a request id), never a token; only those and Cursor's own flags may ride in it.
    page: value => {
      const url = providerPage(value, /^(www\.)?cursor\.com$/);
      if (!url || url.pathname !== '/loginDeepControl') return null;
      const keys = [...url.searchParams.keys()];
      const known = keys.every(k => ['challenge', 'uuid', 'mode', 'redirectTarget', 'supportsSelectedTeamLogin'].includes(k));
      const request = /^[\w-]{16,128}$/.test(url.searchParams.get('challenge') ?? '') && /^[\w-]{8,64}$/.test(url.searchParams.get('uuid') ?? '');
      return known && request && new Set(keys).size === keys.length ? url.href : null;
    },
    code: null,
    label: /^[^:]*\blink:\s+/i,
  },
};

/** The newest page and code, once both lines have arrived whole (the last, unfinished line is never read). */
export function devicePrompt(provider: DeviceProvider, text: string): { url: string; code: string | null } | null {
  const { page, label, code } = RULES[provider];
  const lines = text.split(/\r?\n/).slice(0, -1).map(l => (label ? l.trim().replace(label, '') : l.trim()));
  let found: { url: string; code: string | null } | null = null;
  for (const [at, line] of lines.entries()) {
    const url = page(line);
    if (url === null) continue;
    if (!code) { found = { url, code: null }; continue; }
    const userCode = lines.slice(at + 1).map(n => n.replace(/^code:\s*/i, '')).find(n => code.test(n));
    // A code carried in the page's link must be that same code.
    if (userCode && [...new URL(url).searchParams.values()].every(v => v === userCode)) found = { url, code: userCode };
  }
  return found;
}

/** Whether the person is signed in: files where the program keeps its sign-in, or its own status command. */
export interface DeviceSpec {
  provider: DeviceProvider;
  name: string;
  /** The arguments the official list starts it with for ACP; what is left is the program itself. */
  acpArgs: string[];
  loginArgs: string[];
  env?: Record<string, string>;
  /** One plain sentence for a failed sign-in; never the program's own words, which may carry tokens. */
  failure(output: string): string;
  signedIn(cli: DeviceCli, env: Env): Promise<SignIn> | SignIn;
}


export const DEVICE_SPECS: Record<string, DeviceSpec> = {
  'grok-build': {
    provider: 'grok', name: 'Grok', acpArgs: ['agent', 'stdio'], loginArgs: ['login', '--device-auth'],
    failure: out => /(unexpected argument|unrecognized (argument|option)|unknown option).*device-(auth|code)/i.test(out) ? tr('这个 Grok 程序太旧，不支持输码登录。在 agent 名单里更新 Grok 再试。')
      : /device-code login is not available/i.test(out) ? tr('这个 Grok 账号不能输码登录，要改用 xAI 的 API Key。')
      : /expired/i.test(out) ? tr('登录代码过期了，重新点"去登录"拿一个新的。')
      : /denied|rejected/i.test(out) ? tr('你在网页上拒绝了这次登录。要登录的话重新点"去登录"。')
      : tr('没登录上。检查网络再试一次。'),
    signedIn: (_cli, env) => grokSignedIn(env),
  },
  'kimi-code': {
    provider: 'kimi', name: 'Kimi', acpArgs: ['acp'], loginArgs: ['login'],
    failure: out => /expired|timed out/i.test(out) ? tr('登录代码过期了，重新点"去登录"拿一个新的。')
      : /denied|login cancelled/i.test(out) ? tr('你在网页上拒绝了这次登录。要登录的话重新点"去登录"。')
      : tr('没登录上。检查网络再试一次。'),
    signedIn: (_cli, env) => kimiSignedIn(env),
  },
  cursor: {
    provider: 'cursor', name: 'Cursor', acpArgs: ['acp'], loginArgs: ['login'],
    // It would open a browser by itself; the app opens the link it prints instead, so the link is known to be Cursor's.
    env: { NO_OPEN_BROWSER: '1' },
    failure: out => /expired|timed? ?out/i.test(out) ? tr('登录链接过期了，重新点"去登录"拿一个新的。') : tr('没登录上。检查网络再试一次。'),
    signedIn: async (cli, env) => { const r = await exec(cli, ['status', '--format', 'json'], env); return cursorStatus(r.code, r.output); },
  },
};

/** The program behind an agent's ACP launch: the same command without the ACP arguments. */
export function deviceCli(launch: DeviceCli | null | undefined, spec: DeviceSpec): DeviceCli | null {
  if (!launch) return null;
  const n = spec.acpArgs.length, tail = launch.args.slice(launch.args.length - n);
  if (launch.args.length < n || tail.some((a, i) => a !== spec.acpArgs[i])) return null;
  return { command: launch.command, args: launch.args.slice(0, launch.args.length - n), ...(launch.env ? { env: launch.env } : {}) };
}

interface Flow { status: SignInFlow; child: ChildProcessWithoutNullStreams | null; output: string; timers: NodeJS.Timeout[] }

export class DeviceLogin {
  private flow: Flow | null = null;

  constructor(private readonly o: {
    spec: DeviceSpec;
    cli: () => DeviceCli | null;
    env: () => Env;
    /** Opens a link the program gave (Cursor's, which has no code). */
    open?: (url: string) => void;
    onSignedIn?: () => void;
    linkTimeoutMs?: number;
    lifetimeMs?: number;
  }) {}

  /** Start a sign-in, or return the one already running. Resolves once the page (and code) are known. */
  async start(): Promise<SignInFlow> {
    const { spec } = this.o;
    if (this.flow?.status.phase === 'waiting') return { ...this.flow.status };
    const cli = this.o.cli();
    if (!cli) throw new Error(tr('没找到 {0} 的程序。在 agent 名单里装上 {1} 再登录。', [spec.name, spec.name]));
    const env = { ...this.o.env(), ...(cli.env ?? {}), ...(spec.env ?? {}), NO_COLOR: '1' };
    // Never replace a working sign-in because the button was clicked again.
    if (await spec.signedIn(cli, env) === 'yes') return { phase: 'succeeded', flowId: randomUUID(), url: null, message: null };

    const flow: Flow = { status: { phase: 'waiting', flowId: randomUUID(), url: null, code: null, message: null, paste: false }, child: null, output: '', timers: [] };
    this.flow = flow;
    return new Promise<SignInFlow>(resolve => {
      const ready = () => resolve({ ...flow.status });
      flow.timers.push(setTimeout(() => { this.finish(flow, 'failed', tr('{0} 没有及时给出登录网址。确认它装好了、能联网，再试一次。', [spec.name])); ready(); }, this.o.linkTimeoutMs ?? 30_000));
      flow.timers.push(setTimeout(() => this.finish(flow, 'expired', tr('登录代码过期了，重新点"去登录"。')), this.o.lifetimeMs ?? 15 * 60_000));
      let child: ChildProcessWithoutNullStreams;
      try { child = spawn(cli.command, [...cli.args, ...spec.loginArgs], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { this.finish(flow, 'failed', tr('{0} 启动不了。', [spec.name])); ready(); return; }
      flow.child = child;
      child.stdin.end();
      let told = false;
      const receive = (chunk: Buffer) => {
        if (flow.status.phase !== 'waiting') return;
        if (flow.output.length + chunk.length > MAX_OUTPUT) { this.finish(flow, 'failed', tr('{0} 的回应看不懂，更新它再试。', [spec.name])); ready(); return; }
        flow.output += chunk.toString('utf8');
        const p = devicePrompt(spec.provider, stripVTControlCharacters(flow.output));
        // A program may print a new pair when its code expires (kimi-code does): the newest one is shown.
        if (!p || (p.url === flow.status.url && p.code === flow.status.code)) return;
        flow.status = { ...flow.status, url: p.url, code: p.code };
        if (!p.code && !told) this.o.open?.(p.url);
        if (!told) { told = true; clearTimeout(flow.timers[0]); ready(); }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.once('error', () => { this.finish(flow, 'failed', tr('{0} 启动不了。', [spec.name])); ready(); });
      child.once('close', code => {
        if (flow.child === child) flow.child = null;
        if (flow.status.phase !== 'waiting') return;
        const said = stripVTControlCharacters(flow.output);
        void Promise.resolve(code === 0 && told ? spec.signedIn(cli, env) : 'no' as SignIn).then(s => {
          if (s === 'yes') { this.finish(flow, 'succeeded'); this.o.onSignedIn?.(); }
          else this.finish(flow, 'failed', spec.failure(said));
          ready();
        });
      });
    });
  }

  /** No code is pasted back here: it is typed on the maker's page, or there is none. */
  complete(): SignInFlow { throw new Error(tr('{0} 登录不用在这里贴代码：在打开的网页上照着做就行。', [this.o.spec.name])); }

  current(flowId: string): SignInFlow | null { return this.flow?.status.flowId === flowId ? { ...this.flow.status } : null; }

  cancel(): void { if (this.flow) this.finish(this.flow, 'cancelled', tr('已取消。')); }

  private finish(flow: Flow, phase: Exclude<SignInFlow['phase'], 'waiting'>, message?: string): void {
    if (flow.status.phase !== 'waiting') return;
    for (const t of flow.timers) clearTimeout(t);
    flow.status = { phase, flowId: flow.status.flowId, url: null, code: null, message: phase === 'succeeded' ? null : message ?? null };
    flow.output = '';
    const child = flow.child;
    flow.child = null;
    // A cancelled sign-in must not go on to write a sign-in.
    if (child && child.exitCode === null && child.signalCode === null) {
      if (child.pid) hardKillTree(child.pid); else try { child.kill(); } catch { /* gone */ }
    }
  }
}
