import { tr } from '../../shared/i18n';
import type Database from 'better-sqlite3';
import type { Scheduler } from './scheduler';
import type { HostTool } from './shell';
import type { ChainView } from '../../shared/v8/board';

/**
 * A15 工序链 (老板 2026-11-20): one big job done in stages, one after another (editing → voice-over → effects).
 *
 * - The lead opens a chain from the boss's message (open_chain) with the stages named; the first stage's ticket opens
 *   at once from that message.
 * - When a stage's ticket is accepted, the next stage waits for the boss to press "开下一道" (requirement 47: by hand
 *   first, automatic once it runs smoothly). Each stage is an ordinary ticket with its own gremlin.
 * - What a stage hands on is the boss's own words, whole, and the list of finished files the previous stage put into
 *   the project, never a summary (requirement 39). Gremlins never talk to each other (requirement 38): the app tells
 *   the next one, as the boss's words on its ticket.
 *
 * OpenMausBot's hand-offs are one bot passing work to another bot, which requirement 38 rules out, so nothing was
 * ported here; the shape follows the roundtable (roundtable.ts).
 */

export interface ChainOptions {
  db: Database.Database;
  scheduler: Scheduler;
  /** Get a ticket going once it is open. */
  startTicket(id: number): Promise<void>;
  onChange(): void;
  clock?: () => number;
}

export const OPEN_CHAIN_TOOL: HostTool = {
  name: 'open_chain',
  description: '老板要一件大活分几道工序先后做（比如"先剪辑，再配音，最后加特效"），每道要等上一道做完才能做的时候，开工序链：列出各道工序，第一道马上开工，后面的由老板点"开下一道"。能同时做的活不要用这个。message_id 填老板那条消息。',
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'integer', description: '老板那条消息的编号' },
      title: { type: 'string', description: '整条工序链的短标题，20 字以内' },
      stages: {
        type: 'array', minItems: 2, maxItems: 6,
        description: '按先后排好的工序，2 到 6 道。用老板的说法，不要自己加道。',
        items: { type: 'object', properties: { title: { type: 'string', description: '这道工序的名字，10 字以内' }, what: { type: 'string', description: '这道要做什么，一两句' } }, required: ['title', 'what'] },
      },
    },
    required: ['message_id', 'stages'],
  },
};

interface Stage { title: string; what: string; ticketId: number | null; files: string[] }
interface Row { id: number; message_id: number; title: string; request: string; stages: string; created_at: number }

const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(what + ' 不能空着');
  return v.trim().replace(/\s+/g, ' ').slice(0, max);
};

export class Chains {
  private readonly now: () => number;

  constructor(private readonly o: ChainOptions) {
    this.now = o.clock ?? Date.now;
    o.db.exec(`CREATE TABLE IF NOT EXISTS v8_chains(
      id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, request TEXT NOT NULL,
      stages TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  }

  private rows(): Row[] { return this.o.db.prepare('SELECT * FROM v8_chains ORDER BY id').all() as Row[]; }
  private row(id: number): Row | undefined { return this.o.db.prepare('SELECT * FROM v8_chains WHERE id=?').get(id) as Row | undefined; }
  private save(id: number, stages: Stage[]): void { this.o.db.prepare('UPDATE v8_chains SET stages=? WHERE id=?').run(JSON.stringify(stages), id); }

  /** The lead's open_chain. The boss's words are copied from his message, never written by the lead. */
  async open(raw: unknown): Promise<{ id: number; ticketId: number; stages: string[] }> {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const messageId = a.message_id;
    const m = typeof messageId === 'number' ? this.o.scheduler.messages(null, 500).find(x => x.id === messageId) : undefined;
    if (!m || m.author !== 'boss' || m.kind !== 'say') throw new Error('V8_NEEDS_BOSS_MESSAGE');
    if (this.o.db.prepare('SELECT 1 FROM v8_chains WHERE message_id=?').get(m.id)) throw new Error('V8_CHAIN_EXISTS');
    if (!Array.isArray(a.stages) || a.stages.length < 2 || a.stages.length > 6) throw new Error('V8_CHAIN_STAGES: stages 要 2 到 6 道');
    const stages: Stage[] = a.stages.map((s, i) => {
      const x = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      return { title: str(x.title, 20, `stages[${i}].title`), what: str(x.what, 300, `stages[${i}].what`), ticketId: null, files: [] };
    });
    const request = String(m.body);
    const title = (typeof a.title === 'string' && a.title.trim() ? a.title.trim() : request.replace(/\s+/g, ' ')).slice(0, 20);
    const id = Number(this.o.db.prepare('INSERT INTO v8_chains(message_id,title,request,stages,created_at) VALUES(?,?,?,?,?)')
      .run(m.id, title, request, JSON.stringify(stages), this.now()).lastInsertRowid);
    const ticketId = await this.startStage(id, 0, m.id);
    return { id, ticketId, stages: stages.map(s => s.title) };
  }

  /** A stage's ticket: from the boss's message, told which stage it is and what came before. */
  private async startStage(id: number, index: number, messageId: number): Promise<number> {
    const r = this.row(id)!;
    const stages = JSON.parse(r.stages) as Stage[];
    const s = stages[index]!, n = stages.length;
    const ticket = this.o.scheduler.openTicket({ fromMessageId: messageId, routingNote: tr('工序链「{0}」第 {1}/{2} 道：{3}', [r.title, index + 1, n, s.title]), title: tr('{0} · 第 {1} 道：{2}', [r.title, index + 1, s.title]).slice(0, 40) });
    const before = index > 0 ? stages[index - 1]! : null;
    const after = stages.slice(index + 1).map(x => x.title);
    this.o.scheduler.tellTicket(ticket, [
      tr('这是工序链「{0}」的第 {1}/{2} 道：{3}。只做这一道：{4}', [r.title, index + 1, n, s.title, s.what]),
      ...(before ? [before.files.length
        ? tr('上一道「{0}」已经收下，它的成品在项目里：{1}。接着这些做。', [before.title, before.files.join(tr('、'))])
        : tr('上一道「{0}」已经收下，它的成品在项目里。', [before.title])] : []),
      ...(after.length ? [tr('后面还有：{0}，那些不归这一道做。', [after.join(tr('、'))])] : []),
    ].join('\n'));
    stages[index] = { ...s, ticketId: ticket };
    this.save(id, stages);
    await this.o.startTicket(ticket);
    this.o.onChange();
    return ticket;
  }

  /** A stage's ticket was accepted: keep the files it put into the project, for the next stage. */
  accepted(ticketId: number, files: string[]): void {
    for (const r of this.rows()) {
      const stages = JSON.parse(r.stages) as Stage[];
      const i = stages.findIndex(s => s.ticketId === ticketId);
      if (i < 0) continue;
      stages[i] = { ...stages[i]!, files: files.slice(0, 200) };
      this.save(r.id, stages);
      this.o.onChange();
    }
  }

  /** The boss presses "开下一道": the next stage opens from his own words, recorded again as his. */
  async next(id: number): Promise<number> {
    const r = this.row(id);
    if (!r) throw new Error('V8_NO_SUCH_CHAIN');
    const i = this.nextIndex(r);
    if (i === null) throw new Error('V8_CHAIN_NOT_READY');
    const messageId = this.o.scheduler.bossSaid(r.request);
    return this.startStage(id, i, messageId);
  }

  /** The stage the boss may start now: the first without a ticket, once the one before it was accepted. */
  private nextIndex(r: Row): number | null {
    const stages = JSON.parse(r.stages) as Stage[];
    const i = stages.findIndex(s => s.ticketId === null);
    if (i <= 0) return null;
    return this.o.scheduler.state(stages[i - 1]!.ticketId!) === 'DONE' ? i : null;
  }

  views(): ChainView[] {
    return this.rows().map((r): ChainView => {
      const stages = JSON.parse(r.stages) as Stage[];
      const next = this.nextIndex(r);
      const views = stages.map(s => ({ title: s.title, what: s.what, ticketId: s.ticketId, state: s.ticketId ? this.o.scheduler.state(s.ticketId) : null }));
      return { id: r.id, title: r.title, request: r.request, stages: views, next, finished: stages.every(s => s.ticketId !== null && this.o.scheduler.state(s.ticketId) === 'DONE') };
    }).filter(c => !c.finished);
  }
}
