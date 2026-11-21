import { dateLocale, tr } from '@shared/i18n';
import type { AgentQuota } from '@shared/v8/agents';

/** When a quota window starts over, in plain words: "15:09" today, "明天 04:59", or "11月26日 04:59". */
export function resetText(at: number | null, now = Date.now()): string {
  if (at === null) return tr('重置时间没说');
  const d = new Date(at), today = new Date(now);
  const hm = d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === today.toDateString()) return hm + tr(' 重置');
  const tomorrow = new Date(now + 86_400_000);
  if (d.toDateString() === tomorrow.toDateString()) return tr('明天 ') + hm + tr(' 重置');
  return tr('{0}月{1}日 {2} 重置', [d.getMonth() + 1, d.getDate(), hm]);
}

/** An agent's quota windows: how much is left and when each starts over. Reading it used no quota. */
export function QuotaLine({ q, compact }: { q: AgentQuota | null | undefined; compact?: boolean }) {
  if (q === undefined) return <span className="v8-quota is-reading">{tr('正在读额度…')}</span>;
  if (q === null) return null;
  if (q.state !== 'ok') return <span className={'v8-quota is-' + q.state}>{q.note ?? tr('额度读不到。')}</span>;
  return <span className={'v8-quota' + (compact ? ' is-compact' : '')}>
    {q.windows.map(w => {
      const left = Math.round(100 - w.usedPercent);
      return <span key={w.label} className={'v8-quota-win' + (left <= 10 ? ' is-low' : left <= 30 ? ' is-mid' : '')}>
        <b>{w.label}</b> {tr(' 还剩 ')}{left}%
        <i className="v8-quota-bar" aria-hidden="true"><i style={{ width: left + '%' }} /></i>
        <em>{resetText(w.resetsAt)}</em>
      </span>;
    })}
  </span>;
}
