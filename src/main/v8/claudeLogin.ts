import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { hardKillTree } from '../procKill';
import type { SignInFlow } from '../../shared/v8/agents';

/**
 * Signing in to Claude Code from the roster page.
 *
 * Ported from OpenMausBot (Apache-2.0) `server/drivers/claude-login-auth.ts`: the unmodified `claude auth login` runs
 * with pipes; only its Anthropic sign-in link is shown; if Anthropic's page gives a code, the person pastes it and it
 * goes to the program's input; `claude auth status --json` confirms. The app never sees or stores a credential.
 * Anthropic allows an end user to sign in to the unmodified program with their own subscription.
 *
 * On a desktop the program also opens the person's browser by itself and may finish without any code.
 */

export interface ClaudeCli { command: string; args: string[] }

/** Where Anthropic's sign-in lives. Any other link in the program's output is not shown. */
const SIGN_IN_HOSTS = ['claude.com', 'claude.ai', 'console.anthropic.com', 'platform.claude.com'];
const MAX_OUTPUT = 32_768;

export function claudeSignInLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const trusted = SIGN_IN_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
    return url.protocol === 'https:' && trusted && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** The first trusted sign-in link on a finished line of output. */
export function claudeLoginPrompt(output: string): string | null {
  for (const line of stripVTControlCharacters(output).split(/\r?\n/).slice(0, -1)) {
    const match = /(https:\/\/\S+)/.exec(line.trim());
    const link = match ? claudeSignInLink(match[1].replace(/[),.;]+$/, '')) : null;
    if (link) return link;
  }
  return null;
}

/** What Anthropic's page shows after sign-in: a code, sometimes with `#state`. */
export function claudeLoginCode(value: string): string | null {
  const code = value.trim();
  return /^[A-Za-z0-9_\-#.:]{8,1024}$/.test(code) ? code : null;
}

interface Flow {
  status: SignInFlow;
  child: ChildProcessWithoutNullStreams | null;
  output: string;
  codeSent: boolean;
  timers: NodeJS.Timeout[];
}

export class ClaudeLogin {
  private flow: Flow | null = null;

  constructor(private readonly o: { cli: () => ClaudeCli | null; env: () => NodeJS.ProcessEnv; onSignedIn?: () => void; linkTimeoutMs?: number; lifetimeMs?: number }) {}

  /** Start a sign-in, or return the one already running. Resolves once the link is known (or the account turns out to be signed in already). */
  async start(): Promise<SignInFlow> {
    if (this.flow?.status.phase === 'waiting') return { ...this.flow.status };
    const cli = this.o.cli();
    if (!cli) throw new Error('这台电脑上没找到 Claude 的程序。');
    const env = { ...this.o.env(), NO_COLOR: '1' };
    // Never replace a working sign-in because the button was clicked again.
    if (await status(cli, env) === 'in') return { phase: 'succeeded', flowId: randomUUID(), url: null, message: null };

    const flow: Flow = { status: { phase: 'waiting', flowId: randomUUID(), url: null, message: null }, child: null, output: '', codeSent: false, timers: [] };
    this.flow = flow;
    return new Promise<SignInFlow>(resolve => {
      const ready = () => resolve({ ...flow.status });
      flow.timers.push(setTimeout(() => { this.finish(flow, 'failed', 'Claude 没有及时给出登录网址。确认它装好了、能联网，再试一次。'); ready(); }, this.o.linkTimeoutMs ?? 30_000));
      flow.timers.push(setTimeout(() => this.finish(flow, 'expired', '登录网址过期了，重新点"去登录"。'), this.o.lifetimeMs ?? 15 * 60_000));
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(cli.command, [...cli.args, 'auth', 'login'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        this.finish(flow, 'failed', 'Claude 启动不了。');
        ready();
        return;
      }
      flow.child = child;
      const receive = (chunk: Buffer) => {
        if (flow.status.phase !== 'waiting') return;
        if (flow.output.length + chunk.length > MAX_OUTPUT) { this.finish(flow, 'failed', 'Claude 的回应看不懂，更新它再试。'); ready(); return; }
        flow.output += chunk.toString('utf8');
        if (flow.status.url) return;
        const url = claudeLoginPrompt(flow.output);
        if (!url) return;
        flow.status = { ...flow.status, url };
        clearTimeout(flow.timers[0]);
        ready();
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.once('error', () => { this.finish(flow, 'failed', 'Claude 启动不了。'); ready(); });
      child.once('close', code => {
        if (flow.child === child) flow.child = null;
        if (flow.status.phase !== 'waiting') return;
        const said = stripVTControlCharacters(flow.output);
        void status(cli, env).then(s => {
          if (s === 'in') { this.finish(flow, 'succeeded'); this.o.onSignedIn?.(); }
          else this.finish(flow, 'failed', flow.codeSent && /invalid|expired|denied|rejected/i.test(said)
            ? 'Anthropic 没接受这串代码。重新点"去登录"，把页面上的代码整串贴过来。'
            : code === 0 ? 'Claude 结束了，但没有登录上。再试一次。' : 'Claude 在登录完成前停了。检查网络再试。');
          ready();
        });
      });
    });
  }

  /** Hand the code from Anthropic's page to the waiting program. */
  complete(flowId: string, pasted: string): SignInFlow {
    const flow = this.flow;
    if (!flow || flow.status.flowId !== flowId || flow.status.phase !== 'waiting' || !flow.child) throw new Error('这次登录已经结束了，重新点"去登录"。');
    if (flow.codeSent) throw new Error('代码已经交过了，等结果。');
    const code = claudeLoginCode(pasted);
    if (!code) throw new Error('把登录后页面上显示的那一整串代码贴过来。');
    flow.codeSent = true;
    flow.child.stdin.write(`${code}\n`);
    return { ...flow.status };
  }

  /** Where the sign-in stands, for the page to poll. */
  current(flowId: string): SignInFlow | null {
    return this.flow?.status.flowId === flowId ? { ...this.flow.status } : null;
  }

  cancel(): void {
    if (this.flow) this.finish(this.flow, 'cancelled', '已取消。');
  }

  private finish(flow: Flow, phase: Exclude<SignInFlow['phase'], 'waiting'>, message?: string): void {
    if (flow.status.phase !== 'waiting') return;
    for (const t of flow.timers) clearTimeout(t);
    flow.status = { phase, flowId: flow.status.flowId, url: null, message: phase === 'succeeded' ? null : message ?? null };
    flow.output = '';
    const child = flow.child;
    flow.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (child.pid) hardKillTree(child.pid); else try { child.kill(); } catch { /* gone */ }
    }
  }
}

/** `claude auth status --json`: only a clear yes or no counts. */
function status(cli: ClaudeCli, env: NodeJS.ProcessEnv): Promise<'in' | 'out' | 'unknown'> {
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(cli.command, [...cli.args, 'auth', 'status', '--json'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch { resolve('unknown'); return; }
    child.stdin.end();
    let out = '';
    child.stdout.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString('utf8'); });
    child.stderr.resume();
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve('unknown'); }, 8000);
    child.once('error', () => { clearTimeout(timer); resolve('unknown'); });
    child.once('close', () => {
      clearTimeout(timer);
      try {
        const s = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { loggedIn?: unknown };
        resolve(s.loggedIn === true ? 'in' : s.loggedIn === false ? 'out' : 'unknown');
      } catch { resolve('unknown'); }
    });
  });
}
