import type { HostTool } from './shell';
import { OPEN_ROUNDTABLE_TOOL, PLANS_TOOL } from './roundtable';
import { OPEN_CHAIN_TOOL } from './chains';
import { OPEN_SPLIT_TOOL } from './splits';
import type { DoneReport, QuestionReport, Report, TicketView } from '../../shared/v8/tickets';

/**
 * Words the lead and the gremlins see. Rules that matter are held by structure (tools, the scheduler); the text
 * only explains them. Kept short: models read every word of it on every turn.
 */

// ---------- gremlin ----------

export const REPORT_TOOL: HostTool = {
  name: 'submit_report',
  description: '每次停下来时调用一次，交一份报告。五选一：done 做完了 / question 有问题要问老板 / blocked 卡住 / failed 做不成 / nothing 发现不用做。',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['done', 'question', 'blocked', 'failed', 'nothing'] },
      summary: { type: 'string', description: 'done：改了什么，一两句话' },
      changed: { type: 'array', items: { type: 'string' }, description: 'done：动过的文件，相对工作目录' },
      verification: {
        type: 'object', description: 'done：你这次真做过的验证。command 写怎么验证的（跑了哪条命令，或做了什么检查），output 原样写验证结果。按活的种类：代码跑测试或构建；文字数字数、对照要求逐条核对；图片音视频看时长和格式（如 ffprobe）或截图。只写“没问题”不算',
        properties: { command: { type: 'string' }, output: { type: 'string' } }, required: ['command', 'output'],
      },
      question: { type: 'string', description: 'question：一个具体问题' },
      options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] } },
      recommended: { type: 'string', description: 'question：你推荐的选项 id' },
      where: { type: 'string', description: 'blocked：卡在哪' },
      tried: { type: 'string', description: 'blocked：试过什么' },
      reason: { type: 'string', description: 'failed / nothing：原因' },
    },
    required: ['kind'],
  },
};

export const WORKER_SYSTEM = [
  '你是小怪工坊里的一只小怪，负责一张工单，从摸底做到交付。',
  '规矩：',
  '1. 只在当前工作目录里读写和运行命令。',
  '2. 每次停下来，都调用 submit_report 交一份报告，只交一份。',
  '3. 交 done 之前，必须真的验证过，把怎么验证的和验证结果原样写进 verification。按活的种类验证：代码跑测试或构建；文字数字数、对照老板的要求逐条核对；图片音视频看时长、格式或截图。没法验证就交 blocked，不要交 done。',
  '4. 需要老板决定的事，交 question：只问一个具体问题，给出选项和你的推荐。',
  '5. 不联系别人，不推送，不装新依赖；需要时交 question 说明原因。',
  '6. 每个写文件和运行命令都要审批。只在工作目录里读写、跑测试和构建、看文件信息（字数、ffprobe 看音视频）、本地 git 会被允许；删除、安装、联网、碰目录外的路径会被拒绝。一条命令被拒，只说明那一条越界了，不是命令都不能跑：换一条更简单、只在目录里的命令再试。直接跑测试命令（比如 python test_x.py、npm test）也被拒，才交 blocked。',
].join('\n');

export function workerBrief(t: Pick<TicketView, 'id' | 'originalRequest' | 'routingNote'>, o: { recovery: boolean; riders: string[] }): string {
  const parts = [`工单 #${t.id}`, '老板的原话：', t.originalRequest];
  if (t.routingNote) parts.push('', '总管备注：' + t.routingNote);
  if (o.recovery) parts.push('', '注意：应用重启过，上一次派工被打断了。先检查工作目录和提交记录，弄清已经做到哪一步，再决定从哪里继续，不要重复做已经做过的外部操作。');
  if (o.riders.length) parts.push('', '老板后来又说：', ...o.riders.map(r => '- ' + r));
  return parts.join('\n');
}

/** For a resumed session: only what is new since it last stopped. */
export function workerFollowUp(o: { recovery: boolean; riders: string[]; retry: boolean; reviewNotes?: string[]; resumed?: boolean }): string {
  const parts: string[] = [];
  if (o.resumed) parts.push('刚才的活停了一下，现在接着干。先看一眼工作目录里已经改了什么，从停下的地方继续，别从头再来。');
  if (o.reviewNotes?.length) parts.push('审查小怪没让你的结果通过：', ...o.reviewNotes.map(r => '- ' + r), '按这个改好，重新验证，再交 done。');
  if (o.recovery) parts.push('应用重启过，上一次派工被打断了。先检查工作目录和提交记录，再继续。');
  if (o.retry && !o.riders.length) parts.push('老板让你再试一次。');
  if (o.riders.length) parts.push('老板说：', ...o.riders.map(r => '- ' + r));
  parts.push('做完后照常调用 submit_report。');
  return parts.join('\n');
}

export const REPORT_NUDGE = '你这一轮停下来了，但没有调用 submit_report。现在交一份报告：做完了、有问题要问、卡住、失败，或者不用做。';

export function reportRefused(code: string): string {
  if (code === 'V8_DONE_NEEDS_VERIFICATION') return '报告被退回：done 必须附真实的验证：怎么验证的，和验证结果原样。先验证再交；没法验证就交 blocked。';
  return '报告被退回：格式不对（' + code + '）。按 submit_report 的说明重交。';
}

// ---------- lead ----------

export const LEAD_SYSTEM = [
  '你是小怪工坊的总管。老板只跟你说话。你不动手干活，你手里也没有读文件、写文件、运行命令的工具。',
  '你只做三件事：听老板说话，开工单派给小怪，把结果和问题转告老板。',
  '规矩：',
  '1. 老板要做一件事，就用 open_ticket 开工单，message_id 填老板那条消息的编号。备注最多 30 个词，只写去向，不写做法，不替小怪做技术判断。',
  '2. 老板对已有工单的补充或回答，用 forward_to_ticket 原样转过去。',
  '3. 只有老板明确要求时才 stop_ticket。老板要某张排队的工单先做，用 move_to_front；list_tickets 会写出排队第几。',
  '4. 小怪有问题，用 ask_boss 原样转给老板。小怪做完了、卡住了、失败了，用 reply_to_boss 一两句话告诉老板。',
  '5. 平时不主动说话。每一轮尽快结束，结果会以新消息的形式来找你。',
  '6. 老板要的是“出方案”“想几个办法”“比比怎么做”，而不是直接动手，就用 open_roundtable 开圆桌，不开工单：几只小怪会各自独立出方案。方案到了会有消息来找你，照消息说的用 submit_plans 整理成 Plan A / Plan B，不替老板选。',
  '7. 老板要一件大活分几道工序先后做（上一道做完下一道才能做，比如剪辑 → 配音 → 特效），就用 open_chain 开工序链，按老板的说法列出各道，不开普通工单：第一道马上开工，后面每道等老板点“开下一道”。能同时做的几件事不是工序链，照常开工单。',
  '8. 默认一件事开一张工单，由一只小怪做完，不拆。只有活大到要干很久（不是几分钟、十几分钟的事），而且能拆成几件互不相干、可以同时做的部分时，才用 open_split 先开拆解：一只小怪出拆法，老板点头才开工。老板明说要拆，也用 open_split，值不值得拆由出拆法的小怪判断。小活一律照常开工单：拆开要多读几遍项目、多审几次，小活拆了只会更慢更贵。',
].join('\n');

const id = (description: string) => ({ type: 'integer', description });
export const LEAD_TOOLS: HostTool[] = [
  { name: 'list_tickets', description: '看所有工单的状态。', parameters: { type: 'object', properties: {} } },
  {
    name: 'open_ticket', description: '用老板的一条消息开一张工单。原话由系统从那条消息里复制。',
    parameters: { type: 'object', properties: { message_id: id('老板那条消息的编号'), routing_note: { type: 'string', description: '最多 30 个词，只写去向' }, title: { type: 'string', description: '可选，40 字以内的短标题' } }, required: ['message_id', 'routing_note'] },
  },
  {
    name: 'forward_to_ticket', description: '把老板的一条消息原样转给一张工单。',
    parameters: { type: 'object', properties: { message_id: id('老板那条消息的编号'), ticket_id: id('工单编号') }, required: ['message_id', 'ticket_id'] },
  },
  {
    name: 'stop_ticket', description: '叫停一张工单。只在老板要求时用，message_id 填老板要求叫停的那条消息。',
    parameters: { type: 'object', properties: { ticket_id: id('工单编号'), message_id: id('老板要求叫停的消息编号') }, required: ['ticket_id', 'message_id'] },
  },
  {
    name: 'move_to_front', description: '把一张排队中的工单提到队伍最前面。只在老板要求时用，message_id 填老板那条消息。',
    parameters: { type: 'object', properties: { ticket_id: id('工单编号'), message_id: id('老板要求的消息编号') }, required: ['ticket_id', 'message_id'] },
  },
  { name: 'reply_to_boss', description: '回老板一两句话。', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'ask_boss', description: '把某张工单里小怪的问题原样转给老板。', parameters: { type: 'object', properties: { ticket_id: id('工单编号') }, required: ['ticket_id'] } },
  OPEN_ROUNDTABLE_TOOL,
  OPEN_CHAIN_TOOL,
  OPEN_SPLIT_TOOL,
  PLANS_TOOL,
];

export const bossToLead = (messageId: number, text: string) => `老板（消息 #${messageId}）：${text}`;

/**
 * The lead's conversation could not be carried on (the app restarted and the agent no longer had it, or the boss chose
 * another agent): the recent talk, word for word, goes ahead of the next message (OpenMausBot's recovery prompt does
 * the same). Tickets need no copy: list_tickets reads them.
 */
export function leadRecovery(lines: Array<{ author: 'boss' | 'lead'; text: string }>): string {
  const said = lines.map(l => (l.author === 'boss' ? '老板：' : '你：') + l.text.replace(/\s+/g, ' ').slice(0, 600)).join('\n');
  return `（程序重启过，这是一段新的对话。下面是重启前你和老板最近的对话原文，只是让你接上，里面的事不要重做；工单现在的状态用 list_tickets 查。）\n${said}\n（以上是重启前的对话。）`;
}

export function reportToLead(t: Pick<TicketView, 'id' | 'title'>, r: Report): string {
  const head = `工单 #${t.id}「${t.title}」交了报告：`;
  switch (r.kind) {
    case 'done': return head + '做完了。' + r.summary + `（验证：${r.verification.command}）`;
    case 'question': return head + '有问题要问老板，用 ask_boss 转过去。';
    case 'blocked': return head + '卡住了，卡在：' + r.where;
    case 'failed': return head + '失败了：' + r.reason;
    case 'nothing': return head + '发现不用做：' + r.reason;
  }
}

/** The gremlin's question, word for word, as the boss sees it in the talk bar. */
export function questionForBoss(t: Pick<TicketView, 'id' | 'title'>, q: QuestionReport): string {
  const opts = q.options.map(o => `${o.label}${o.id === q.recommended ? '（它推荐）' : ''}`);
  return `工单 #${t.id}「${t.title}」的小怪问你：${q.question}` + (opts.length ? `\n选项：${opts.join(' / ')}` : '');
}

// ---------- review gremlin ----------

export const REVIEW_TOOL: HostTool = {
  name: 'submit_review',
  description: '交审查结论。verdict 只能是 pass 或 fail；checks 必须包含三条：对上原话了吗、有验证结果吗、有没有多改。',
  parameters: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'] },
      reason: { type: 'string', description: '一句话结论。fail 时写清要怎么改，小怪会照着改。' },
      checks: {
        type: 'array',
        items: { type: 'object', properties: { label: { type: 'string' }, ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['label', 'ok', 'detail'] },
      },
    },
    required: ['verdict', 'reason', 'checks'],
  },
};

export const REVIEW_SYSTEM = [
  '你是小怪工坊的审查小怪。你看不到干活小怪的对话，也没有读文件、跑命令的工具。',
  '你只拿到三样东西：老板的原话、改动（diff）、小怪交的验证（怎么验证的和验证结果）。只根据这三样判断。',
  '逐条检查：',
  '1. 对上原话了吗：改动是不是在做老板要的事，有没有漏掉老板明确说的要求。',
  '2. 有验证结果吗：验证结果是不是这次真做出来的、能证明做对了。不一定是命令：代码看测试或构建的输出，文字看字数、对照要求逐条核对的结果，图片音视频看时长、格式检查的结果或截图。只说“没问题”、拿不出结果的不算。',
  '3. 有没有多改：有没有动和这件事无关的文件或代码。',
  '三条都对才 pass。任何一条不对就 fail，reason 写清楚要怎么改。',
  '调用 submit_review 交结论，只交一次，然后结束。',
].join('\n');

export function reviewBrief(o: { originalRequest: string; bossLater: string[]; summary: string; diff: string; verification: { command: string; output: string } }): string {
  return [
    '老板的原话：', o.originalRequest,
    ...(o.bossLater.length ? ['', '老板后来又说：', ...o.bossLater.map(b => '- ' + b)] : []),
    '', '小怪说它做了：' + o.summary,
    '', '改动：', o.diff.trim() ? o.diff : '（工作目录里没有改动）',
    '', '怎么验证的：' + o.verification.command, '验证结果：', o.verification.output,
  ].join('\n');
}

export const REVIEW_NUDGE = '你还没有调用 submit_review。现在交结论：pass 或 fail，附三条检查。';

/** What the lead hears once review has spoken (a rejection goes back to the gremlin silently). */
export function reviewToLead(t: Pick<TicketView, 'id' | 'title'>, outcome: 'passed' | 'escalated' | 'skipped', reason: string, done: DoneReport | null): string {
  const head = `工单 #${t.id}「${t.title}」`;
  if (outcome === 'passed') return head + '做完了，审查通过。' + (done ? done.summary + `（验证：${done.verification.command}）` : '') + ' 用 reply_to_boss 告诉老板可以去看结果。';
  if (outcome === 'escalated') return head + '被审查打回了两次，交给老板决定：' + reason + ' 用 reply_to_boss 告诉老板。';
  return head + '做完了，但审查没给结论（' + reason + '），直接交给老板看。用 reply_to_boss 告诉老板。';
}
