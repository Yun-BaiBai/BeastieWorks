import { anyLang, dateLocale, tr } from '@shared/i18n';

/** How long a leading "没办成：" is (in the language it was said in), so it can be cut. */
const leadLength = (t: string) => anyLang('没办成：').find(w => t.startsWith(w))?.length ?? 0;
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
import { NotesPage } from './pages/NotesPage';
import { setLeadName } from './leadName';
import { SetupPage } from './pages/SetupPage';
import { DeskPage } from './pages/DeskPage';
import { RolePage } from './pages/RolePage';
import { code, explain, useWorkbench } from './useWorkbench';
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
  const [rescue, setRescue] = useState<'agents' | 'setup' | null>(null);
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
  // When the board was last read fine, for the "连不上工作台" notice (A13).
  const lostAt = useRef('');
  useEffect(() => { if (w.data && !w.error) lostAt.current = new Date().toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }); }, [w.data, w.error]);

  /** Detail pages fetch first, so the gremlin always has somewhere to fly to. */
  const open = async (next: View, from: HeroKey | null) => {
    let s: SlotDetail | null = null, d: DeliveryDetail | null = null, l: LedgerDetail | null = null, a: ArchiveItem[] | null = null, t: TimelineItem[] | null = null;
    try {
      // A13: a door that cannot open says why instead of doing nothing.
      if (next.kind === 'slot') { s = await window.cth.v8.slot(next.slotId); if (!s) { w.flash(tr('这个工位刚空出来，小怪已经交活了。')); return; } }
      if (next.kind === 'delivery') { d = await window.cth.v8.delivery(next.ticketId); if (!d) { w.flash(tr('这件活已经处理过了。')); return; } }
      if (next.kind === 'ledger') l = await window.cth.v8.ledger();
      if (next.kind === 'archive') a = await window.cth.v8.archive();
      if (next.kind === 'timeline') { t = await window.cth.v8.timeline(next.ticketId); if (!t.length) { w.flash(tr('这张工单还没有记录。')); return; } }
    } catch (e) { w.flash(tr('没打开：') + explain(code(e)).slice(leadLength(explain(code(e))))); return; }
    // A timeline opened from the archive goes back to the archive, not the board.
    if (next.kind !== 'timeline') origin.current = from;
    const title = next.kind === 'timeline' ? (archive.find(i => i.id === next.ticketId)?.title ?? '#' + next.ticketId) : '';
    transition(() => { setSlot(s); setDelivery(d); if (l) setLedger(l); if (a) setArchive(a); if (t) setTimeline({ title, items: t }); setView(next); },
      where => setHero(where === 'old' ? (from ? { board: from } : null) : where === 'new' ? { page: true } : null), from !== null);
  };
  const back = () => {
    if (view.kind === 'timeline') { transition(() => setView({ kind: 'archive' }), () => setHero(null), false); return; }
    const to = origin.current;
    transition(() => setView({ kind: 'board' }), where => setHero(where === 'old' ? { page: true } : where === 'new' ? (to ? { board: to } : null) : null), to !== null);
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
    // The lead could not start (sign-in gone, agent removed): the agent list and the settings, which need no
    // workbench, stay open so the boss can put it right (C3 review, finding 5).
    const off = { working: 0, slots: 0, queued: 0, waiting: 0, spentUsd: 0 };
    if (w.error && rescue) {
      return <div className="v8"><Canvas label={tr('小怪工坊 新工作台')}>
        {rescue === 'agents' ? <AgentsPage hero={undefined} /> : <SetupPage hero={undefined} first={false} onDone={() => { setRescue(null); w.refresh(); }} />}
        <TopBar project={tr('新工作台')} stats={off} onBack={() => { setRescue(null); w.refresh(); }} />
      </Canvas></div>;
    }
    return <div className="v8"><Canvas label={tr('小怪工坊 新工作台')}>
      <TopBar project={tr('新工作台')} stats={off} {...(w.error ? { onAgents: () => setRescue('agents'), onSetup: () => setRescue('setup') } : {})} />
      <section className="v8-stage"><div className="v8-dots" />
        <div className="v8-empty">
          <img className="v8-g" src={art('boss', w.error ? 'stalled' : 'idle')} alt="" />
          <h1>{w.error ? tr('主理小怪没上成班') : tr('主理小怪正在上班…')}</h1>
          <p>{w.error ? explain(w.error) : tr('第一次打开要准备工作目录，稍等几秒。')}</p>
          {w.error && <button type="button" className="v8-back" onClick={w.refresh}>{tr('再试一次')}</button>}
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
      <Canvas label={tr('小怪工坊 调度台')}>
        {view.kind === 'board' && !firstRun && <Board data={{ ...data, now }} onSay={w.say} onAnswer={w.answer} onPick={w.pickPlan} onNextStage={w.nextStage} onSplit={w.decideSplit} open={go} heroKey={hero?.board ?? null} />}
        {view.kind === 'slot' && slot?.slot.ticket && <SlotPage d={slot} now={now} hero={heroStyle} harness={data.harness}
          onPoke={text => w.tell(slot.slot.ticket!.id, text)} onStop={() => w.stop(slot.slot.ticket!.id)}
          onWait={() => w.waitForQuota(slot.slot.ticket!.id)} onModel={m => w.switchModel(slot.slot.ticket!.id, m)} onEffort={e => w.switchEffort(slot.slot.ticket!.id, e)}
          onDesk={() => go({ kind: 'desk', slotId: slot.slot.slot.id }, null)} />}
        {view.kind === 'desk' && <DeskPage key={view.slotId} slotId={view.slotId} data={data} hero={heroStyle}
          onPick={id => setView({ kind: 'desk', slotId: id })} onOpenWork={id => go({ kind: 'slot', slotId: id }, null)} />}
        {view.kind === 'lead' && <LeadPage data={{ ...data, now }} hero={heroStyle} onSay={w.say} onAnswer={w.answer} onPick={w.pickPlan} onNextStage={w.nextStage} onSplit={w.decideSplit} onNotes={() => go({ kind: 'notes' }, null)}
          onOpenDelivery={id => go({ kind: 'delivery', ticketId: id }, null)} onRetry={w.retry} onResume={w.resumeNow}
          onSettings={() => go({ kind: 'role', role: 'lead' }, null)} />}
        {view.kind === 'delivery' && delivery && <DeliveryPage d={delivery} hero={heroStyle} onAccept={() => w.accept(delivery.ticketId)} onReject={why => w.reject(delivery.ticketId, why)} onReviewAgain={() => { w.reviewAgain(delivery.ticketId); back(); }} />}
        {view.kind === 'queue' && <QueuePage queue={data.queue} desks={Object.fromEntries(data.slots.map(s => [s.slot.id, s.slot.label]))} hero={heroStyle} onFront={w.front} onDrop={w.stop} onAdd={() => go({ kind: 'lead' }, null)} />}
        {view.kind === 'review' && <ReviewPage d={review} enabled={data.review.enabled} hero={heroStyle} harness={data.harness} model={data.agents.review}
          onSettings={() => go({ kind: 'role', role: 'reviewer' }, null)} />}
        {view.kind === 'role' && <RolePage key={view.role} role={view.role} hero={heroStyle} />}
        {view.kind === 'ledger' && ledger && <LedgerPage d={ledger} hero={heroStyle} />}
        {view.kind === 'archive' && <ArchivePage items={archive} drawer={drawer} onDrawer={setDrawer} onOpen={id => go({ kind: 'timeline', ticketId: id }, null)} hero={heroStyle} />}
        {view.kind === 'timeline' && timeline && <TimelinePage title={timeline.title} items={timeline.items} hero={heroStyle} />}
        {view.kind === 'crew' && <CrewPage data={data} hero={heroStyle} />}
        {view.kind === 'agents' && <AgentsPage hero={heroStyle} />}
        {view.kind === 'skills' && <SkillsPage hero={heroStyle} />}
        {view.kind === 'notes' && <NotesPage hero={heroStyle} project={data.project} />}
        {/* First run: the setup page stands in for the board only, so the agent list and the skills stay reachable for
            installing and signing in first (1.0 review, finding 3). */}
        {(view.kind === 'setup' || (firstRun && view.kind === 'board')) && <SetupPage hero={heroStyle} first={firstRun} onDone={() => { setView({ kind: 'board' }); w.refresh(); }} />}
        <TopBar project={data.project} stats={stats} onBack={view.kind === 'board' ? undefined : back}
          onStat={door => go({ kind: door }, null)} onAgents={view.kind === 'agents' ? undefined : () => go({ kind: 'agents' }, null)}
          onSkills={view.kind === 'skills' ? undefined : () => go({ kind: 'skills' }, null)}
          onSetup={view.kind === 'setup' || (firstRun && view.kind === 'board') ? undefined : () => go({ kind: 'setup' }, null)}
          projectSlot={<ProjectSwitcher name={data.project} working={stats.working} onSwitched={() => { setView({ kind: 'board' }); w.refresh(); }} />} />
        {w.notice ? <div className="v8-notice" role="status">{w.notice}</div>
          : w.error && <div className="v8-notice" role="status">{tr('连不上工作台，看到的是 ')}{lostAt.current} {tr(' 的样子，正在重试。')}{explain(w.error).slice(leadLength(explain(w.error)))}</div>}
      </Canvas>
    </div>
  );
}
