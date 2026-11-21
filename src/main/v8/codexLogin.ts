import { tr } from '../../shared/i18n';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { hardKillTree } from '../procKill';
import type { SignInFlow } from '../../shared/v8/agents';

/**
 * Signing in to Codex from the roster page, with Codex's own device-code sign-in.
 *
 * Ported from OpenMausBot (Apache-2.0) `server/drivers/codex-device-auth.ts` and `shared/device-sign-in.ts`: the
 * unmodified `codex login --device-auth` runs with pipes and prints OpenAI's page and a one-time code; the person opens
 * the page, signs in with their own ChatGPT account and types the code there; the program finishes by itself and
 * `codex login status` confirms. The app shows only that page and that code, and never sees a credential.
 */

export interface CodexCli { command: string; args: string[]; env?: Record<string, string> }

const CODEX_PAGE = 'https://auth.openai.com/codex/device';
const CODE = /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/;
const MAX_OUTPUT = 32_768;

/** OpenAI's device page and the code, once both lines have arrived whole (the last, unfinished line is never read). */
export function codexDevicePrompt(output: string): { url: string; code: string } | null {
  const lines = stripVTControlCharacters(output).split(/\r?\n/).slice(0, -1).map(l => l.trim());
  let found: { url: string; code: string } | null = null;
  for (const [at, line] of lines.entries()) {
    if (!/^https:\/\/auth\.openai\.com\/codex\/device\/?$/.test(line)) continue;
    const code = lines.slice(at + 1).map(l => l.replace(/^code:\s*/i, '')).find(l => CODE.test(l));
    if (code) found = { url: CODEX_PAGE, code };
  }
  return found;
}

/** Plain words for why the sign-in did not finish (OpenMausBot's loginFailure). */
export function codexLoginFailure(output: string): string {
  if (/(unexpected argument|unrecognized (argument|option)|unknown option).*device-auth/i.test(output)) return tr('这个 Codex 程序太旧，不支持网页登录。在 agent 名单里更新 Codex 再试。');
  if (/device.{0,40}(disabled|not enabled|not allowed)|enable.{0,40}device/i.test(output)) return tr('你的 ChatGPT 账号没打开"设备码登录"。在 ChatGPT 的安全设置里打开它（或请工作区管理员允许），再试一次。');
  if (/expired|expiration|timed out/i.test(output)) return tr('登录代码过期了，重新点"去登录"拿一个新的。');
  return tr('没登录上。检查网络、确认 ChatGPT 允许设备码登录，再试一次。');
}

interface Flow { status: SignInFlow; child: ChildProcessWithoutNullStreams | null; output: string; timers: NodeJS.Timeout[] }

export class CodexLogin {
  private flow: Flow | null = null;

  constructor(private readonly o: { cli: () => CodexCli | null; env: () => NodeJS.ProcessEnv; onSignedIn?: () => void; linkTimeoutMs?: number; lifetimeMs?: number }) {}

  /** Start a sign-in, or return the one already running. Resolves once the page and code are known. */
  async start(): Promise<SignInFlow> {
    if (this.flow?.status.phase === 'waiting') return { ...this.flow.status };
    const cli = this.o.cli();
    if (!cli) throw new Error(tr('这台电脑上没有 Codex 程序。在 agent 名单里装上 Codex 再登录。'));
    const env = { ...this.o.env(), ...(cli.env ?? {}), NO_COLOR: '1' };
    // Never replace a working sign-in because the button was clicked again.
    if (await codexStatus(cli, env) === 'in') return { phase: 'succeeded', flowId: randomUUID(), url: null, message: null };

    const flow: Flow = { status: { phase: 'waiting', flowId: randomUUID(), url: null, code: null, message: null }, child: null, output: '', timers: [] };
    this.flow = flow;
    return new Promise<SignInFlow>(resolve => {
      const ready = () => resolve({ ...flow.status });
      flow.timers.push(setTimeout(() => { this.finish(flow, 'failed', tr('Codex 没有及时给出登录网址。确认它装好了、能联网，再试一次。')); ready(); }, this.o.linkTimeoutMs ?? 30_000));
      flow.timers.push(setTimeout(() => this.finish(flow, 'expired', tr('登录代码过期了，重新点"去登录"。')), this.o.lifetimeMs ?? 15 * 60_000));
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(cli.command, [...cli.args, 'login', '--device-auth'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        this.finish(flow, 'failed', tr('Codex 启动不了。')); ready(); return;
      }
      flow.child = child;
      const receive = (chunk: Buffer) => {
        if (flow.status.phase !== 'waiting') return;
        if (flow.output.length + chunk.length > MAX_OUTPUT) { this.finish(flow, 'failed', tr('Codex 的回应看不懂，更新它再试。')); ready(); return; }
        flow.output += chunk.toString('utf8');
        if (flow.status.url) return;
        const p = codexDevicePrompt(flow.output);
        if (!p) return;
        flow.status = { ...flow.status, url: p.url, code: p.code };
        clearTimeout(flow.timers[0]);
        ready();
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.once('error', () => { this.finish(flow, 'failed', tr('Codex 启动不了。')); ready(); });
      child.once('close', () => {
        if (flow.child === child) flow.child = null;
        if (flow.status.phase !== 'waiting') return;
        const said = stripVTControlCharacters(flow.output);
        void codexStatus(cli, env).then(s => {
          if (s === 'in') { this.finish(flow, 'succeeded'); this.o.onSignedIn?.(); }
          else this.finish(flow, 'failed', codexLoginFailure(said));
          ready();
        });
      });
    });
  }

  /** Codex's sign-in needs no code pasted back: the person types it on OpenAI's page. */
  complete(): SignInFlow { throw new Error(tr('Codex 登录不用在这里贴代码：在打开的网页上输入上面那串代码就行。')); }

  current(flowId: string): SignInFlow | null { return this.flow?.status.flowId === flowId ? { ...this.flow.status } : null; }

  cancel(): void { if (this.flow) this.finish(this.flow, 'cancelled', tr('已取消。')); }

  private finish(flow: Flow, phase: Exclude<SignInFlow['phase'], 'waiting'>, message?: string): void {
    if (flow.status.phase !== 'waiting') return;
    for (const t of flow.timers) clearTimeout(t);
    flow.status = { phase, flowId: flow.status.flowId, url: null, code: null, message: phase === 'succeeded' ? null : message ?? null };
    flow.output = '';
    const child = flow.child;
    flow.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (child.pid) hardKillTree(child.pid); else try { child.kill(); } catch { /* gone */ }
    }
  }
}

/** `codex login status`: "Logged in using …" / "Not logged in" (OpenMausBot CODEX_DEVICE_SIGN_IN.status). */
export function codexStatus(cli: CodexCli, env: NodeJS.ProcessEnv): Promise<'in' | 'out' | 'unknown'> {
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(cli.command, [...cli.args, 'login', 'status'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch { resolve('unknown'); return; }
    child.stdin.end();
    let out = '';
    const take = (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString('utf8'); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve('unknown'); }, 8000);
    child.once('error', () => { clearTimeout(timer); resolve('unknown'); });
    child.once('close', code => {
      clearTimeout(timer);
      const said = stripVTControlCharacters(out);
      resolve(code === 0 && /^(?:logged in|api key configured)\b/im.test(said) ? 'in' : code !== 0 && /^not logged in\b/im.test(said) ? 'out' : 'unknown');
    });
  });
}
