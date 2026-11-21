import { dateLocale, tr } from '@shared/i18n';
import { leadName } from '../leadName';
import { moneyText } from '@shared/v8/board';
import './pages.css';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { MicButton } from '../MicButton';
import { WORK_STEPS, type BoardData, type DeliveryDetail, type ReviewDetail, type SlotDetail } from '@shared/v8/board';
import type { TicketView } from '@shared/v8/tickets';
import { art, poseFor, slotCast } from '../gremlins';
import { ChainCard, SplitCard } from '../board/Board';
import { AgentBadge } from '../AgentBadge';
import { QuotaLine, resetText } from '../QuotaLine';
import { MAGPIE_NOTE, MAGPIE_PREFIX, MagpieGroups, ownMaker, useMagpieModels } from '../MagpieOptions';
import type { AgentQuota, ChoiceList, SessionChoices } from '@shared/v8/agents';
import './agents.css';

/**
 * The five local pages (前端方向.md). Each one is about one thing and has one gremlin as its hero; the hero carries
 * the view-transition name while a page change runs, so it flies between the board and the page.
 * Layouts are the prototype's (prototype/works.views.html, works.more.txt), in canvas pixels.
 */

export type Hero = CSSProperties | undefined;

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);
const CN = [tr('零'), tr('一'), tr('两'), tr('三'), tr('四'), tr('五'), tr('六'), tr('七'), tr('八'), tr('九'), tr('十')];
const cn = (n: number) => (n <= 10 ? CN[n] : String(n));
const enter = (fn: () => void) => (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); fn(); } };

function Ask({ placeholder, action, onSend, extra }: { placeholder: string; action: string; onSend(text: string): void; extra?: React.ReactNode }) {
  const [text, setText] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const send = () => { const v = text.trim(); if (v) { onSend(v); setText(''); } };
  return <div className="v8p-ask">
    <input ref={field} value={text} onChange={e => setText(e.target.value)} onKeyDown={enter(send)} placeholder={placeholder} aria-label={placeholder} />
    <MicButton input={field} />
    <button type="button" className="v8-send" onClick={send}>{action}</button>{extra}
  </div>;
}

// ---------- 工位 ----------

export function SlotPage({ d, now, hero, harness, onPoke, onStop, onWait, onModel, onEffort }: { d: SlotDetail; now: number; hero: Hero; harness: BoardData['harness']; onPoke(text: string): void; onStop(): void; onWait?(): void; onModel?(model: string): void; onEffort?(effort: string): void }) {
  const { slot: s } = d;
  const t = s.ticket!;
  return <section className="v8p v8p-slot" aria-label={s.slot.label + ' · ' + t.title}>
    <div className="v8p-floor" />
    <div className="v8p-sign"><span className="v8-cap">{tr('正在')}</span><div className="v8p-biglive">{d.log[0] ? d.log[0].kind + ' ' + d.log[0].text : s.live}</div></div>
    <img className="v8-g v8p-hero" style={hero} src={art(slotCast(s.order), poseFor(t.state, s.phase))} alt="" />
    <div className="v8p-bench"><span className="v8-cap">{tr('已经干了')}</span>
      <div className="v8p-clock">{s.startedAt ? clock(now - s.startedAt) : '--:--'}<small>{moneyText(s.costUsd, s.costSure)}</small></div>
      <div className="v8p-bar"><i style={{ width: `${(s.step + .5) / WORK_STEPS.length * 100}%` }} /></div>
    </div>
    <div className="v8p-panel">
      <span className="v8-cap">{s.slot.label}{s.slot.model ? ' · ' + s.slot.model : ''} · {s.phase === 'checking' ? tr('在验证') : tr('在干活')}</span>
      <blockquote>{t.originalRequest}</blockquote>
      <span className="v8-cap">{tr('你 ')}{hhmm(d.saidAt)} {tr(' 说的原话，一个字没改')}</span>
      <ol className="v8p-steps">{WORK_STEPS.map((n, i) => <li key={n} className={i < s.step ? 'is-done' : i === s.step ? 'is-now' : ''}>{n}</li>)}</ol>
      <div className="v8p-cols">
        <div><span className="v8-cap">{tr('它在做什么')}</span>
          <div className="v8p-log">{d.log.map(l => <div key={l.id} className={l.kind === tr('你说') ? 'is-boss' : ''}><b>{l.kind}</b>{l.text}</div>)}</div></div>
        <div><span className="v8-cap">{tr('背后是谁')}</span>
          <AgentBadge harness={harness} model={d.tuning?.model ?? s.slot.model} />
          {d.tuning?.agent && <Tuning agent={d.tuning.agent} model={d.tuning.model} effort={d.tuning.effort} working={t.state === 'WORKING'} onWait={onWait} onModel={onModel} onEffort={onEffort} />}
          <span className="v8-cap v8p-gap">{tr('动过的文件')}</span>
          {d.files.map(f => <div key={f.path} className="v8p-file"><b>{f.path}</b>{f.plus + f.minus > 0 && <><i className="is-plus">+{f.plus}</i><i className="is-minus">−{f.minus}</i></>}</div>)}
          {!d.files.length && <p className="v8p-qa">{tr('还没动文件。')}</p>}
          {d.question && <><span className="v8-cap v8p-gap">{tr('它问过你')}</span>
            <p className="v8p-qa">{d.question.text}{d.question.open && <em>{tr('还没回答')}</em>}</p></>}
        </div>
      </div>
      <Ask placeholder={tr('只对这只小怪插一句话，比如：别动工具栏的样式')} action={tr('插话')} onSend={onPoke}
        extra={<button type="button" className="v8p-stop" onClick={onStop}>{tr('叫停')}</button>} />
    </div>
  </section>;
}

/**
 * 额度和模型 on a gremlin's bench (第 4 步): its agent's quota, and the boss's three levers. The model and effort lists
 * are the agent's own (read by starting it, no message sent). Changing one while it works stops it for a moment and it
 * goes on in the same conversation.
 */
function Tuning({ agent, model, effort, working, onWait, onModel, onEffort }: { agent: string; model: string | null; effort: string | null; working: boolean; onWait?(): void; onModel?(m: string): void; onEffort?(e: string): void }) {
  const [quota, setQuota] = useState<AgentQuota | undefined>(undefined);
  const [offered, setOffered] = useState<SessionChoices | string | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => { let on = true; window.cth.v8.agentQuota(agent).then(q => { if (on) setQuota(q); }, () => undefined); return () => { on = false; }; }, [agent]);
  const ask = () => {
    setAsking(true);
    window.cth.v8.agentChoices(agent).then(setOffered, e => setOffered(e instanceof Error ? e.message : String(e))).finally(() => setAsking(false));
  };
  const magpie = useMagpieModels(offered !== null && typeof offered === 'object');
  const pick = (label: string, list: ChoiceList | null, now: string | null, go?: (v: string) => void, withMagpie = false) => list && go && <label className="v8a-select"><span className="v8-cap">{label}</span>
    <select value={now ?? list.current ?? ''} onChange={e => go(e.target.value)}>
      {!(now ?? list.current) && <option value="" disabled>{tr('它自己默认的')}</option>}
      {withMagpie && <optgroup label={tr('它自己的模型')}>{list.choices.map(c => <option key={c.id} value={c.id}>{c.group ? c.group + ' · ' : ''}{c.label}</option>)}</optgroup>}
      {!withMagpie && list.choices.map(c => <option key={c.id} value={c.id}>{c.group ? c.group + ' · ' : ''}{c.label}</option>)}
      {withMagpie && <MagpieGroups models={magpie} skip={ownMaker(agent)} />}
    </select></label>;
  return <div className="v8p-tuning">
    <span className="v8-cap v8p-gap">{tr('额度')}</span>
    <QuotaLine q={quota} compact />
    <div className="v8p-acts">
      {working && onWait && <button type="button" className="v8p-act" onClick={onWait} title={tr('先停下，等额度重置后自己接着干')}>{tr('等一等')}</button>}
      {offered === null && <button type="button" className="v8p-act" disabled={asking} onClick={ask}>{asking ? tr('正在问它有哪些…') : tr('换个模型 / 换推理档位')}</button>}
    </div>
    {typeof offered === 'string' && <p className="v8p-qa">{tr('没读到它有哪些模型：')}{offered}</p>}
    {offered && typeof offered === 'object' && <div className="v8a-pick">
      {pick(tr('换个模型'), offered.model, model, onModel, true)}
      {pick(tr('换推理档位'), offered.effort, effort, onEffort)}
      {!offered.model && !offered.effort && <p className="v8p-qa">{tr('这个 agent 不让选模型和档位。')}</p>}
    </div>}
    {offered && typeof offered === 'object' && working && <p className="v8p-qa">{tr('干活时换，它会停一下，换好后接着刚才的对话干。')}</p>}
    {model?.startsWith(MAGPIE_PREFIX) && <p className="v8p-qa">{MAGPIE_NOTE}</p>}
  </div>;
}

// ---------- 总管 ----------

export function LeadPage({ data, hero, onSay, onAnswer, onOpenDelivery, onRetry, onResume, onPick, onNotes, onNextStage, onSplit }: {
  data: BoardData; hero: Hero; onSay(text: string): void; onAnswer(ticketId: number, optionId: string): void; onOpenDelivery(ticketId: number): void; onRetry?(ticketId: number): void; onResume?(ticketId: number): void;
  /** 圆桌会议 (A6): the boss picks Plan A or B. */
  onPick?(roundtableId: number, which: 'A' | 'B'): void;
  /** A10: the project's notebook. */
  onNotes?(): void;
  /** A15: start a 工序链's next stage. */
  onNextStage?(chainId: number): void;
  /** A12: decide on a split. */
  onSplit?(id: number, how: 'split' | 'whole'): void;
}) {
  const working = data.slots.filter(s => s.ticket).length + (data.emergency?.ticket ? 1 : 0);
  const questions = data.talk.filter(t => t.question);
  const results = data.waiting.filter(t => t.state === 'REVIEW');
  const stuck = data.waiting.filter(t => t.state === 'BLOCKED' || t.state === 'FAILED');
  return <section className="v8p v8p-lead" aria-label={leadName()}>
    <div className="v8p-sun" />
    <img className="v8-g v8p-hero" style={hero} src={art('boss', results.length ? 'thumbs_up' : stuck.length ? 'shrugging' : questions.length ? 'pointing' : 'listening')} alt={leadName()} />
    <div className="v8p-whocard"><span className="v8-cap">{tr('背后是谁')}</span><AgentBadge harness={data.harness} model={data.agents.lead} /></div>
    <div className="v8p-talkcol">
      <span className="v8-cap">{data.project} · {new Date(data.now).toLocaleDateString(dateLocale(), { weekday: 'short' })} {hhmm(data.now)}
        {onNotes && <button type="button" className="v8-quiet-btn v8n-open" onClick={onNotes}>{tr('项目笔记 →')}</button>}</span>
      <h1>{working ? tr('{0}只小怪在干活，', [cn(working)]) : tr('小怪们都闲着，')}<br />
        {data.waiting.length ? <mark>{cn(data.waiting.length)}{tr('件事等你')}</mark> : tr('没有事等你')}{tr('，')}<span>{data.queue.length ? tr('{0}张在排队。', [cn(data.queue.length)]) : tr('没有排队的。')}</span></h1>
      <div className="v8p-turns">
        {data.splits.map(s => <SplitCard key={'sp' + s.id} s={s} {...(onSplit ? { onDecide: onSplit } : {})} />)}
        {data.chains.map(c => <ChainCard key={'ch' + c.id} c={c} {...(onNextStage ? { onNext: onNextStage } : {})} />)}
        {data.roundtables.map(r => <div key={'rt' + r.id} className="v8p-turn"><span className="v8-cap">{tr('圆桌 · ')}{r.title}</span>
          {r.state === 'proposing' && <p>{tr('几只小怪在各自出方案，互相看不到。')}{r.proposals.filter(p => p.ok).length ? tr('已交：') + r.proposals.filter(p => p.ok).map(p => p.agent).join(tr('、')) + tr('。') : ''}</p>}
          {r.state === 'merging' && <p>{tr('方案到齐了，我在整理成 Plan A / Plan B。')}</p>}
          {r.state === 'choosing' && r.plans && <>
            {r.plans.note && <p>{r.plans.note}</p>}
            {(['A', 'B'] as const).map(k => { const p = k === 'A' ? r.plans!.a : r.plans!.b;
              return <p key={k} className="v8p-plan"><b>Plan {k}{tr('：')}{p.title}</b>{p.from ? <em>{tr('出自 ')}{p.from}</em> : null}<br />{p.summary}</p>; })}
            {onPick && <div className="v8p-acts">{(['A', 'B'] as const).map(k => <button key={k} type="button" className={'v8p-act' + (r.plans!.recommended === k ? ' is-go' : '')}
              onClick={() => onPick(r.id, k)}>{tr('选 Plan ')}{k}{r.plans!.recommended === k ? tr('（我推荐）') : ''}</button>)}</div>}
          </>}</div>)}
        {questions.map(q => <div key={q.id} className="v8p-turn"><span className="v8-cap">{tr('替小怪问你')}</span><p>{q.text}</p>
          <div className="v8p-acts">{q.question!.options.map(o => <button key={o.id} type="button" className={'v8p-act' + (o.id === q.question!.recommended ? ' is-go' : '')}
            onClick={() => onAnswer(q.question!.ticketId, o.id)}>{o.label}{o.id === q.question!.recommended ? tr('（它推荐）') : ''}</button>)}</div></div>)}
        {results.map(t => <div key={t.id} className="v8p-turn"><span className="v8-cap">{tr('做完了，等你看')}</span><p><b>{tr('「')}{t.title}{tr('」')}</b>{tr('交了结果。')}</p>
          <div className="v8p-acts"><button type="button" className="v8p-act is-go" onClick={() => onOpenDelivery(t.id)}>{tr('看结果')}</button></div></div>)}
        {stuck.map(t => <div key={t.id} className="v8p-turn"><span className="v8-cap">{t.state === 'BLOCKED' ? tr('卡住了') : tr('失败了')}</span><p><b>{tr('「')}{t.title}{tr('」')}</b>{tr('需要你说句话，或者让它再试一次。')}</p>
          {onRetry && <div className="v8p-acts"><button type="button" className="v8p-act is-go" onClick={() => onRetry(t.id)}>{tr('再试一次')}</button></div>}</div>)}
        {data.resting.map(t => <div key={t.id} className="v8p-turn"><span className="v8-cap">{tr('等额度')}</span><p><b>{tr('「')}{t.title}{tr('」')}</b>{tr('在等额度，')}{t.quotaWait?.resetsAt ? resetText(t.quotaWait.resetsAt) + tr('后自己接着干') : tr('过一阵会自己再试')}{tr('。')}</p>
          {onResume && <div className="v8p-acts"><button type="button" className="v8p-act is-go" onClick={() => onResume(t.id)}>{tr('现在接着干')}</button></div>}</div>)}
        {!data.splits.length && !data.chains.length && !data.roundtables.length && !questions.length && !results.length && !stuck.length && !data.resting.length && <div className="v8p-turn"><p>{tr('现在没有要你决定的事。')}</p></div>}
      </div>
      <div className="v8p-bottom"><Ask placeholder={tr('跟') + leadName() + tr('说一句，比如：登录页的验证码收不到，查一下')} action={tr('发话')} onSend={onSay} />
        <div className="v8-chips">{[tr('现在都在干嘛？'), tr('停掉工位 02'), tr('把排队 03 提到最前')].map(c => <button key={c} type="button" className="v8-chip" onClick={() => onSay(c)}>{c}</button>)}</div></div>
    </div>
  </section>;
}

// ---------- 交付 ----------

export function DeliveryPage({ d, hero, onAccept, onReject, onReviewAgain }: { d: DeliveryDetail; hero: Hero; onAccept(): void; onReject(why: string): void; onReviewAgain?(): void }) {
  const [why, setWhy] = useState('');
  return <section className="v8p v8p-out" aria-label={tr('交付 · ') + d.title}>
    <div className="v8p-parcel">
      <img className="v8-g v8p-hero" style={hero} src={art('alien', 'reporting')} alt="" />
      {d.reviewPassed && <div className="v8p-stamp"><img className="v8-g" src={art('lanky', 'approve')} alt="" />{tr('审查通过')}</div>}
      {!d.reviewPassed && d.reviewNote && <img className="v8-g v8p-stampg" src={art('lanky', 'unimpressed')} alt="" />}
      {!d.reviewPassed && d.reviewNote && <p className="v8p-reviewnote" role="note">{d.reviewNote}</p>}
      {!d.reviewPassed && d.reviewNote?.startsWith(tr('审查没给结论')) && onReviewAgain && <button type="button" className="v8-back" onClick={onReviewAgain}>{tr('重新审一次')}</button>}
      <span className="v8-cap">{tr('你的原话')}</span>
      <blockquote className="is-small">{d.originalRequest}</blockquote>
      <ul className="v8p-facts"><li><b>{d.files.length}</b>{tr('个文件')}</li><li><b>{clock(d.elapsedMs)}</b>{tr('用时')}</li><li><b>{moneyText(d.costUsd, d.costSure)}</b>{tr('花费')}</li></ul>
    </div>
    <div className="v8p-proof">
      {d.shots
        ? <div className="v8p-shots"><figure><figcaption className="v8-cap">{tr('改之前')}</figcaption><img src={d.shots.before} alt={tr('改之前的截图')} /></figure>
          <figure><figcaption className="v8-cap">{tr('改之后')}</figcaption><img src={d.shots.after} alt={tr('改之后的截图')} /></figure></div>
        : <p className="v8p-summary">{d.summary}</p>}
      <span className="v8-cap">{tr('改了什么')}</span>
      {d.diff.trim() ? <pre className="v8p-diff">{d.diff.split('\n').map((l, i) => <i key={i} className={l.startsWith('+') ? 'is-plus' : l.startsWith('-') ? 'is-minus' : 'is-file'}>{l}</i>)}</pre>
        : <p className="v8p-qa">{tr('工作目录里没有改动。')}{d.files.length ? tr('它说动过：') + d.files.map(f => f.path).join(tr('、')) + tr('。') : ''}</p>}
      <div className="v8p-verify"><span className="v8-cap">{tr('它怎么验证的')}</span><code>{d.verification.command} · {d.verification.output}</code></div>
      <div className="v8p-decide">
        <button type="button" className="v8p-accept" onClick={onAccept}>{tr('收下，这张完成')}</button>
        <input value={why} onChange={e => setWhy(e.target.value)} placeholder={tr('不满意就写一句原因，再点打回')} aria-label={tr('打回的原因')} />
        <button type="button" className="v8p-reject" onClick={() => onReject(why.trim())}>{tr('打回重做')}</button>
      </div>
    </div>
  </section>;
}

// ---------- 排队 ----------

const TURNS = [-1.2, 1.4, -.6, 1, -1.6, .8];
export function QueuePage({ queue, hero, onFront, onDrop, onAdd }: { queue: TicketView[]; hero: Hero; onFront?(id: number): void; onDrop(id: number): void; onAdd(): void }) {
  return <section className="v8p v8p-queue" aria-label={tr('排队')}>
    <div className="v8p-qleft">
      <span className="v8-cap">{tr('排队')}</span>
      <h1>{queue.length ? <>{cn(queue.length)}{tr('张在排队，')}<br /><span>{tr('有空位就开工。')}</span></> : <>{tr('没有排队的，')}<br /><span>{tr('有活就跟')}{leadName()}{tr('说。')}</span></>}</h1>
      <p>{tr('按便签的顺序做。想先做哪张，把它提到最前面，或者直接告诉')}{leadName()}{tr('。')}</p>
      <img className="v8-g v8p-hero" style={hero} src={art('tri', 'long_wait')} alt="" />
    </div>
    <div className="v8p-wall">
      {queue.slice(0, 5).map((t, i) => <article key={t.id} className="v8p-bignote" style={{ transform: `rotate(${TURNS[i]}deg)` }}><i className="v8p-pin" />
        <small>{String(i + 1).padStart(2, '0')}{i === 0 ? tr(' · 下一张') : ''}</small><h3>{t.title}</h3><q>{t.originalRequest}</q>
        <div className="v8p-nacts">{i > 0 && onFront && <button type="button" onClick={() => onFront(t.id)}>{tr('提到最前')}</button>}<button type="button" onClick={() => onDrop(t.id)}>{tr('撤掉')}</button><time>{hhmm(t.createdAt)} {tr(' 加的')}</time></div>
      </article>)}
      <button type="button" className="v8p-bignote is-add" onClick={onAdd}><span>{tr('＋ 再加一张')}</span><em>{tr('在')}{leadName()}{tr('那里跟它说就行')}</em></button>
    </div>
  </section>;
}

// ---------- 审查 ----------

export function ReviewPage({ d, enabled, hero, harness, model }: { d: ReviewDetail; enabled: boolean; hero: Hero; harness: BoardData['harness']; model: string | null }) {
  return <section className="v8p v8p-review" aria-label={tr('审查')}>
    <div className="v8p-booth">
      <div className="v8p-post" /><div className="v8p-gate" />
      <img className="v8-g v8p-hero" style={hero} src={art('lanky', !enabled ? 'idle' : !d.latest ? 'checking' : d.latest.checks.every(c => c.ok) ? 'approve' : 'reject')} alt="" />
      <div className="v8p-rulecard"><span className="v8-cap">{tr('审查的规矩')}</span>
        <p>{tr('它看不到干活小怪的对话，只拿到三样东西：')}<b>{tr('你的原话、改动、验证结果')}</b>{tr('。过了它这关，才会来找你。')}</p>
        <span className="v8-cap v8p-gap">{tr('背后是谁')}</span><AgentBadge harness={harness} model={model} /></div>
    </div>
    <div className="v8p-checks">
      {!enabled && <p className="v8p-summary">{tr('审查还没开工。现在做完的活会直接交给你看。')}</p>}
      {d.latest && <><span className="v8-cap">{tr('刚审完 · ')}{d.latest.title}</span>
        <ul className="v8p-tick">{d.latest.checks.map(c => <li key={c.label} className={c.ok ? '' : 'is-no'}><b>{c.label}</b><span>{c.detail}</span></li>)}</ul></>}
      <span className="v8-cap v8p-gap">{tr('今天审了 ')}{d.history.length} {tr(' 张')}</span>
      {d.history.map(h => <div key={h.id} className="v8p-hist"><img className="v8-g v8p-histg" src={art('lanky', h.ok ? 'approve' : 'reject')} alt="" /><i className={h.ok ? 'is-ok' : 'is-no'}>{h.ok ? tr('通过') : tr('打回')}</i><b>{h.title}</b>{h.note && <span>{h.note}</span>}<time>{hhmm(h.at)}</time></div>)}
    </div>
  </section>;
}

/** Re-render once a second so clocks on a page tick even when no data changes. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  return now;
}
