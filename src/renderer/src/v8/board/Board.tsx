import { tr } from '@shared/i18n';
import { leadName } from '../leadName';
import { moneyText } from '@shared/v8/board';
import './board.css';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BoardData, BoardSlot, RingMark } from '@shared/v8/board';
import { WORK_STEPS } from '@shared/v8/board';
import { TICKET_STATE_LABEL, type TicketView } from '@shared/v8/tickets';
import { art, deskCast, poseFor, type AnyPose } from '../gremlins';
import { ProviderMark } from '../AgentBadge';
import { HERO_NAME, type Door, type HeroKey } from '../views';
import { MicButton } from '../MicButton';

/** The hero name sits on exactly one board gremlin while a page change runs. */
const heroStyle = (heroKey: HeroKey | null, key: HeroKey) => (heroKey === key ? { viewTransitionName: HERO_NAME } : undefined);

interface DoorProps { open?: Door; heroKey: HeroKey | null }
/** A card that opens a page: the whole card for the mouse, Enter or Space for the keyboard. */
function door(open: Door | undefined, go: () => void) {
  if (!open) return { className: '' };
  return {
    className: ' is-door', role: 'button' as const, tabIndex: 0, onClick: go,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } },
  };
}

/**
 * The dispatch board: the lead in the middle, every slot, review, the queue and what waits for the boss around it,
 * the feed and the talk bar below. Laid out in canvas pixels copied from prototype/works.html (floor.src.html).
 */

const HUB = { x: 720, y: 310 };
/** Where each wire meets its card, in stage pixels (the prototype's numbers). */
const ENDS = { slot0: [482, 172], slot1: [958, 172], review: [1050, 364], emergency: [390, 340], queue: [498, 478], waiting: [936, 512] } as const;
const SLOT_POS = [{ left: 214, top: 104 }, { left: 958, top: 104 }];
const NOTE_POS = [{ left: 262, top: 446, turn: -1.5 }, { left: 278, top: 479, turn: 1.8 }, { left: 258, top: 512, turn: -1 }];

export interface BoardProps {
  data: BoardData;
  onSay(text: string): void;
  onAnswer(ticketId: number, optionId: string): void;
  /** 圆桌会议 (A6): the boss picks Plan A or B. */
  onPick?(roundtableId: number, which: 'A' | 'B'): void;
  /** 工序链 (A15): the boss starts the next stage. */
  onNextStage?(chainId: number): void;
  /** 拆解 (A12): the boss decides. */
  onSplit?(id: number, how: 'split' | 'whole'): void;
  /** Opens a local page. Absent: the board is not clickable. */
  open?: Door;
  /** Which board gremlin carries the transition name right now. */
  heroKey?: HeroKey | null;
}

export function Board({ data, onSay, onAnswer, onPick, onNextStage, onSplit, open, heroKey = null }: BoardProps) {
  const working = data.slots.filter(s => s.ticket);
  const reporting = data.slots.some(s => s.reporting);
  const hub = door(open, () => open?.({ kind: 'lead' }, 'lead'));
  return (
    <>
      <section className="v8-stage" aria-label={tr('调度台')}>
        <div className="v8-dots" />
        <Wires data={data} />
        <Packets data={data} />
        <Flow data={data} />
        <div {...hub} className={'v8-hub' + hub.className} aria-label={leadName()}>
          <img className="v8-g" src={art('boss', data.waiting.length ? 'pointing' : 'listening')} alt="" style={heroStyle(heroKey, 'lead')} />
          <div className="v8-plate"><i />{leadName()}{tr('在线 · 随时回话')}<ProviderMark model={data.agents.lead} size={15} /></div>
        </div>
        {/* Two desks: the two big cards. More (up to 8, requirement 61): the same two places, each a grid of small desk
            cards, so every desk is on the board and none covers the lead (boss's screenshot 2026-11-21). */}
        {data.slots.length <= 2
          ? data.slots.map((s, i) => <SlotCard key={s.slot.id} s={s} pos={SLOT_POS[i]} now={data.now} open={open} heroKey={heroKey} />)
          : [data.slots.slice(0, Math.ceil(data.slots.length / 2)), data.slots.slice(Math.ceil(data.slots.length / 2))].map((half, i) =>
            <div key={i} className="v8-minis" style={SLOT_POS[i]}>{half.map(s => <MiniDesk key={s.slot.id} s={s} open={open} />)}</div>)}
        <ReviewCard review={data.review} agents={data.agents} open={open} heroKey={heroKey} />
        {data.emergency && <EmergencyCard s={data.emergency} now={data.now} open={open} heroKey={heroKey} />}
        <QueueNotes queue={data.queue} resting={data.resting} now={data.now} open={open} />
        {data.waiting.length > 0 && <WaitingCard waiting={data.waiting} open={open} heroKey={heroKey} />}
        <span className="v8-sr-only" aria-live="polite">{working.length} {tr(' 个工位在干活')}{reporting ? tr('，有小怪正在汇报') : ''}</span>
      </section>
      <section className="v8-bottom">
        <Feed data={data} open={open} />
        <TalkBar data={data} onSay={onSay} onAnswer={onAnswer} {...(onPick ? { onPick } : {})} {...(onNextStage ? { onNextStage } : {})} {...(onSplit ? { onSplit } : {})} />
      </section>
    </>
  );
}

// ---------- the ring, the wires, the doodles ----------

const MARK_COLOR: Record<Exclude<RingMark, 'event'>, string> = { waiting: 'var(--amber)', passed: 'var(--moss)', refused: 'var(--brick)' };

/**
 * Real traffic on the wires: every time a gremlin does something new, a small label with the tool's name travels
 * along its wire to the lead. Nothing moves when nothing happens.
 */
function Packets({ data }: { data: BoardData }) {
  const last = useRef<Record<string, string | null>>({});
  const [packets, setPackets] = useState<Array<{ id: number; slot: number; text: string }>>([]);
  const seq = useRef(0);
  useEffect(() => {
    data.slots.slice(0, 2).forEach((s, i) => {
      const prev = last.current[s.slot.id];
      last.current[s.slot.id] = s.live;
      if (s.live && prev !== undefined && s.live !== prev) {
        const id = ++seq.current;
        setPackets(p => [...p.slice(-6), { id, slot: i, text: s.live!.split(' ')[0] }]);
        window.setTimeout(() => setPackets(p => p.filter(x => x.id !== id)), 1600);
      }
    });
  }, [data.slots]);
  return <>{packets.map(p => {
    const [x, y] = p.slot === 0 ? ENDS.slot0 : ENDS.slot1;
    return <span key={p.id} className="v8-packet" aria-hidden="true" style={{ offsetPath: `path('M${x} ${y} L${HUB.x} ${HUB.y}')` }}>{p.text}</span>;
  })}</>;
}

function Wires({ data }: { data: BoardData }) {
  const ticks = Array.from({ length: 120 }, (_, i) => {
    const a = i / 120 * Math.PI * 2 - Math.PI / 2, long = i % 5 === 0, mark = data.ring[i], colored = mark && mark !== 'event';
    const r1 = 150, r2 = long ? 166 : 160;
    return <line key={i} x1={HUB.x + Math.cos(a) * r1} y1={HUB.y + Math.sin(a) * r1} x2={HUB.x + Math.cos(a) * r2} y2={HUB.y + Math.sin(a) * r2}
      stroke={colored ? MARK_COLOR[mark] : 'var(--ink)'} strokeWidth={colored ? 4 : long ? 2 : 1.2} strokeLinecap="round" opacity={colored ? 1 : mark ? .85 : .22} />;
  });
  const flow: Partial<Record<keyof typeof ENDS, string>> = {
    slot0: data.slots[0]?.ticket ? (data.slots[0].reporting ? 'is-live is-back' : 'is-live') : '',
    slot1: data.slots[1]?.ticket ? (data.slots[1].reporting ? 'is-live is-back' : 'is-live') : '',
    waiting: data.waiting.length ? 'is-live is-back' : '',
  };
  return (
    <svg className="v8-wire" viewBox="0 0 1440 590" aria-hidden="true">
      <g className="v8-ticks">{ticks}</g>
      <circle cx={HUB.x} cy={HUB.y} r={236} fill="none" stroke="var(--ink3)" strokeWidth={1} strokeDasharray="2 8" opacity={.5} />
      {(Object.keys(ENDS) as Array<keyof typeof ENDS>).filter(k => k !== 'slot1' || data.slots.length > 1).filter(k => k !== 'emergency' || data.emergency).map(k => {
        const [x, y] = ENDS[k], d = Math.hypot(x - HUB.x, y - HUB.y), ux = (x - HUB.x) / d, uy = (y - HUB.y) / d, sx = HUB.x + ux * 176, sy = HUB.y + uy * 176;
        return <g key={k}>
          <path d={`M${sx} ${sy}L${x} ${y}`} className={'v8-w ' + (flow[k] ?? '')} />
          <circle cx={sx} cy={sy} r={5} fill="var(--paper)" stroke="var(--ink)" strokeWidth={2} />
        </g>;
      })}
    </svg>
  );
}

/**
 * The background reads like a live architecture diagram (参考：动态架构图): a pipeline strip with real counts, a number
 * on every wire, and a legend for the ring. Everything here is derived from the board data; nothing is decoration.
 */
function Flow({ data }: { data: BoardData }) {
  const working = data.slots.filter(s => s.ticket).length + (data.emergency?.ticket ? 1 : 0);
  const reviewing = data.review.current ? 1 : 0;
  const yours = data.waiting.length;
  const steps = [
    { key: 'queue', label: tr('排队'), n: data.queue.length },
    { key: 'work', label: tr('干活'), n: working },
    { key: 'review', label: tr('审查'), n: reviewing },
    { key: 'you', label: tr('等你'), n: yours },
    { key: 'done', label: tr('完成'), n: data.done },
  ];
  const top = Math.max(1, ...steps.map(s => s.n));
  const count = (m: RingMark) => data.ring.filter(r => r === m).length;
  const legend = [
    { key: 'event', label: tr('小怪动作'), n: count('event'), color: 'var(--ink3)' },
    { key: 'waiting', label: tr('交给你'), n: count('waiting'), color: 'var(--amber)' },
    { key: 'passed', label: tr('审查通过'), n: count('passed'), color: 'var(--moss)' },
    { key: 'refused', label: tr('审查打回'), n: count('refused'), color: 'var(--brick)' },
  ];
  const tool = (s: BoardSlot | undefined) => !s?.ticket ? tr('空闲') : s.reporting ? tr('交报告') : clip(s.live ?? tr('想事情'), 18);
  function clip(t: string, n: number) { const v = t.replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n - 1) + '…' : v; }
  // Halfway along the visible part of the wire (it leaves the hub at radius 176), so the hub never covers a label.
  const mid = (k: keyof typeof ENDS, dx = 0, dy = 0) => {
    const [x, y] = ENDS[k], d = Math.hypot(x - HUB.x, y - HUB.y), t = (176 + (d - 176) / 2) / d;
    return { left: HUB.x + (x - HUB.x) * t + dx, top: HUB.y + (y - HUB.y) * t + dy };
  };
  // More than two desks sit in two groups (requirement 61): each wire is labelled for its group.
  const half = Math.ceil(data.slots.length / 2);
  const group = (list: BoardSlot[]) => { const busy = list.filter(s => s.ticket).length; return tr('{0} 个工位 · {1}', [list.length, busy ? tr('{0} 个在干', [busy]) : tr('空闲')]); };
  const many = data.slots.length > 2;
  const labels: Array<{ key: string; at: { left: number; top: number }; text: string; hot?: boolean }> = [
    { key: 'slot0', at: mid('slot0', 14, 16), text: many ? group(data.slots.slice(0, half)) : (data.slots[0]?.slot.label ?? tr('工位')) + ' · ' + tool(data.slots[0]), hot: many ? data.slots.slice(0, half).some(s => s.ticket) : !!data.slots[0]?.ticket },
    ...(data.slots[1] ? [{ key: 'slot1', at: mid('slot1', -20, -8), text: many ? group(data.slots.slice(half)) : data.slots[1].slot.label + ' · ' + tool(data.slots[1]), hot: many ? data.slots.slice(half).some(s => s.ticket) : !!data.slots[1].ticket }] : []),
    { key: 'queue', at: mid('queue', -30, 12), text: tr('派活 ← 排队 {0}', [data.queue.length]) },
    { key: 'review', at: mid('review', 0, -16), text: data.review.enabled ? tr('审查 · 过 {0}', [data.review.passedToday]) : tr('审查没开'), hot: !!data.review.current },
    { key: 'waiting', at: mid('waiting', -24, -14), text: tr('交给你 {0}', [yours]), hot: yours > 0 },
  ];
  return <>
    <div className="v8-pipe" aria-label={tr('工单流水线')}>
      <span className="v8-pipe-cap">{tr('工单流水线 · 实时')}</span>
      <ol>{steps.map((s, i) => <li key={s.key} className={s.n ? 'is-on' : ''}>
        {i > 0 && <i className="v8-pipe-arrow" aria-hidden="true" />}
        <b>{s.n}</b><span>{s.label}</span><em style={{ width: `${(s.n / top) * 100}%` }} />
      </li>)}</ol>
    </div>
    {labels.map(l => <span key={l.key} className={'v8-wlabel' + (l.hot ? ' is-hot' : '')} style={l.at}>{l.text}</span>)}
    <div className="v8-legend" aria-label={tr('圆环图例')}>
      <span className="v8-pipe-cap">{tr('圆环 · 今天每件事一格')}</span>
      <ul>{legend.map(g => <li key={g.key}><i style={{ background: g.color }} />{g.label}<b>{g.n}</b></li>)}</ul>
    </div>
    {data.slots.length < 2 && <div className="v8-ghost" aria-label={tr('工位 02 没开')}>
      <span className="v8-pipe-cap">{tr('工位 02 · 没开')}</span>
      <p>{tr('现在只开了 ')}{data.slots.length} {tr(' 个工位，同一时间只有一只小怪干活。设置里最多能开 4 个。')}</p>
    </div>}
  </>;
}

// ---------- cards ----------

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

function SlotCard({ s, pos, now, open, heroKey, compact = false }: { s: BoardSlot; pos: { left: number; top: number }; now: number; compact?: boolean } & DoorProps) {
  const t = s.ticket;
  const head = `${s.slot.label}${s.slot.model ? ' · ' + s.slot.model : ''}`;
  if (!t) {
    // An empty desk opens its settings (requirement 61): who sits there, on which agent, with which skills.
    const e = door(open, () => open?.({ kind: 'desk', slotId: s.slot.id }, null));
    return <article {...e} className={'v8-card v8-sticker is-empty' + e.className} style={pos} aria-label={head + tr(' · 空着，点开设置')}>
      <img className="v8-g" src={art(deskCast(s), 'long_wait')} alt="" />
      <div className="v8-row"><span className="v8-cap">{head}</span><span className="v8-pill">{tr('空着')}</span></div>
      <h3>{tr('没有活，等下一张工单')}</h3>
    </article>;
  }
  const key = 'slot:' + s.slot.id;
  const d = door(open, () => open?.({ kind: 'slot', slotId: s.slot.id }, key));
  return (
    <article {...d} className={'v8-card v8-sticker is-work' + (compact ? ' is-compact' : '') + d.className} style={pos} aria-label={`${head} · ${t.title}`}>
      <img className="v8-g" src={art(deskCast(s), poseFor(t.state, s.phase))} alt="" style={heroStyle(heroKey, key)} />
      {s.reporting && <span className="v8-tag">{tr('正在汇报')}</span>}
      <div className="v8-row"><span className="v8-cap v8-cap-agent"><ProviderMark model={s.slot.model} size={15} />{head}</span><span className="v8-pill is-go">{s.phase === 'checking' ? tr('在验证') : tr('在干活')}</span></div>
      <h3>{t.title}</h3>
      {s.live && <div className="v8-say-bubble" aria-live="polite"><span className={s.phase === 'working' ? 'is-typing' : ''}>{s.live}</span></div>}
      {compact ? null : s.recent.length > 0 ? <ol className="v8-recent">{s.recent.map((r, i) => <li key={i}>{r}</li>)}</ol> : <div className="v8-live">{s.live ?? tr('刚开工')}</div>}
      <div className="v8-bars" title={WORK_STEPS.map((n, i) => (i < s.step ? '✓ ' : i === s.step ? '▶ ' : '') + n).join(tr('　'))}>
        {WORK_STEPS.map((n, i) => <i key={n} className={i < s.step ? 'is-on' : i === s.step ? 'is-now' : ''} />)}
        <span>{s.startedAt ? clock(now - s.startedAt) : '--:--'} · {moneyText(s.costUsd, s.costSure)}</span>
      </div>
    </article>
  );
}

/** One desk among many: its gremlin, name, and what it is on. Busy opens its work; empty opens its settings. */
function MiniDesk({ s, open }: { s: BoardSlot; open?: Door }) {
  const t = s.ticket;
  const d = door(open, () => open?.(t ? { kind: 'slot', slotId: s.slot.id } : { kind: 'desk', slotId: s.slot.id }, null));
  return <article {...d} className={'v8-mini v8-sticker' + (t ? ' is-work' : ' is-empty') + d.className} aria-label={s.slot.label + (t ? ' · ' + t.title : tr(' · 空着，点开设置'))}>
    <img className="v8-g" src={art(deskCast(s), t ? poseFor(t.state, s.phase) : 'long_wait')} alt="" />
    <div><b>{s.slot.label}</b><small>{t ? (s.phase === 'checking' ? tr('在验证') : tr('在干活')) : tr('空着')}{s.slot.model ? ' · ' + s.slot.model : ''}</small>
      <span>{t ? t.title : tr('没有活')}</span></div>
  </article>;
}

function EmergencyCard({ s, now, open, heroKey }: { s: BoardSlot; now: number } & DoorProps) {
  // Compact (no recent-actions list) so it clears the queue notes below it.
  if (s.ticket) return <SlotCard s={s} pos={{ left: 122, top: 292 }} now={now} open={open} heroKey={heroKey} compact />;
  return <article className="v8-card v8-sticker is-empty" style={{ left: 122, top: 292 }} aria-label={tr('应急名额 · 空着')}>
    <img className="v8-g" src={art('tri', 'long_wait')} alt="" />
    <div className="v8-row"><span className="v8-cap">{tr('应急名额')}</span><span className="v8-pill">{tr('空着')}</span></div>
    <h3>{tr('留给你临时插话的那张')}</h3>
  </article>;
}

function ReviewCard({ review, agents, open, heroKey }: { review: BoardData['review']; agents: BoardData['agents'] } & DoorProps) {
  const d = door(open, () => open?.({ kind: 'review' }, 'review'));
  return <article {...d} className={'v8-card v8-sticker' + d.className} style={{ left: 1050, top: 316 }} aria-label={tr('审查')}>
    <img className="v8-g" src={art('lanky', review.current ? 'reading' : 'idle')} alt="" style={heroStyle(heroKey, 'review')} />
    {review.current && <span className="v8-tag">{tr('正在审')}</span>}
    <div className="v8-row"><span className="v8-cap v8-cap-agent"><ProviderMark model={agents.review} size={15} />{tr('审查 · 全新上下文')}</span>{review.enabled && <span className="v8-pill is-ok">{tr('通过 ')}{review.passedToday}</span>}</div>
    <h3>{!review.enabled ? tr('审查没开') : review.current ? review.current : tr('对照你的原话验收')}</h3>
    <div className={'v8-live' + (review.current ? ' is-typing' : '')}>{!review.enabled ? tr('做完的活直接交给你看') : review.current ? tr('对照原话、改动和验证结果') : review.lastPassed ? tr('刚通过：') + review.lastPassed : tr('今天还没有要审的')}</div>
  </article>;
}

/** When a ticket waiting for quota goes on: a clock time and minutes left, or "unknown". */
function backAt(t: TicketView, now: number): string {
  const at = t.quotaWait?.resetsAt;
  if (!at) return tr('恢复时间不知道');
  const min = Math.max(0, Math.ceil((at - now) / 60_000));
  return new Date(at).toTimeString().slice(0, 5) + tr(' 恢复 · 还有 ') + (min >= 60 ? Math.floor(min / 60) + tr(' 小时 ') + (min % 60) + tr(' 分') : min + tr(' 分'));
}

function QueueNotes({ queue, resting, now, open }: { queue: TicketView[]; resting: TicketView[]; now: number; open?: Door }) {
  const d = door(open, () => open?.({ kind: 'queue' }, null));
  // Tickets waiting for quota come first (they were already under way), each with a sleeping gremlin and its time.
  const notes = [...resting.map(t => ({ t, rest: true })), ...queue.map(t => ({ t, rest: false }))];
  const cap = [queue.length ? tr('排队 {0} · 先来先做', [queue.length]) : tr('没有排队的工单'), resting.length ? tr('等额度 {0}', [resting.length]) : ''].filter(Boolean).join(' · ');
  return <div className="v8-queue">
    <span className="v8-cap" style={{ left: 266, top: 426 }}>{cap}</span>
    {notes.slice(0, 3).map(({ t, rest }, i) => <div key={t.id} {...d} className={'v8-note' + (rest ? ' is-resting' : '') + d.className}
      aria-label={rest ? tr('等额度 · {0} · {1}', [t.title, backAt(t, now)]) : tr('排队 {0} · {1}', [i + 1 - resting.length, t.title])}
      style={{ left: NOTE_POS[i].left, top: NOTE_POS[i].top, transform: `rotate(${NOTE_POS[i].turn}deg)` }}>
      {rest ? <><img className="v8-g v8-note-zz" src={art('tri', 'waiting_quota')} alt="" /><small>{tr('等额度')}</small>{t.title}<em>{backAt(t, now)}</em></>
        : <><small>{String(i + 1 - resting.length).padStart(2, '0')}</small>{t.title}</>}
    </div>)}
    {notes.length > 3 && <span className="v8-cap" style={{ left: 266, top: 552 }}>{tr('还有 ')}{notes.length - 3} {tr(' 张')}</span>}
  </div>;
}

const WAIT_TEXT: Partial<Record<TicketView['state'], { cap: string; pose: AnyPose; act: string }>> = {
  REVIEW: { cap: tr('等你看'), pose: 'reporting', act: tr('看结果') },
  ANSWER: { cap: tr('等你回答'), pose: 'held', act: tr('去回答') },
  BLOCKED: { cap: tr('卡住了'), pose: 'stuck', act: tr('看看卡在哪') },
  FAILED: { cap: tr('失败了'), pose: 'stalled', act: tr('看看原因') },
};

function WaitingCard({ waiting, open, heroKey }: { waiting: TicketView[] } & DoorProps) {
  const t = waiting.find(w => w.state === 'REVIEW') ?? waiting[0];
  const w = WAIT_TEXT[t.state] ?? WAIT_TEXT.REVIEW!;
  const key = 'waiting:' + t.id;
  // A result opens the delivery page; a question or a stuck ticket is answered at the lead's.
  const go = () => open?.(t.state === 'REVIEW' ? { kind: 'delivery', ticketId: t.id } : { kind: 'lead' }, key);
  return <article className="v8-card v8-sticker is-you" style={{ left: 936, top: 452 }} aria-label={w.cap + ' · ' + t.title}>
    <img className="v8-g" src={art('alien', w.pose)} alt="" style={heroStyle(heroKey, key)} />
    <div className="v8-row"><span className="v8-cap">{w.cap}{waiting.length > 1 ? tr(' · 还有 {0} 件', [waiting.length - 1]) : ''}</span><span className="v8-pill">{TICKET_STATE_LABEL[t.state]}</span></div>
    <h3>{t.title}</h3>
    <div className="v8-btns"><button type="button" className="v8-btn" onClick={go}>{w.act}</button>{t.state === 'REVIEW' && <button type="button" className="v8-btn is-ghost" onClick={go}>{tr('打回重做')}</button>}</div>
  </article>;
}

// ---------- feed and talk bar ----------

function Feed({ data, open }: { data: BoardData; open?: Door }) {
  const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);
  return <div className="v8-feed v8-sticker">
    <div className="v8-head"><span className="v8-cap">{tr('动态 · 只记要紧的')}</span>{open && <button type="button" className="v8-feedlink" onClick={() => open({ kind: 'archive' }, null)}>{tr('档案 →')}</button>}</div>
    <div className="v8-lines">
      {data.feed.slice(0, 8).map(f => <div key={f.id} className="v8-ln"><time>{hhmm(f.at)}</time><b className={'is-' + f.tone}>{f.who}</b><span>{f.text}</span></div>)}
    </div>
  </div>;
}

function TalkBar({ data, onSay, onAnswer, onPick, onNextStage, onSplit }: Omit<BoardProps, 'data'> & { data: BoardData }) {
  const [text, setText] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const send = () => { const v = text.trim(); if (!v) return; onSay(v); setText(''); };
  const key = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } };
  // Scrolls back through history; stays pinned to the newest line unless the boss has scrolled up to read.
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = data.talk[data.talk.length - 1]?.id;
  // 拉高 (老板 2026-11-22): the talk bar grows upward over the board to show more of the talk, and back; Esc closes.
  const [tall, setTall] = useState(false);
  useEffect(() => { const el = box.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [last, data.talk.length, tall]);
  useEffect(() => {
    if (!tall) return;
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setTall(false); } };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [tall]);
  return <div className={'v8-talk v8-sticker' + (tall ? ' is-tall' : '')}>
    <div className="v8-head"><span className="v8-cap">{tr('对讲栏 · 你只用跟')}{leadName()}{tr('说话')}</span>
      <button type="button" className="v8-talk-size" onClick={() => setTall(t => !t)} aria-pressed={tall}
        title={tall ? tr('收回去（Esc）') : tr('拉高，看更多对话记录')} aria-label={tall ? tr('收回去（Esc）') : tr('拉高，看更多对话记录')}>
        {tall
          ? <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7" /></svg>
          : <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg>}
      </button></div>
    <div className="v8-chat" ref={box} aria-live="polite" tabIndex={0} aria-label={tr('对话记录，可以往上翻')}
      onScroll={e => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      <div className="v8-chat-in">
      {data.talk.map(t => t.author === 'boss'
        ? <div key={t.id} className="v8-me">{t.text}</div>
        : <div key={t.id} className="v8-lead"><img className="v8-g" src={art('boss', t.question ? 'shrugging' : 'reporting')} alt={leadName()} />
          <div className="v8-bubble">{t.text}
            {t.question && <div className="v8-opts">{t.question.options.map(o =>
              <button key={o.id} type="button" className={'v8-opt' + (o.id === t.question!.recommended ? ' is-rec' : '')} onClick={() => onAnswer(t.question!.ticketId, o.id)}>
                {o.label}{o.id === t.question!.recommended ? tr('（它推荐）') : ''}</button>)}</div>}
          </div>
        </div>)}
      {data.roundtables.map(r => <Roundtable key={'rt' + r.id} r={r} {...(onPick ? { onPick } : {})} />)}
      {data.chains.map(c => <ChainCard key={'ch' + c.id} c={c} {...(onNextStage ? { onNext: onNextStage } : {})} />)}
      {data.splits.map(s => <SplitCard key={'sp' + s.id} s={s} {...(onSplit ? { onDecide: onSplit } : {})} />)}
      </div>
    </div>
    <div className="v8-say">
      <input ref={field} value={text} onChange={e => setText(e.target.value)} onKeyDown={key} aria-label={tr('跟') + leadName() + tr('说话')} placeholder={tr('跟') + leadName() + tr('说一句，比如：登录页的验证码收不到，查一下')} />
      <MicButton input={field} onText={t => setText(v => (v.trim() ? v.trimEnd() + ' ' : '') + t)} />
      <button type="button" className="v8-send" onClick={send}>{tr('发话')}</button>
    </div>
    <div className="v8-chips">
      {[tr('现在都在干嘛？'), tr('停掉工位 02'), tr('把排队 03 提到最前')].map(c => <button key={c} type="button" className="v8-chip" onClick={() => setText(c)}>{c}</button>)}
    </div>
  </div>;
}

/**
 * 圆桌会议 in the talk bar (A6): who has handed in a proposal, then the lead sorting them, then Plan A and Plan B
 * with one button each. Picking one opens a ticket that does it.
 */
function Roundtable({ r, onPick }: { r: BoardData['roundtables'][number]; onPick?: (id: number, which: 'A' | 'B') => void }) {
  const lead = leadName();
  const handed = r.proposals.filter(p => p.ok).map(p => p.agent), missed = r.proposals.filter(p => !p.ok).map(p => p.agent);
  return <div className="v8-lead v8-rt"><img className="v8-g" src={art('boss', r.state === 'choosing' ? 'pointing' : 'listening')} alt={lead} />
    <div className="v8-bubble">
      <span className="v8-cap">{tr('圆桌 · ')}{r.title}</span>
      {r.state === 'proposing' && <p>{tr('几只小怪在各自出方案，互相看不到。')}{handed.length ? tr('已交：') + handed.join(tr('、')) + tr('。') : tr('还没有人交。')}{missed.length ? missed.join(tr('、')) + tr(' 没交上来。') : ''}</p>}
      {r.state === 'merging' && <p>{tr('方案到齐了（')}{handed.join(tr('、'))}{tr('），')}{lead}{tr('在整理成 Plan A / Plan B。')}</p>}
      {r.state === 'choosing' && r.plans && <>
        <p>{r.plans.note || tr('两个方案整理好了。')}{tr('每个方案的说明在')}{lead}{tr('那页（点中间的')}{lead}{tr('）。')}</p>
        {onPick && <div className="v8-opts">{(['A', 'B'] as const).map(k => { const p = k === 'A' ? r.plans!.a : r.plans!.b; const rec = r.plans!.recommended === k;
          return <button key={k} type="button" className={'v8-opt' + (rec ? ' is-rec' : '')} title={p.summary} onClick={() => onPick(r.id, k)}>{tr('选 Plan ')}{k}{tr('：')}{p.title}{rec ? tr('（推荐）') : ''}</button>; })}</div>}
      </>}
    </div>
  </div>;
}

/**
 * 工序链 in the talk bar (A15): the stages in order, which are done, and once a stage was accepted a button to start
 * the next one (by hand first, requirement 47).
 */
export function ChainCard({ c, onNext }: { c: BoardData['chains'][number]; onNext?: (id: number) => void }) {
  const mark = (s: BoardData['chains'][number]['stages'][number]) => s.state === 'DONE' ? ' ✓' : s.state ? ' · ' + TICKET_STATE_LABEL[s.state] : '';
  const next = c.next !== null ? c.stages[c.next] : null;
  return <div className="v8-lead v8-rt v8-chain"><img className="v8-g" src={art('boss', next ? 'pointing' : 'listening')} alt={leadName()} />
    <div className="v8-bubble">
      <span className="v8-cap">{tr('工序链 · ')}{c.title}</span>
      <p>{c.stages.map((s, i) => (i + 1) + ' ' + s.title + mark(s)).join(' → ')}</p>
      {next && <>
        <p>{tr('上一道收下了。下一道：{0}——{1}', [next.title, next.what])}</p>
        {onNext && <div className="v8-opts"><button type="button" className="v8-opt is-rec" onClick={() => onNext(c.id)}>{tr('开下一道：{0}', [next.title])}</button></div>}
      </>}
    </div>
  </div>;
}

/**
 * 拆解 in the talk bar (A12): a gremlin working out how a big job comes apart, then its pieces for the boss to approve,
 * or why it can't be split. Nothing starts until the boss decides (requirement 34).
 */
export function SplitCard({ s, onDecide }: { s: BoardData['splits'][number]; onDecide?: (id: number, how: 'split' | 'whole') => void }) {
  return <div className="v8-lead v8-rt v8-chain"><img className="v8-g" src={art('boss', s.state === 'choosing' ? 'pointing' : 'listening')} alt={leadName()} />
    <div className="v8-bubble">
      <span className="v8-cap">{tr('拆解 · ')}{s.title}</span>
      {s.state === 'splitting' && <p>{tr('{0} 在读项目，看这件活能不能拆开同时做。', [s.by])}</p>}
      {s.state === 'choosing' && <>
        {s.canSplit
          ? <><p>{tr('{0} 建议拆成 {1} 件，同时做：', [s.by, s.pieces.length])}</p>
            {s.pieces.map((p, i) => <p key={i}><b>{(i + 1) + '. ' + p.title}</b>{tr('：') + p.what}</p>)}
            <p>{s.why}</p></>
          : <p>{tr('{0} 觉得拆不开：{1}', [s.by, s.why])}</p>}
        {onDecide && <div className="v8-opts">
          {s.canSplit && <button type="button" className="v8-opt is-rec" onClick={() => onDecide(s.id, 'split')}>{tr('照这样拆，一起做')}</button>}
          <button type="button" className={'v8-opt' + (s.canSplit ? '' : ' is-rec')} onClick={() => onDecide(s.id, 'whole')}>{tr('不拆，整件做')}</button>
        </div>}
      </>}
    </div>
  </div>;
}
