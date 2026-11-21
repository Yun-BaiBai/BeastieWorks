import { tr } from '../../shared/i18n';
import type Database from 'better-sqlite3';
import type { Scheduler } from './scheduler';
import type { AgentShell, CostBasis, HostTool } from './shell';
import { oneShot } from './oneShot';
import { readOnlyPolicy } from './approval';
import type { SplitView } from '../../shared/v8/board';

/**
 * A12 拆解工单 (老板 2026-11-20; v8 规范: "大任务先出一份子工单清单，老板点头后才并行开工").
 *
 * - The lead opens a split from the boss's message (open_split) when the job is big. One gremlin on the worker's
 *   agent reads the project (it may read, never change anything) and hands in a list of pieces that can be done apart,
 *   or says it can't be split and why (requirement 31: only what really comes apart is done in parallel).
 * - The boss decides (requirement 34): split this way and do them at once, or do it whole as one ticket.
 * - Each piece is an ordinary ticket with the boss's own words whole, told which piece is its own and which belong to
 *   other gremlins (requirement 39: his words, not a summary; requirement 38: gremlins never talk to each other).
 *
 * None of the four reference projects splits work this way (OpenMausBot's project-scout builds a team by job titles,
 * which requirement 36 rules out); the shape follows the roundtable (roundtable.ts).
 *
 * When to split at all follows Orca (skill-guides/orchestration.md: prefer doing it in one go, "including for long or
 * parallel work"; separate workers only when they are really needed): one ticket by default, a split only for a job
 * big enough that each piece is long work. Measured 2026-11-21 (docs/benchmark.md): a small job split in two took
 * 2.9 times as long as one agent doing it whole.
 */

export interface Splitter { label: string; shell: AgentShell; model: string | null; effort: string | null }

export interface SplitOptions {
  db: Database.Database;
  scheduler: Scheduler;
  projectRoot: string;
  /** The gremlin that splits: one on the worker's agent. Null: none available. */
  splitter(): Splitter | null;
  startTicket(id: number): Promise<void>;
  onCost?(usd: number, basis: CostBasis): void;
  onChange(): void;
  clock?: () => number;
  /** Cuts off a proposer still at work when the app closes. */
  signal?: AbortSignal;
  /** Work that runs in the background, so closing can wait for it. */
  track?(work: Promise<unknown>): void;
  timeoutMs?: number;
}

export const OPEN_SPLIT_TOOL: HostTool = {
  name: 'open_split',
  description: '活大到要干很久、又能拆成几件互不相干可以同时做的部分，或者老板明说要拆时，先开拆解：一只小怪读项目，出一份拆法给老板看，老板点头才开工。小活、不确定能不能拆，就照常开工单。message_id 填老板那条消息。',
  parameters: { type: 'object', properties: { message_id: { type: 'integer', description: '老板那条消息的编号' }, title: { type: 'string', description: '可选，20 字以内的短标题' } }, required: ['message_id'] },
};

export const SPLIT_TOOL: HostTool = {
  name: 'submit_split',
  description: '交拆法，只交一次。拆不开就 can_split 填 false，pieces 留空，在 why 里说为什么。',
  parameters: {
    type: 'object',
    properties: {
      can_split: { type: 'boolean', description: '能不能拆成几件互不相干、可以同时做的活' },
      why: { type: 'string', description: '为什么这样拆，或者为什么拆不开，一两句' },
      pieces: {
        type: 'array', maxItems: 6,
        description: '能拆时 2 到 6 件。每件要能单独做完、单独验证，不改别的件要改的文件。',
        items: { type: 'object', properties: { title: { type: 'string', description: '这件的名字，15 字以内' }, what: { type: 'string', description: '这件做什么、碰哪些文件或部分，一两句' } }, required: ['title', 'what'] },
      },
    },
    required: ['can_split', 'why'],
  },
};

export const SPLIT_SYSTEM = [
  '你在小怪工坊里给一件大活出拆法。你可以读项目里的文件，弄清现状；不能改任何东西，写文件和运行会改东西的命令都会被拒绝。',
  '只出拆法，不动手做。',
  '能拆的标准：每一件都能单独做完、单独验证，几件之间不改同一个文件、不需要等别的件先做完。做不到这一点就是拆不开：老老实实说拆不开，不要硬拆。',
  '先后有依赖的（必须先做 A 才能做 B）不算能拆，那是工序，说明拆不开并写清楚先后。',
  '还要看值不值得拆：拆开本身有开销，每一件都要另一只小怪从头读一遍项目、各自审一次。整件活一只小怪十几二十分钟就能做完的，拆了只会更慢更贵：can_split 填 false，why 写"活不大，一张工单做完更快"。老板说了可以拆也一样，只有每一件本身都要干很久时才拆。',
  '拆的时候不加老板没要的东西，也不丢老板要的东西：几件合起来正好是老板要的整件事。',
  '想好了就调用 submit_split，只交一次，然后结束。',
].join('\n');

export const SPLIT_NUDGE = '你还没有调用 submit_split。现在交拆法：能拆就列出几件，拆不开就说为什么。';

export function splitBrief(request: string): string {
  return ['老板的原话：', request, '', '读一下项目，判断这件事能不能拆成几件可以同时做的活，再调用 submit_split。'].join('\n');
}

interface Piece { title: string; what: string }
interface Row { id: number; message_id: number; title: string; request: string; state: SplitView['state']; by: string; can_split: number; why: string; pieces: string; tickets: string; created_at: number }

const text = (v: unknown, max: number, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(what + ' 不能空着');
  return v.trim().replace(/\s+/g, ' ').slice(0, max);
};

/** What the splitter hands in, checked: pieces only when it says they come apart, 2 to 6 of them. */
export function acceptSplit(raw: unknown): { canSplit: boolean; why: string; pieces: Piece[] } {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof a.can_split !== 'boolean') throw new Error('can_split 要填 true 或 false');
  const why = text(a.why, 500, 'why');
  if (!a.can_split) return { canSplit: false, why, pieces: [] };
  if (!Array.isArray(a.pieces) || a.pieces.length < 2 || a.pieces.length > 6) throw new Error('能拆时 pieces 要 2 到 6 件');
  const pieces = a.pieces.map((p, i) => { const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>; return { title: text(x.title, 30, `pieces[${i}].title`), what: text(x.what, 400, `pieces[${i}].what`) }; });
  return { canSplit: true, why, pieces };
}

export class Splits {
  private readonly now: () => number;

  constructor(private readonly o: SplitOptions) {
    this.now = o.clock ?? Date.now;
    o.db.exec(`CREATE TABLE IF NOT EXISTS v8_splits(
      id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, request TEXT NOT NULL,
      state TEXT NOT NULL, by TEXT NOT NULL, can_split INTEGER NOT NULL DEFAULT 0, why TEXT NOT NULL DEFAULT '',
      pieces TEXT NOT NULL DEFAULT '[]', tickets TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL)`);
  }

  private background(work: Promise<unknown>): void { if (this.o.track) this.o.track(work); else void work; }

  private row(id: number): Row | undefined { return this.o.db.prepare('SELECT * FROM v8_splits WHERE id=?').get(id) as Row | undefined; }
  private rows(): Row[] { return this.o.db.prepare('SELECT * FROM v8_splits ORDER BY id').all() as Row[]; }

  /** After a restart: a splitter does not outlive the app, so one left splitting is asked again. */
  resumeAfterRestart(): void {
    for (const r of this.rows()) if (r.state === 'splitting') this.background(this.run(r.id, r.request));
  }

  /** The lead's open_split. The boss's words are copied from his message, never written by the lead. */
  open(messageId: number, title?: string): { id: number; by: string } {
    const m = this.o.scheduler.messages(null, 500).find(x => x.id === messageId);
    if (!m || m.author !== 'boss' || m.kind !== 'say') throw new Error('V8_NEEDS_BOSS_MESSAGE');
    if (this.o.db.prepare('SELECT 1 FROM v8_splits WHERE message_id=?').get(messageId)) throw new Error('V8_SPLIT_EXISTS');
    const s = this.o.splitter();
    if (!s) throw new Error('V8_SPLIT_NEEDS_AGENT');
    const request = String(m.body);
    const name = (title?.trim() || request.replace(/\s+/g, ' ')).slice(0, 20);
    const id = Number(this.o.db.prepare(`INSERT INTO v8_splits(message_id,title,request,state,by,created_at) VALUES(?,?,?,'splitting',?,?)`)
      .run(messageId, name, request, s.label, this.now()).lastInsertRowid);
    this.background(this.run(id, request));
    this.o.onChange();
    return { id, by: s.label };
  }

  private async run(id: number, request: string): Promise<void> {
    const s = this.o.splitter();
    const r = s ? await oneShot({
      shell: s.shell,
      spec: { role: 'reviewer', cwd: this.o.projectRoot, model: s.model, effort: s.effort, systemPrompt: SPLIT_SYSTEM, builtinTools: true },
      tool: SPLIT_TOOL, prompt: splitBrief(request), nudge: SPLIT_NUDGE, accept: acceptSplit,
      approve: readOnlyPolicy(this.o.projectRoot),
      ...(this.o.signal ? { signal: this.o.signal } : {}),
      ...(this.o.onCost ? { onCost: this.o.onCost } : {}),
      ...(this.o.timeoutMs ? { timeoutMs: this.o.timeoutMs } : {}),
    }) : { ok: false as const, why: 'no agent' };
    if (r.ok) this.o.db.prepare(`UPDATE v8_splits SET state='choosing', can_split=?, why=?, pieces=? WHERE id=?`).run(r.value.canSplit ? 1 : 0, r.value.why, JSON.stringify(r.value.pieces), id);
    else this.o.db.prepare(`UPDATE v8_splits SET state='choosing', can_split=0, why=? WHERE id=?`).run(tr('没拆出来（{0}），可以整件做。', [r.why]), id);
    this.o.onChange();
  }

  /**
   * The boss decides. 'split': every piece becomes a ticket at once, each from his own words (the first from his
   * message, the others recorded again as his). 'whole': one ordinary ticket from his message.
   */
  async decide(id: number, how: 'split' | 'whole'): Promise<number[]> {
    const r = this.row(id);
    if (!r || r.state !== 'choosing') throw new Error('V8_NOTHING_TO_DECIDE');
    const pieces = JSON.parse(r.pieces) as Piece[];
    if (how === 'split' && (!r.can_split || pieces.length < 2)) throw new Error('V8_CANNOT_SPLIT');
    this.o.db.prepare(`UPDATE v8_splits SET state='started' WHERE id=?`).run(id);
    const tickets: number[] = [];
    if (how === 'whole') {
      tickets.push(this.o.scheduler.openTicket({ fromMessageId: r.message_id, routingNote: tr('老板看过拆法，决定整件做'), title: r.title }));
    } else {
      pieces.forEach((p, i) => {
        const messageId = i === 0 ? r.message_id : this.o.scheduler.bossSaid(r.request);
        const ticket = this.o.scheduler.openTicket({ fromMessageId: messageId, routingNote: tr('拆开后的第 {0}/{1} 件：{2}', [i + 1, pieces.length, p.title]), title: tr('{0} · {1}', [r.title, p.title]).slice(0, 40) });
        const others = pieces.filter((_, j) => j !== i).map(x => x.title + tr('（') + x.what + tr('）'));
        this.o.scheduler.tellTicket(ticket, [
          tr('这件活拆成了 {0} 件，同时由几只小怪做。你只做第 {1} 件：{2}——{3}', [pieces.length, i + 1, p.title, p.what]),
          tr('别的几件由别的小怪做，不要碰它们的部分：{0}', [others.join(tr('；'))]),
        ].join('\n'));
        tickets.push(ticket);
      });
    }
    this.o.db.prepare('UPDATE v8_splits SET tickets=? WHERE id=?').run(JSON.stringify(tickets), id);
    for (const t of tickets) await this.o.startTicket(t);
    this.o.onChange();
    return tickets;
  }

  /** Splits still being worked out or waiting for the boss. */
  views(): SplitView[] {
    return this.rows().filter(r => r.state === 'splitting' || r.state === 'choosing').map(r => ({
      id: r.id, title: r.title, request: r.request, state: r.state, by: r.by, canSplit: r.can_split === 1, why: r.why, pieces: JSON.parse(r.pieces) as Piece[],
    }));
  }
}
