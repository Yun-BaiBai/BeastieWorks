import { tr } from '../../shared/i18n';
import type Database from 'better-sqlite3';
import type { Scheduler } from './scheduler';
import type { AgentShell, CostBasis, HostTool } from './shell';
import { oneShot } from './oneShot';
import { readOnlyPolicy } from './approval';
import type { RoundtablePlan, RoundtableView } from '../../shared/v8/board';

/**
 * 圆桌会议 (A6, 老板 2026-11-20; requirement 53): when the boss asks for a plan, two or three agents from different
 * makers each write one on their own, none seeing the others (no back-and-forth, requirement 31 still holds). The
 * lead then sorts them into Plan A and Plan B, and the boss picks one; the pick opens an ordinary ticket that does it.
 *
 * Who proposes: the agents the boss already chose for the lead, the gremlins and the review, each once (boss's
 * answer 2026-11-20). They may read the project but not change it (also his answer): they open in the read-only
 * mode the review uses, and every write or non-reading command is refused besides.
 *
 * Nobody makes a "best of" from the proposals' code: a proposal is words. The record is one row per roundtable in
 * the workbench's database, so a roundtable survives a restart (proposals that were running are written off).
 */

export interface Proposer { agent: string; label: string; shell: AgentShell; model: string | null; effort: string | null }

export interface RoundtableOptions {
  db: Database.Database;
  scheduler: Scheduler;
  projectRoot: string;
  /** The proposers: one per distinct agent. */
  proposers(): Proposer[];
  /** Tell the lead something (its inbox). */
  toLead(text: string): void;
  /** Open the ticket the boss picked and get it going. */
  startTicket(id: number): Promise<void>;
  onCost?(usd: number, basis: CostBasis): void;
  onChange(): void;
  clock?: () => number;
  /** Cuts off a proposer still at work when the app closes. */
  signal?: AbortSignal;
  /** Work that runs in the background, so closing can wait for it. */
  track?(work: Promise<unknown>): void;
  proposeTimeoutMs?: number;
}

export const PROPOSE_TOOL: HostTool = {
  name: 'submit_proposal',
  description: '交你的方案，只交一次。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '方案一句话的名字，20 字以内' },
      approach: { type: 'string', description: '怎么做：思路和关键步骤，几行就够' },
      tradeoffs: { type: 'string', description: '好处和代价、风险' },
      effort: { type: 'string', description: '大概要多久、多大工作量' },
    },
    required: ['title', 'approach', 'tradeoffs', 'effort'],
  },
};

export const PROPOSE_SYSTEM = [
  '你在小怪工坊的圆桌会议上，独立给老板出一个方案。还有别的小怪也在出，你看不到它们的，它们也看不到你的。',
  '你可以读项目里的文件，弄清现状；不能改任何东西，写文件和运行会改东西的命令都会被拒绝。',
  '只出方案，不动手做。方案要具体到能照着做，说清代价和风险，不说空话。',
  '想好了就调用 submit_proposal 交方案，只交一次，然后结束。',
].join('\n');

export const PROPOSE_NUDGE = '你还没有调用 submit_proposal。现在交方案：名字、怎么做、好处和代价、大概工作量。';

export const proposeBrief = (request: string) => ['老板要一个方案，他的原话：', request].join('\n');

export const PLANS_TOOL: HostTool = {
  name: 'submit_plans',
  description: '圆桌的方案都到了以后，把它们整理成 Plan A 和 Plan B 交给老板选。',
  parameters: {
    type: 'object',
    properties: {
      roundtable_id: { type: 'integer', description: '圆桌编号' },
      plan_a: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string', description: '怎么做、代价，三四行' }, from: { type: 'string', description: '出自哪几份方案' } }, required: ['title', 'summary'] },
      plan_b: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, from: { type: 'string' } }, required: ['title', 'summary'] },
      recommended: { type: 'string', enum: ['A', 'B'], description: '你推荐哪个' },
      note: { type: 'string', description: '一两句话：两者主要差在哪' },
    },
    required: ['roundtable_id', 'plan_a', 'plan_b', 'recommended', 'note'],
  },
};

export const OPEN_ROUNDTABLE_TOOL: HostTool = {
  name: 'open_roundtable',
  description: '老板要"出方案""想几个办法""比一比怎么做"，而不是直接做的时候，开圆桌：几只小怪各自独立出方案。message_id 填老板那条消息。',
  parameters: { type: 'object', properties: { message_id: { type: 'integer', description: '老板那条消息的编号' }, title: { type: 'string', description: '可选，20 字以内的短标题' } }, required: ['message_id'] },
};

interface Row { id: number; message_id: number; title: string; request: string; state: RoundtableView['state']; proposals: string; plans: string | null; picked: string | null; ticket_id: number | null; created_at: number }
interface Proposal { agent: string; label: string; ok: boolean; title?: string; approach?: string; tradeoffs?: string; effort?: string; why?: string }
interface Plans { a: RoundtablePlan; b: RoundtablePlan; recommended: 'A' | 'B'; note: string }

const text = (v: unknown, max: number, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(what + tr(' 不能空着'));
  return v.trim().slice(0, max);
};

export class Roundtable {
  private readonly now: () => number;

  constructor(private readonly o: RoundtableOptions) {
    this.now = o.clock ?? Date.now;
    o.db.exec(`CREATE TABLE IF NOT EXISTS v8_roundtables(
      id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, request TEXT NOT NULL,
      state TEXT NOT NULL, proposals TEXT NOT NULL, plans TEXT, picked TEXT, ticket_id INTEGER, created_at INTEGER NOT NULL)`);
  }

  /** After a restart, once the lead is listening: proposers do not outlive the app, so a roundtable left proposing
   *  goes on with what came in; one left with the lead is handed to it again. */
  resumeAfterRestart(): void {
    for (const r of this.rows()) {
      if (r.state === 'proposing') void this.merge(r.id);
      else if (r.state === 'merging') { this.o.db.prepare("UPDATE v8_roundtables SET state='proposing' WHERE id=?").run(r.id); void this.merge(r.id); }
    }
  }

  /** The lead's open_roundtable. The boss's words are copied from his message, never written by the lead. */
  open(messageId: number, title?: string): { id: number; agents: string[] } {
    const m = this.o.scheduler.messages(null, 500).find(x => x.id === messageId);
    if (!m || m.author !== 'boss' || m.kind !== 'say') throw new Error('V8_NEEDS_BOSS_MESSAGE');
    if (this.o.db.prepare('SELECT 1 FROM v8_roundtables WHERE message_id=?').get(messageId)) throw new Error('V8_ROUNDTABLE_EXISTS');
    const proposers = this.o.proposers();
    if (proposers.length < 2) throw new Error(tr('V8_ROUNDTABLE_NEEDS_TWO_AGENTS: 设置里主理、干活、审查只选了同一家 agent，至少要两家才开得了圆桌'));
    const request = String(m.body);
    const name = (title?.trim() || request.replace(/\s+/g, ' ')).slice(0, 20);
    const id = Number(this.o.db.prepare(`INSERT INTO v8_roundtables(message_id,title,request,state,proposals,created_at) VALUES(?,?,?,'proposing','[]',?)`)
      .run(messageId, name, request, this.now()).lastInsertRowid);
    const work = this.run(id, request, proposers);
    if (this.o.track) this.o.track(work); else void work;
    this.o.onChange();
    return { id, agents: proposers.map(p => p.label) };
  }

  /** The lead's submit_plans. */
  plans(raw: unknown): void {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = a.roundtable_id;
    const r = typeof id === 'number' ? this.row(id) : undefined;
    if (!r) throw new Error('V8_NO_SUCH_ROUNDTABLE');
    if (r.state !== 'merging') throw new Error(r.state === 'proposing' ? 'V8_PROPOSALS_NOT_IN_YET' : 'V8_PLANS_ALREADY_GIVEN');
    const plan = (v: unknown, which: string): RoundtablePlan => {
      const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      return { title: text(p.title, 60, which + tr(' 的 title')), summary: text(p.summary, 1500, which + tr(' 的 summary')), ...(typeof p.from === 'string' && p.from.trim() ? { from: p.from.trim().slice(0, 100) } : {}) };
    };
    if (a.recommended !== 'A' && a.recommended !== 'B') throw new Error(tr('recommended 只能是 A 或 B'));
    const plans: Plans = { a: plan(a.plan_a, 'plan_a'), b: plan(a.plan_b, 'plan_b'), recommended: a.recommended, note: typeof a.note === 'string' ? a.note.trim().slice(0, 300) : '' };
    this.o.db.prepare(`UPDATE v8_roundtables SET state='choosing', plans=? WHERE id=?`).run(JSON.stringify(plans), r.id);
    this.o.onChange();
  }

  /** The boss picks a plan: an ordinary ticket opens from his own message and the plan reaches the gremlin as his
   *  choice (boss's answer 2026-11-20: start at once). */
  async pick(id: number, which: 'A' | 'B'): Promise<number> {
    const r = this.row(id);
    if (!r || r.state !== 'choosing' || !r.plans) throw new Error('V8_NOTHING_TO_PICK');
    const plans = JSON.parse(r.plans) as Plans;
    const p = which === 'A' ? plans.a : plans.b;
    const ticket = this.o.scheduler.openTicket({ fromMessageId: r.message_id, routingNote: tr('按老板在圆桌上选的 Plan {0} 做', [which]), title: p.title.slice(0, 40) });
    this.o.scheduler.tellTicket(ticket, tr('我在圆桌会议上选了 Plan {0}：{1}\n{2}\n照这个方案做。', [which, p.title, p.summary]));
    this.o.db.prepare(`UPDATE v8_roundtables SET state='picked', picked=?, ticket_id=? WHERE id=?`).run(which, ticket, id);
    await this.o.startTicket(ticket);
    this.o.onChange();
    return ticket;
  }

  /** What the board shows: roundtables still going or waiting for the boss. */
  views(): RoundtableView[] {
    return this.rows().filter(r => r.state !== 'picked' && r.state !== 'failed').map(r => {
      const proposals = JSON.parse(r.proposals) as Proposal[];
      const plans = r.plans ? JSON.parse(r.plans) as Plans : null;
      return { id: r.id, title: r.title, request: r.request, state: r.state, messageId: r.message_id, createdAt: r.created_at,
        proposals: proposals.map(p => ({ agent: p.label, ok: p.ok, title: p.title ?? null, why: p.why ?? null })),
        ...(plans ? { plans: { a: plans.a, b: plans.b, recommended: plans.recommended, note: plans.note } } : {}) };
    });
  }

  // ---------- internals ----------

  private async run(id: number, request: string, proposers: Proposer[]): Promise<void> {
    await Promise.all(proposers.map(async p => {
      const r = await oneShot({
        shell: p.shell,
        spec: { role: 'reviewer', cwd: this.o.projectRoot, model: p.model, effort: p.effort, systemPrompt: PROPOSE_SYSTEM, builtinTools: true },
        tool: PROPOSE_TOOL, prompt: proposeBrief(request), nudge: PROPOSE_NUDGE,
        accept: raw => {
          const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          return { title: text(a.title, 60, 'title'), approach: text(a.approach, 3000, 'approach'), tradeoffs: text(a.tradeoffs, 1500, 'tradeoffs'), effort: text(a.effort, 300, 'effort') };
        },
        approve: readOnlyPolicy(this.o.projectRoot),
        ...(this.o.signal ? { signal: this.o.signal } : {}),
        ...(this.o.onCost ? { onCost: this.o.onCost } : {}),
        ...(this.o.proposeTimeoutMs ? { timeoutMs: this.o.proposeTimeoutMs } : {}),
      });
      this.addProposal(id, r.ok ? { agent: p.agent, label: p.label, ok: true, ...r.value } : { agent: p.agent, label: p.label, ok: false, why: r.why });
    }));
    await this.merge(id);
  }

  private addProposal(id: number, p: Proposal): void {
    const r = this.row(id);
    if (!r) return;
    const list = [...JSON.parse(r.proposals) as Proposal[], p];
    this.o.db.prepare('UPDATE v8_roundtables SET proposals=? WHERE id=?').run(JSON.stringify(list), id);
    this.o.onChange();
  }

  /** Every proposal is in (or written off): the lead sorts them into Plan A / Plan B. */
  private async merge(id: number): Promise<void> {
    const r = this.row(id);
    if (!r || r.state !== 'proposing') return;
    const got = (JSON.parse(r.proposals) as Proposal[]).filter(p => p.ok);
    if (!got.length) {
      this.o.db.prepare(`UPDATE v8_roundtables SET state='failed' WHERE id=?`).run(id);
      this.o.scheduler.leadSaid(tr('圆桌「{0}」没出成方案：几只小怪都没交上来。可以再说一次，或者直接开工单。', [r.title]));
      this.o.onChange();
      return;
    }
    this.o.db.prepare(`UPDATE v8_roundtables SET state='merging' WHERE id=?`).run(id);
    this.o.onChange();
    this.o.toLead([
      tr('圆桌 #{0}「{1}」的方案到了（{2} 份，各自独立写的）。老板的原话：', [id, r.title, got.length]), r.request, '',
      ...got.map((p, i) => [tr('方案 {0}（{1}）：{2}', [i + 1, p.label, p.title]), tr('怎么做：') + p.approach, tr('好处和代价：') + p.tradeoffs, tr('工作量：') + p.effort].join('\n')),
      '', tr('把它们整理成两个真正不同的方案：Plan A 和 Plan B（相近的合并，各取所长），用 submit_plans 交给老板选，roundtable_id 填 ') + id + tr('。不要自己替老板选，也不要开工单。'),
    ].join('\n\n'));
  }

  private row(id: number): Row | undefined { return this.o.db.prepare('SELECT * FROM v8_roundtables WHERE id=?').get(id) as Row | undefined; }
  private rows(): Row[] { return this.o.db.prepare('SELECT * FROM v8_roundtables ORDER BY id').all() as Row[]; }
}
