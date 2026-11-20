import type { AgentQuota } from '@shared/v8/agents';

/** When a quota window starts over, in plain words: "15:09" today, "明天 04:59", or "11月26日 04:59". */
export function resetText(at: number | null, now = Date.now()): string {
  if (at === null) return '重置时间没说';
  const d = new Date(at), today = new Date(now);
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === today.toDateString()) return hm + ' 重置';
  const tomorrow = new Date(now + 86_400_000);
  if (d.toDateString() === tomorrow.toDateString()) return '明天 ' + hm + ' 重置';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm} 重置`;
}

/** An agent's quota windows: how much is left and when each starts over. Reading it used no quota. */
export function QuotaLine({ q, compact }: { q: AgentQuota | null | undefined; compact?: boolean }) {
  if (q === undefined) return <span className="v8-quota is-reading">正在读额度…</span>;
  if (q === null) return null;
  if (q.state !== 'ok') return <span className={'v8-quota is-' + q.state}>{q.note ?? '额度读不到。'}</span>;
  return <span className={'v8-quota' + (compact ? ' is-compact' : '')}>
    {q.windows.map(w => {
      const left = Math.round(100 - w.usedPercent);
      return <span key={w.label} className={'v8-quota-win' + (left <= 10 ? ' is-low' : left <= 30 ? ' is-mid' : '')}>
        <b>{w.label}</b> 还剩 {left}%
        <i className="v8-quota-bar" aria-hidden="true"><i style={{ width: left + '%' }} /></i>
        <em>{resetText(w.resetsAt)}</em>
      </span>;
    })}
  </span>;
}
