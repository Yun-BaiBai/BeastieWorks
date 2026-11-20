import { leadName } from '../leadName';
import './morepages.css';
import type { ArchiveItem, BoardData, LedgerDetail, TimelineItem } from '@shared/v8/board';
import { TICKET_STATE_LABEL } from '@shared/v8/tickets';
import { moneyText } from '@shared/v8/board';
import { art, CREW, slotCast } from '../gremlins';
import { ProviderMark } from '../AgentBadge';
import type { Hero } from './Pages';

const money = (n: number) => '$' + n.toFixed(n > 0 && n < 0.1 ? 4 : 2);
const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);

// ---------- 账本 · 钱罐 ----------

/** Where today's money went: a tip jar filled by spend, who spent it, and which tickets cost what. */
export function LedgerPage({ d, hero }: { d: LedgerDetail; hero: Hero }) {
  const parts = [
    { key: 'gremlins', label: '小怪干活', usd: d.bySource.gremlins, color: 'var(--amber)' },
    { key: 'lead', label: leadName() + '说话', usd: d.bySource.lead, color: 'var(--teal)' },
    { key: 'review', label: '审查把关', usd: d.bySource.review, color: 'var(--moss)' },
  ];
  // The jar shows today's spend against one dollar, the way the boss approves budgets; it never overflows.
  const fill = Math.min(1, d.totalUsd / 1);
  const coins = Math.min(28, Math.round(d.totalUsd * 100 / 2));
  const top = Math.max(...d.byTicket.map(t => t.costUsd), 0.0001);
  return <section className="v8p v8m-ledger" aria-label="账本">
    <div className="v8m-jarside">
      <div className="v8m-jar" role="img" aria-label={`今天花了 ${money(d.totalUsd)}`}>
        <div className="v8m-lid" />
        <div className="v8m-glass"><div className="v8m-fill" style={{ height: `${fill * 100}%` }}>
          {Array.from({ length: coins }, (_, i) => <i key={i} className="v8m-coin" style={{ left: `${(i * 37) % 86 + 4}%`, bottom: `${Math.floor(i / 5) * 9 + 3}%` }} />)}
        </div></div>
        <span className="v8m-label">TIPS</span>
      </div>
      <img className="v8-g v8p-hero v8m-jarg" style={hero} src={art('blob', 'reporting')} alt="" />
    </div>
    <div className="v8m-ledgerbody">
      <span className="v8-cap">账本 · 应用这次打开以来</span>
      <h1>{moneyText(d.totalUsd, d.totalSure)}</h1>
      <p className="v8m-sub">{d.capUsd !== null ? `每个会话最多花 ${money(d.capUsd)}，超过就自动停。` : d.totalSure === 'estimated' ? '有的 agent 不报美元，按它用的词元数和官方价格估算。订阅用户实际不按这个扣钱。' : d.totalSure === 'partial' ? '有的花费算不出来（模型不在价格表上），实际比这个多。' : '这次打开以来记下的花费。'}</p>
      <div className="v8m-split">{parts.map(p => <div key={p.key}><i style={{ background: p.color }} /><span>{p.label}</span><b>{money(p.usd)}</b></div>)}</div>
      <div className="v8m-bar" aria-hidden="true">{parts.map(p => <i key={p.key} style={{ background: p.color, flex: Math.max(p.usd, 0.00001) }} />)}</div>
      <span className="v8-cap v8p-gap">每张工单花了多少</span>
      <div className="v8m-tickets">
        {d.byTicket.length ? d.byTicket.slice(0, 8).map(t => <div key={t.id} className="v8m-trow">
          <b>#{t.id} {t.title}</b><small>{TICKET_STATE_LABEL[t.state]} · {clock(t.elapsedMs)}</small>
          <span className="v8m-tbar"><i style={{ width: `${(t.costUsd / top) * 100}%` }} /></span><em>{money(t.costUsd)}</em>
        </div>) : <p className="v8m-sub">还没有工单。</p>}
      </div>
    </div>
  </section>;
}

// ---------- 档案柜 ----------

const DRAWERS: Array<{ key: string; label: string; match: (s: ArchiveItem['state']) => boolean }> = [
  { key: 'live', label: '进行中', match: s => ['WORKING', 'QUEUED', 'IDLE', 'WAITING_QUOTA'].includes(s) },
  { key: 'you', label: '等你', match: s => ['ANSWER', 'REVIEW', 'BLOCKED', 'FAILED'].includes(s) },
  { key: 'done', label: '完成', match: s => s === 'DONE' },
  { key: 'stopped', label: '已停', match: s => s === 'STOPPED' },
];

/** Every ticket of the project as a folder in a filing cabinet; open one to read its story. */
export function ArchivePage({ items, drawer, onDrawer, onOpen, hero }: { items: ArchiveItem[]; drawer: string; onDrawer(key: string): void; onOpen(id: number): void; hero: Hero }) {
  const current = DRAWERS.find(d => d.key === drawer) ?? DRAWERS[0];
  const shown = items.filter(i => current.match(i.state));
  return <section className="v8p v8m-archive" aria-label="档案柜">
    <div className="v8m-cabinet">
      {DRAWERS.map(d => {
        const n = items.filter(i => d.match(i.state)).length;
        return <button key={d.key} type="button" className={'v8m-drawer' + (d.key === current.key ? ' is-open' : '')} aria-pressed={d.key === current.key} onClick={() => onDrawer(d.key)}>
          <span className="v8m-tag">{d.label}</span><i className="v8m-handle" /><b>{n}</b>
        </button>;
      })}
      <img className="v8-g v8p-hero v8m-cabg" style={hero} src={art('tri', 'checking')} alt="" />
    </div>
    <div className="v8m-folders">
      <span className="v8-cap">档案柜 · {current.label} · {shown.length} 份</span>
      {shown.length ? <div className="v8m-grid">{shown.slice(0, 9).map(i => <button key={i.id} type="button" className="v8m-folder" onClick={() => onOpen(i.id)}>
        <span className="v8m-ftab">#{i.id}</span>
        <b>{i.title}</b>
        <q>{i.originalRequest}</q>
        <small>{TICKET_STATE_LABEL[i.state]} · {hhmm(i.createdAt)}{i.outcome ? ' · ' + i.outcome : ''}</small>
      </button>)}</div> : <p className="v8m-sub">这个抽屉是空的。</p>}
      {shown.length > 9 && <p className="v8m-sub">还有 {shown.length - 9} 份，先看最新的这些。</p>}
    </div>
  </section>;
}

// ---------- 工单时间线 · 连环画 ----------

const WHO: Record<TimelineItem['who'], { name: string; cast: Parameters<typeof art>[0]; pose: Parameters<typeof art>[1] }> = {
  boss: { name: '你', cast: 'boss', pose: 'idle' },
  get lead() { return { name: leadName(), cast: 'boss' as const, pose: 'pointing' as const }; },
  gremlin: { name: '小怪', cast: 'alien', pose: 'working' },
  review: { name: '审查', cast: 'lanky', pose: 'checking' },
  system: { name: '记录', cast: 'tri', pose: 'idle' },
};

/** One ticket's story as a comic strip, oldest first. */
export function TimelinePage({ title, items, hero }: { title: string; items: TimelineItem[]; hero: Hero }) {
  return <section className="v8p v8m-timeline" aria-label={'时间线 · ' + title}>
    <div className="v8m-tlhead">
      <img className="v8-g v8p-hero" style={hero} src={art('lanky', 'reading')} alt="" />
      <div><span className="v8-cap">工单时间线</span><h1>{title}</h1><p className="v8m-sub">从你说的那句话，到现在。小怪的具体动作只记这次打开应用之后的。</p></div>
    </div>
    <ol className="v8m-strip">
      {items.map(i => {
        const w = WHO[i.who];
        return <li key={i.id} className={'v8m-panel is-' + i.who}>
          {i.who === 'boss' ? <span className="v8m-you">你</span> : <img className="v8-g" src={art(w.cast, i.kind === '审查打回' ? 'reject' : i.kind === '审查通过' ? 'approve' : w.pose)} alt="" />}
          <div><span className="v8-cap">{w.name} · {i.kind}{i.at ? ' · ' + hhmm(i.at) : ''}</span><p>{i.text}</p></div>
        </li>;
      })}
    </ol>
  </section>;
}

// ---------- 小怪名册 · 工牌墙 ----------

/** Every character on a lanyard badge: who they are, where they sit, what they are on, which model drives them. */
export function CrewPage({ data, hero }: { data: BoardData; hero: Hero }) {
  const seated = new Map<string, { label: string; ticket: string | null; model: string | null }>();
  data.slots.forEach(s => seated.set(slotCast(s.order), { label: s.slot.label, ticket: s.ticket?.title ?? null, model: s.slot.model }));
  return <section className="v8p v8m-crew" aria-label="小怪名册">
    <div className="v8m-crewhead"><span className="v8-cap">小怪名册 · {data.project}</span><h1>工坊里的每一只</h1>
      <p className="v8m-sub">外壳：{data.harness.label}。干活的小怪按工位轮流上岗，不会撞脸。</p></div>
    <div className="v8m-badges">
      {CREW.map((c, i) => {
        const seat = c.role === 'worker' ? seated.get(c.cast) : undefined;
        const model = c.role === 'worker' ? seat?.model ?? data.slots[0]?.slot.model ?? null : data.slots[0]?.slot.model ?? null;
        return <article key={c.cast} className={'v8m-badge' + (seat?.ticket ? ' is-busy' : '')} style={{ transform: `rotate(${[-2, 1.5, -1, 2, -1.5, 1, -2.5, 1.8][i % 8]}deg)` }}>
          <i className="v8m-lanyard" aria-hidden="true" />
          <img className="v8-g" style={i === 0 ? hero : undefined} src={art(c.cast, c.role === 'lead' ? 'thumbs_up' : c.role === 'reviewer' ? 'approve' : seat?.ticket ? 'working' : 'idle')} alt="" />
          <b>{c.name}</b>
          <span className="v8m-role">{c.title}</span>
          <small>{c.role === 'lead' ? '只听你说话、派活' : c.role === 'reviewer' ? '对照原话验收' : seat ? seat.label + (seat.ticket ? ' · ' + seat.ticket : ' · 空着') : '候补，等名额'}</small>
          <span className="v8m-model"><ProviderMark model={model} size={14} />{model ?? '默认模型'}</span>
        </article>;
      })}
    </div>
  </section>;
}
