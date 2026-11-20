import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardData } from '@shared/v8/board';

/**
 * The board from the main process (src/main/v8/ipc.ts). Refreshed whenever main says something changed, and every
 * few seconds as a safety net. Actions go straight to the workbench; the board refreshes when it reports back.
 */

export interface Workbench {
  data: BoardData | null;
  /** Why the board could not be read, e.g. V8_PROJECT_NOT_GIT. Null while fine. */
  error: string | null;
  /** The last action that failed, shown briefly. */
  notice: string | null;
  refresh(): void;
  say(text: string): void;
  tell(ticketId: number, text: string): void;
  /** Answer a gremlin's question with one of its options: the option's words go to the gremlin. */
  answer(ticketId: number, optionId: string): void;
  stop(ticketId: number): void;
  accept(ticketId: number): void;
  reviewAgain(ticketId: number): void;
  reject(ticketId: number, why: string): void;
  retry(ticketId: number): void;
  front(ticketId: number): void;
  /** 等一等: the working gremlin stops and waits until its quota starts over. */
  waitForQuota(ticketId: number): void;
  /** A ticket waiting for quota goes on now. */
  resumeNow(ticketId: number): void;
  switchModel(ticketId: number, model: string): void;
  switchEffort(ticketId: number, effort: string): void;
}

const code = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  const c = conflict(m);
  if (c) return c;
  return /V8_[A-Z_]+/.exec(m)?.[0] ?? m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
};

const NOTICE: Record<string, string> = {
  V8_WORKBENCH_OFF: '新工作台的开关是关着的。',
  V8_PROJECT_MISSING: '项目文件夹找不到了（被移走或删掉了？）。',
  V8_TICKET_STOPPED: '这张工单已经停了。',
  V8_NOTHING_TO_REVIEW: '这张工单现在没有要审的（已经审过，或者不是做完的状态）。',
  V8_NOT_AWAITING_REVIEW: '这张工单现在不是等你看。',
  V8_NOT_RETRYABLE: '只有卡住或失败的工单能重试。',
  V8_TEXT_INVALID: '说点什么再发。',
  V8_NOT_WORKING: '它现在没在干活，不用等。',
  V8_NOT_WAITING_QUOTA: '它现在没在等额度。',
  V8_SUPPLY_OVERRIDE_INVALID: '这个名字不对，没换。',
};
export const explain = (c: string) => NOTICE[c] ?? (c.startsWith('没收下') ? c : '没办成：' + c);

/** Conflict when accepting: the files are named after the code. */
const conflict = (m: string) => { const f = /V8_APPLY_CONFLICT: (.+)$/.exec(m)?.[1]; return f ? `没收下：这些文件在小怪干活期间你（或别的工单）改过了，怕覆盖掉，一个都没放进项目：${f}。可以打回让小怪按现在的版本重做。` : null; };

export function useWorkbench(): Workbench {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false), again = useRef(false);
  const refresh = useCallback(() => {
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    window.cth.v8.board().then(b => { setData(b); setError(null); }, e => setError(code(e))).finally(() => {
      busy.current = false;
      if (again.current) { again.current = false; refresh(); }
    });
  }, []);
  useEffect(() => {
    refresh();
    const off = window.cth.v8.onChanged(refresh);
    const t = window.setInterval(refresh, 5000);
    return () => { off(); window.clearInterval(t); };
  }, [refresh]);
  useEffect(() => { if (!notice) return; const t = window.setTimeout(() => setNotice(null), 4000); return () => window.clearTimeout(t); }, [notice]);

  const act = (p: Promise<unknown>) => { void p.then(refresh, e => { setNotice(explain(code(e))); refresh(); }); };
  return {
    data, error, notice, refresh,
    say: text => act(window.cth.v8.say(text)),
    tell: (id, text) => act(window.cth.v8.tell(id, text)),
    answer: (id, optionId) => {
      const label = data?.talk.flatMap(t => (t.question?.ticketId === id ? t.question.options : [])).find(o => o.id === optionId)?.label ?? optionId;
      act(window.cth.v8.tell(id, label));
    },
    stop: id => act(window.cth.v8.stop(id)),
    accept: id => act(window.cth.v8.accept(id)),
    reviewAgain: id => act(window.cth.v8.reviewAgain(id)),
    reject: (id, why) => act(window.cth.v8.reject(id, why)),
    retry: id => act(window.cth.v8.retry(id)),
    front: id => act(window.cth.v8.front(id)),
    waitForQuota: id => act(window.cth.v8.waitForQuota(id)),
    resumeNow: id => act(window.cth.v8.resumeNow(id)),
    switchModel: (id, model) => act(window.cth.v8.switchModel(id, model)),
    switchEffort: (id, effort) => act(window.cth.v8.switchEffort(id, effort)),
  };
}
