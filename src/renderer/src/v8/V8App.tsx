import './v8.css';
import { useEffect, useRef, useState } from 'react';
import type { ArchiveItem, DeliveryDetail, LedgerDetail, ReviewDetail, SlotDetail, TimelineItem } from '@shared/v8/board';
import { Canvas } from './Canvas';
import { TopBar } from './TopBar';
import { ProjectSwitcher } from './ProjectSwitcher';
import { Board } from './board/Board';
import { DeliveryPage, LeadPage, QueuePage, ReviewPage, SlotPage, useNow } from './pages/Pages';
import { ArchivePage, CrewPage, LedgerPage, TimelinePage } from './pages/MorePages';
import { AgentsPage } from './pages/AgentsPage';
import { SkillsPage } from './pages/SkillsPage';
import { setLeadName } from './leadName';
import { SetupPage } from './pages/SetupPage';
import { explain, useWorkbench } from './useWorkbench';
import { art } from './gremlins';
import { HERO_NAME, transition, type HeroKey, type View } from './views';

const NO_REVIEW: ReviewDetail = { latest: null, history: [] };

/**
 * The app's root: 小怪工坊 is the v8 workbench only.
 * The board is the global view; a door on it opens one local page, and the gremlin that was clicked flies there.
 * Everything comes from the workbench in the main process (useWorkbench); nothing here is sample data.
 */
export function V8App() {
  const w = useWorkbench();
  const { data } = w;
  const now = useNow();
  const [view, setView] = useState<View>({ kind: 'board' });
  const [slot, setSlot] = useState<SlotDetail | null>(null);
  const [delivery, setDelivery] = useState<DeliveryDetail | null>(null);
  const [review, setReview] = useState<ReviewDetail>(NO_REVIEW);
  const [ledger, setLedger] = useState<LedgerDetail | null>(null);
  const [archive, setArchive] = useState<ArchiveItem[]>([]);
  const [drawer, setDrawer] = useState('live');
  const [timeline, setTimeline] = useState<{ title: string; items: TimelineItem[] } | null>(null);
  /** Which side carries the hero name during a page change: a board gremlin, or the page's hero. */
  const [hero, setHero] = useState<{ board?: HeroKey; page?: true } | null>(null);
  const origin = useRef<HeroKey | null>(null);

  /** Detail pages fetch first, so the gremlin always has somewhere to fly to. */
  const open = async (next: View, from: HeroKey | null) => {
    let s: SlotDetail | null = null, d: DeliveryDetail | null = null, l: LedgerDetail | null = null, a: ArchiveItem[] | null = null, t: TimelineItem[] | null = null;
    try {
      if (next.kind === 'slot') { s = await window.cth.v8.slot(next.slotId); if (!s) return; }
      if (next.kind === 'delivery') { d = await window.cth.v8.delivery(next.ticketId); if (!d) return; }
      if (next.kind === 'ledger') l = await window.cth.v8.ledger();
      if (next.kind === 'archive') a = await window.cth.v8.archive();
      if (next.kind === 'timeline') { t = await window.cth.v8.timeline(next.ticketId); if (!t.length) return; }
    } catch { return; }
    // A timeline opened from the archive goes back to the archive, not the board.
    if (next.kind !== 'timeline') origin.current = from;
    const title = next.kind === 'timeline' ? (archive.find(i => i.id === next.ticketId)?.title ?? '#' + next.ticketId) : '';
    transition(() => { setSlot(s); setDelivery(d); if (l) setLedger(l); if (a) setArchive(a); if (t) setTimeline({ title, items: t }); setView(next); },
      where => setHero(where === 'old' ? (from ? { board: from } : null) : where === 'new' ? { page: true } : null));
  };
  const back = () => {
    if (view.kind === 'timeline') { transition(() => setView({ kind: 'archive' }), () => setHero(null)); return; }
    const to = origin.current;
    transition(() => setView({ kind: 'board' }), where => setHero(where === 'old' ? { page: true } : where === 'new' ? (to ? { board: to } : null) : null));
  };
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) backRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep an open detail page current; when its subject is gone (reported, accepted, stopped) go back to the board.
  useEffect(() => {
    let live = true;
    const gone = () => { if (live) backRef.current(); };
    if (view.kind === 'slot') void window.cth.v8.slot(view.slotId).then(s => { if (!live) return; if (s) setSlot(s); else gone(); }, () => undefined);
    if (view.kind === 'review') void window.cth.v8.review().then(r => { if (live) setReview(r); }, () => undefined);
    if (view.kind === 'ledger') void window.cth.v8.ledger().then(l => { if (live) setLedger(l); }, () => undefined);
    if (view.kind === 'archive') void window.cth.v8.archive().then(a => { if (live) setArchive(a); }, () => undefined);
    if (view.kind === 'timeline') void window.cth.v8.timeline(view.ticketId).then(t => { if (live && t.length) setTimeline(old => ({ title: old?.title ?? '', items: t })); }, () => undefined);
    if (view.kind === 'delivery') void window.cth.v8.delivery(view.ticketId).then(d => { if (!live) return; if (d) setDelivery(d); else gone(); }, () => undefined);
    return () => { live = false; };
  }, [data, view]);

  if (!data) {
    return <div className="v8"><Canvas label="小怪工坊 新工作台">
      <TopBar project="新工作台" stats={{ working: 0, slots: 0, queued: 0, waiting: 0, spentUsd: 0 }} />
      <section className="v8-stage"><div className="v8-dots" />
        <div className="v8-empty">
          <img className="v8-g" src={art('boss', w.error ? 'stalled' : 'idle')} alt="" />
          <h1>{w.error ? '小怪A没上成班' : '小怪A正在上班…'}</h1>
          <p>{w.error ? explain(w.error) : '第一次打开要准备工作目录，稍等几秒。'}</p>
          {w.error && <button type="button" className="v8-back" onClick={w.refresh}>再试一次</button>}
        </div>
      </section>
    </Canvas></div>;
  }

  setLeadName(data.leadName);
  // 第一次打开（第 26 条）：还没给角色选本机 agent 时，先到设置页。
  const firstRun = data.harness.kind !== 'acp';
  const stats = {
    working: data.slots.filter(s => s.ticket).length + (data.emergency?.ticket ? 1 : 0),
    slots: data.slots.length,
    emergency: !!data.emergency,
    queued: data.queue.length,
    waiting: data.waiting.length,
    spentUsd: data.spentTodayUsd,
    spentSure: data.spentSure,
  };
  const heroStyle = hero?.page ? { viewTransitionName: HERO_NAME } : undefined;
  const go = (next: View, from: HeroKey | null) => { void open(next, from); };
  return (
    <div className="v8">
      <Canvas label="小怪工坊 调度台">
        {view.kind === 'board' && !firstRun && <Board data={{ ...data, now }} onSay={w.say} onAnswer={w.answer} open={go} heroKey={hero?.board ?? null} />}
        {view.kind === 'slot' && slot?.slot.ticket && <SlotPage d={slot} now={now} hero={heroStyle} harness={data.harness}
          onPoke={text => w.tell(slot.slot.ticket!.id, text)} onStop={() => w.stop(slot.slot.ticket!.id)}
          onWait={() => w.waitForQuota(slot.slot.ticket!.id)} onModel={m => w.switchModel(slot.slot.ticket!.id, m)} onEffort={e => w.switchEffort(slot.slot.ticket!.id, e)} />}
        {view.kind === 'lead' && <LeadPage data={{ ...data, now }} hero={heroStyle} onSay={w.say} onAnswer={w.answer}
          onOpenDelivery={id => go({ kind: 'delivery', ticketId: id }, null)} onRetry={w.retry} onResume={w.resumeNow} />}
        {view.kind === 'delivery' && delivery && <DeliveryPage d={delivery} hero={heroStyle} onAccept={() => w.accept(delivery.ticketId)} onReject={why => w.reject(delivery.ticketId, why)} onReviewAgain={() => { w.reviewAgain(delivery.ticketId); back(); }} />}
        {view.kind === 'queue' && <QueuePage queue={data.queue} hero={heroStyle} onFront={w.front} onDrop={w.stop} onAdd={() => go({ kind: 'lead' }, null)} />}
        {view.kind === 'review' && <ReviewPage d={review} enabled={data.review.enabled} hero={heroStyle} harness={data.harness} model={data.agents.review} />}
        {view.kind === 'ledger' && ledger && <LedgerPage d={ledger} hero={heroStyle} />}
        {view.kind === 'archive' && <ArchivePage items={archive} drawer={drawer} onDrawer={setDrawer} onOpen={id => go({ kind: 'timeline', ticketId: id }, null)} hero={heroStyle} />}
        {view.kind === 'timeline' && timeline && <TimelinePage title={timeline.title} items={timeline.items} hero={heroStyle} />}
        {view.kind === 'crew' && <CrewPage data={data} hero={heroStyle} />}
        {view.kind === 'agents' && <AgentsPage hero={heroStyle} />}
        {view.kind === 'skills' && <SkillsPage hero={heroStyle} />}
        {(view.kind === 'setup' || firstRun) && <SetupPage hero={heroStyle} first={firstRun} onDone={() => { setView({ kind: 'board' }); w.refresh(); }} />}
        <TopBar project={data.project} stats={stats} onBack={view.kind === 'board' ? undefined : back}
          onStat={door => go({ kind: door }, null)} onAgents={view.kind === 'agents' ? undefined : () => go({ kind: 'agents' }, null)}
          onSkills={view.kind === 'skills' ? undefined : () => go({ kind: 'skills' }, null)}
          onSetup={view.kind === 'setup' || firstRun ? undefined : () => go({ kind: 'setup' }, null)}
          projectSlot={<ProjectSwitcher name={data.project} working={stats.working} onSwitched={() => { setView({ kind: 'board' }); w.refresh(); }} />} />
        {w.notice && <div className="v8-notice" role="status">{w.notice}</div>}
      </Canvas>
    </div>
  );
}
