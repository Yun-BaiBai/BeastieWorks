import { tr } from '../../shared/i18n';
import type { AgentShell, CostBasis, HostTool, SessionSpec, ShellEvent } from './shell';

/**
 * One question to one agent, answered by one tool call, in a fresh session closed afterwards. The review gremlin's
 * way (reviewer.ts), lifted out so the roundtable's proposers (A6) and the patrol's glance (A11) work the same:
 * the answer comes only through the tool; plain text earns one nudge; a second stop without it is a failure.
 */
export interface OneShotOptions<T> {
  shell: AgentShell;
  spec: Omit<SessionSpec, 'hostTools' | 'sessionRef'>;
  tool: HostTool;
  prompt: string;
  nudge: string;
  /** Checks the tool's arguments; throwing sends the message back to the agent so it can try again. */
  accept(args: unknown): T;
  /** Requests to use the agent's own tools (read a file, run a command). Default: refuse all. */
  approve?(tool: string, detail: string): boolean;
  onCost?(usd: number, basis: CostBasis): void;
  /** Gives up after this long (default 20 min). */
  timeoutMs?: number;
  /** Stops it (the app is closing): the session is cut off and the result is a failure. */
  signal?: AbortSignal;
}

export type OneShotResult<T> = { ok: true; value: T } | { ok: false; why: string };

export async function oneShot<T>(o: OneShotOptions<T>): Promise<OneShotResult<T>> {
  if (o.signal?.aborted) return { ok: false, why: 'stopped' };
  let session;
  try {
    session = await o.shell.open({ ...o.spec, sessionRef: null, hostTools: [o.tool] });
  } catch (err) {
    return { ok: false, why: tr('开不了会话：') + (err instanceof Error ? err.message : String(err)) };
  }
  const s = session;
  if (o.signal?.aborted) { await s.close().catch(() => undefined); return { ok: false, why: 'stopped' }; }
  const result = await new Promise<OneShotResult<T>>(resolve => {
    let nudged = false, value: { v: T } | null = null;
    const timer = setTimeout(() => { s.abort(); resolve({ ok: false, why: tr('超时没交') }); }, o.timeoutMs ?? 20 * 60_000);
    timer.unref?.();
    const stop = () => { s.abort(); end({ ok: false, why: 'stopped' }); };
    const end = (r: OneShotResult<T>) => { clearTimeout(timer); o.signal?.removeEventListener('abort', stop); resolve(r); };
    o.signal?.addEventListener('abort', stop, { once: true });
    s.onEvent((e: ShellEvent) => {
      if (e.type === 'cost') { o.onCost?.(e.usd, e.basis ?? 'reported'); return; }
      if (e.type === 'approval') { s.respondApproval(e.id, e.tool === o.tool.name || (o.approve?.(e.tool, e.detail) ?? false)); return; }
      if (e.type === 'host_tool') {
        if (e.name !== o.tool.name || value) { s.respondHostTool(e.id, { ok: false, error: value ? tr('已经交过了。') : tr('没有这个工具：') + e.name }); return; }
        try { value = { v: o.accept(e.args) }; s.respondHostTool(e.id, { ok: true, text: tr('收到。') }); }
        catch (err) { s.respondHostTool(e.id, { ok: false, error: tr('格式不对：') + (err instanceof Error ? err.message : String(err)) }); }
        return;
      }
      if (e.type === 'settled' || e.type === 'exited') {
        if (value) return end({ ok: true, value: value.v });
        if (e.type === 'settled' && e.status === 'completed' && !nudged) { nudged = true; s.prompt(o.nudge); return; }
        end({ ok: false, why: e.type === 'exited' ? e.detail : e.status === 'error' ? tr('出错：') + (e.detail ?? '') : tr('两次停下都没交') });
      }
    });
    s.prompt(o.prompt);
  });
  await s.close().catch(() => undefined);
  return result;
}
