import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hardKillTree } from '../procKill';
import type { AgentQuota, QuotaWindow } from '../../shared/v8/agents';
import type { MagpieQuota } from './magpieService';

/**
 * How much quota each agent's account has left and when it starts over, read the way Orca reads it
 * (src/main/rate-limits/providers/claude and …/codex). Reading sends no message to a model and uses no quota.
 *
 * - Claude: the account's usage page, with the sign-in the app's Claude folder already holds
 *   (claude-oauth-usage-request.ts). An expired sign-in is not renewed here: renewing replaces the sign-in, and only
 *   Claude itself should do that (claude-active-usage-fetch.ts); it does so the next time it works.
 * - Codex: its own program answers `account/rateLimits/read` (codex-rpc-rate-limit-probe.ts), started read-only with
 *   plugins off so nothing else runs.
 */

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const SESSION_MIN = 300, WEEK_MIN = 10080;

type Json = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (v: number) => Math.min(100, Math.max(0, v));

/** A reset time in seconds or milliseconds, as a number or an ISO text (claude-usage-window.ts). */
export function resetTime(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (v > 10_000_000_000 ? v : v * 1000) : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

const result = (agentId: string, state: AgentQuota['state'], o: Partial<AgentQuota> = {}): AgentQuota =>
  ({ agentId, state, windows: [], plan: null, note: null, checkedAt: Date.now(), ...o });

/** The Claude usage page's answer as quota windows. */
export function claudeWindows(data: Json): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  const add = (label: string, w: unknown) => {
    const x = (w ?? null) as Json | null;
    const used = num(x?.utilization) ?? num(x?.used_percentage);
    if (used !== null) out.push({ label, usedPercent: pct(used), resetsAt: resetTime(x?.resets_at) });
  };
  add('5 小时', data.five_hour);
  add('本周', data.seven_day);
  // Weekly limits of one model, where the plan has them.
  for (const l of Array.isArray(data.limits) ? data.limits as Json[] : []) {
    const name = ((l?.scope as Json | null)?.model as Json | null)?.display_name;
    if (l?.kind === 'weekly_scoped' && typeof name === 'string' && num(l.percent) !== null) out.push({ label: '本周 · ' + name, usedPercent: pct(num(l.percent)!), resetsAt: resetTime(l.resets_at) });
  }
  return out;
}

export async function readClaudeQuota(configDir: string, fetchImpl: typeof fetch = fetch): Promise<AgentQuota> {
  const id = 'claude-acp';
  let oauth: Json;
  try {
    oauth = ((JSON.parse(readFileSync(path.join(configDir, '.credentials.json'), 'utf8')) as Json).claudeAiOauth ?? {}) as Json;
  } catch {
    return result(id, 'error', { note: '还没登录 Claude，登录后才读得到额度。' });
  }
  const token = typeof oauth.accessToken === 'string' ? oauth.accessToken : '';
  if (!token) return result(id, 'error', { note: '还没登录 Claude，登录后才读得到额度。' });
  const plan = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null;
  let r: Response;
  try {
    r = await fetchImpl(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return result(id, 'error', { plan, note: '连不上 Claude 的额度页，稍后再试。' });
  }
  if (r.status === 401) {
    const refreshable = typeof oauth.refreshToken === 'string' && (num(oauth.refreshTokenExpiresAt) ?? Infinity) > Date.now();
    return result(id, 'error', { plan, note: refreshable ? '登录凭证过期了。Claude 下次干活时会自己续上，之后就读得到。' : '登录过期了，要重新登录 Claude。' });
  }
  if (r.status === 429) return result(id, 'error', { plan, note: 'Claude 的额度页让稍后再查。' });
  if (!r.ok) return result(id, 'error', { plan, note: `Claude 的额度页没给答案（${r.status}）。` });
  const windows = claudeWindows(await r.json() as Json);
  return windows.length ? result(id, 'ok', { plan, windows }) : result(id, 'none', { plan, note: '这个账号没有按时间窗口算的额度。' });
}

/** Codex's `account/rateLimits/read` answer as quota windows. Windows are told apart by their length. */
export function codexWindows(limits: Json | null | undefined): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  for (const w of [limits?.primary, limits?.secondary] as Array<Json | null | undefined>) {
    const used = num(w?.usedPercent);
    if (used === null) continue;
    const mins = num(w?.windowDurationMins);
    const label = mins !== null && Math.abs(mins - SESSION_MIN) <= 1 ? '5 小时'
      : mins !== null && Math.abs(mins - WEEK_MIN) <= 1 ? '本周'
      : mins !== null ? `${Math.round(mins / 60)} 小时` : out.length ? '本周' : '5 小时';
    out.push({ label, usedPercent: pct(used), resetsAt: resetTime(w?.resetsAt) });
  }
  return out;
}

/** Ask the Codex program itself. `command` is codex.exe; the person's own Codex folder holds the sign-in. */
export function readCodexQuota(command: string, env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<AgentQuota> {
  const id = 'codex-acp';
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ['-c', 'approval_policy=never', '-c', 'features.plugins=false', '-s', 'read-only', '-a', 'never', 'app-server'],
        { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve(result(id, 'error', { note: '开不了 Codex 程序。' }));
      return;
    }
    let done = false, buf = '';
    const end = (q: AgentQuota) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.pid) hardKillTree(child.pid); else try { child.kill(); } catch { /* gone */ }
      resolve(q);
    };
    const timer = setTimeout(() => end(result(id, 'error', { note: 'Codex 没在 20 秒内回答。' })), timeoutMs);
    const send = (m: Json) => { try { child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); } catch { /* closed */ } };
    child.on('error', () => end(result(id, 'error', { note: '开不了 Codex 程序。' })));
    child.on('exit', () => end(result(id, 'error', { note: 'Codex 程序还没回答就退出了。' })));
    child.stderr!.resume();
    child.stdout!.on('data', d => {
      buf += String(d);
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m: Json;
        try { m = JSON.parse(line) as Json; } catch { continue; }
        if (m.id === 1) { send({ method: 'initialized', params: {} }); send({ id: 2, method: 'account/rateLimits/read', params: {} }); }
        else if (m.id === 2) {
          if (m.error) {
            const msg = String((m.error as Json).message ?? '');
            end(result(id, 'error', { note: /api.?key/i.test(msg) ? 'Codex 用的是 API 密钥，没有订阅额度可读。' : /auth|login|sign/i.test(msg) ? '要重新登录 Codex。' : 'Codex 没给额度：' + msg.slice(0, 120) }));
            return;
          }
          const limits = ((m.result ?? {}) as Json).rateLimits as Json | null | undefined;
          const windows = codexWindows(limits);
          const plan = typeof limits?.planType === 'string' ? limits.planType : null;
          end(windows.length ? result(id, 'ok', { plan, windows }) : result(id, 'none', { plan, note: '这个账号没有按时间窗口算的额度。' }));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'beastie-works', version: '0' } } });
  });
}

/** When the tightest window starts over: the reset of the most-used window. Null when nothing said. */
export function soonestBack(q: AgentQuota | null): number | null {
  if (!q || q.state !== 'ok' || !q.windows.length) return null;
  const top = [...q.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]!;
  return top.resetsAt;
}

export interface QuotaBookDeps {
  /** The app's own Claude folder (its sign-in). */
  claudeHome(): string;
  /** The Codex program and the environment the app starts it with, or null when there is none. */
  codex(): Promise<{ command: string; env: NodeJS.ProcessEnv } | null>;
  /** How long an answer is kept before reading again. Default one minute. */
  keepMs?: number;
  /** Every other agent: the quotas the app's Magpie reads from the sign-ins on this computer. */
  magpieQuotas?(): Promise<MagpieQuota[]>;
}

/**
 * Which of Magpie's accounts belong to which agent. Magpie names an account by its provider; an agent counts an
 * account whose provider contains one of these words. Claude and Codex are read directly (Orca's way) instead.
 */
export const MAGPIE_PROVIDERS: Record<string, string[]> = {
  gemini: ['gemini'], 'antigravity-acp': ['antigravity'], 'github-copilot-cli': ['copilot'], 'grok-build': ['grok'],
  'kimi-code': ['kimi'], cursor: ['cursor'], opencode: ['opencode'], 'qwen-code': ['qwen'], 'factory-droid': ['droid', 'factory'],
  devin: ['devin', 'windsurf'], kiro: ['kiro'], dsh: ['deepseek'], 'minimax-code': ['minimax'], 'mistral-vibe': ['mistral'],
};

/** Magpie's window names in plain words. */
export function windowLabel(name: string): string {
  const n = name.trim().toLowerCase();
  if (/^5\s*h/.test(n) || n === '5 hours') return '5 小时';
  if (/^(7\s*d|7 days|week)/.test(n)) return '本周';
  if (/^(1\s*d|24\s*h|day|daily)/.test(n)) return '今天';
  if (/^(30\s*d|month)/.test(n)) return '本月';
  return name || '额度';
}

/** An agent's quota from Magpie's accounts: every window of every matching account; a broken one says so. */
export function quotaFromMagpie(agentId: string, accounts: MagpieQuota[]): AgentQuota {
  const words = MAGPIE_PROVIDERS[agentId];
  const mine = words ? accounts.filter(a => words.some(w => a.provider.toLowerCase().includes(w))) : [];
  if (!mine.length) return result(agentId, 'none', { note: '这家的额度还读不到。' });
  const ok = mine.filter(a => !a.error && a.windows.length);
  if (!ok.length) {
    // Magpie's errors can run to a paragraph (Gemini's is several sentences): the first sentence is enough here.
    const why = (mine.find(a => a.error)?.error ?? '没有额度数据').split(/(?<=\.)\s/)[0].slice(0, 120);
    return result(agentId, 'error', { note: '读额度时出错了：' + why });
  }
  return result(agentId, 'ok', {
    plan: ok[0].plan,
    windows: ok.flatMap(a => a.windows.map(w => ({ label: windowLabel(w.name) + (ok.length > 1 ? ' · ' + a.provider : ''), usedPercent: w.usedPercent, resetsAt: w.resetsAt }))),
    note: '经自带的 Magpie 读到。',
  });
}

/** Each agent's quota, read at most once a minute (or when asked to read again). */
export class QuotaBook {
  private kept = new Map<string, Promise<AgentQuota>>();
  private at = new Map<string, number>();
  constructor(private readonly deps: QuotaBookDeps) {}

  read(agentId: string, fresh = false): Promise<AgentQuota> {
    const keep = this.deps.keepMs ?? 60_000;
    const was = this.kept.get(agentId);
    if (was && !fresh && Date.now() - (this.at.get(agentId) ?? 0) < keep) return was;
    const next = this.readNow(agentId).catch(() => result(agentId, 'error', { note: '读额度时出错了。' }));
    this.kept.set(agentId, next);
    this.at.set(agentId, Date.now());
    return next;
  }

  private async readNow(agentId: string): Promise<AgentQuota> {
    if (agentId === 'claude-acp') return readClaudeQuota(this.deps.claudeHome());
    if (agentId === 'codex-acp') {
      const c = await this.deps.codex();
      return c ? readCodexQuota(c.command, c.env) : result(agentId, 'error', { note: '这台电脑上没找到 Codex。' });
    }
    if (this.deps.magpieQuotas && MAGPIE_PROVIDERS[agentId]) return quotaFromMagpie(agentId, await this.deps.magpieQuotas());
    return result(agentId, 'none', { note: '这家的额度还读不到。' });
  }
}
