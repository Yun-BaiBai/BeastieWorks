import { tr } from '@shared/i18n';
import { useState } from 'react';
import type { ToolAsk } from '@shared/v8/board';

/**
 * A gremlin asks to use one of the boss's own connector tools (老板 2026-11-28: it asked to read Notion, the boss said
 * yes in words, and the rule still refused). Shown on every page until answered; as T3 Code: once, for this ticket,
 * or no. Unanswered for ten minutes, it counts as no.
 */
export function AskBox({ asks }: { asks: ToolAsk[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!asks.length) return null;
  const answer = (id: string, how: 'once' | 'ticket' | 'no') => {
    setBusy(id);
    void window.cth.v8.answerAsk(id, how).finally(() => setBusy(null));
  };
  return <div className="v8-asks" role="alertdialog" aria-label={tr('小怪想用你的连接器')}>
    {asks.map(a => <div key={a.id} className="v8-ask">
      <span className="v8-cap">{tr('等你点头 · 工单 #{0}', [a.ticketId])}</span>
      <p><b>{a.title}</b> {tr('的小怪想用你的 {0}：', [a.server])}<code>{a.tool}</code></p>
      <small>{a.writes ? tr('看名字，它会改动你 {0} 里的东西。', [a.server]) : tr('看名字，只是读取。')}{tr('不点的话，10 分钟后算不允许。')}</small>
      <div className="v8-ask-acts">
        <button type="button" className="v8-send" disabled={busy === a.id} onClick={() => answer(a.id, 'once')}>{tr('允许这次')}</button>
        <button type="button" className="v8p-act" disabled={busy === a.id} onClick={() => answer(a.id, 'ticket')}>{tr('这张工单都允许')}</button>
        <button type="button" className="v8-quiet-btn" disabled={busy === a.id} onClick={() => answer(a.id, 'no')}>{tr('不允许')}</button>
      </div>
    </div>)}
  </div>;
}
