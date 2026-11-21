import { tr } from '../../shared/i18n';
import type { FakeControl, FakeScript, FakeScripts } from './fakeShell';
import { REPORT_NUDGE } from './prompts';

/**
 * The fake shell's cast for using the workbench without a model: a lead that opens a ticket for each thing the boss
 * says and passes results on, and gremlins that take a few seconds to read, edit and test before reporting. Words in
 * the request steer the story: "问" asks a question first, "卡" gets stuck, "慢" works until spoken to.
 * Nothing here touches files: the fake gremlins only pretend.
 */

const wait = (c: FakeControl, ms: number) => new Promise<void>(r => setTimeout(r, c.aborted ? 0 : ms));

function lead(pace: number): FakeScript {
  return {
    async onPrompt(c, text) {
      for (const [, id, words] of text.matchAll(/老板（消息 #(\d+)）：(.*)/g)) {
        await wait(c, 300 * pace);
        const ticket = /#(\d+)/.exec(words);
        const wantsFront = /提到最前|先做/.test(words);
        if (wantsFront) {
          // "把排队 03 提到最前" names a queue position; "#12 先做" names a ticket.
          const pos = /排队\s*0*(\d+)/.exec(words);
          let target = ticket ? Number(ticket[1]) : 0;
          if (!target && pos) {
            const r = await c.hostTool('list_tickets', {});
            const line = r.ok ? r.text.split('\n').find(l => l.includes(`排队第 ${Number(pos[1])}]`)) : undefined;
            target = Number(line ? /#(\d+)/.exec(line)?.[1] ?? 0 : 0);
          }
          const r = target ? await c.hostTool('move_to_front', { ticket_id: target, message_id: Number(id) }) : null;
          await c.hostTool('reply_to_boss', { text: r?.ok ? `#${target} ${r.text}` : '没提成：' + (r && !r.ok ? r.error : '排队里没有这一张') });
        }
        else if (/停/.test(words) && ticket) { await c.hostTool('stop_ticket', { ticket_id: Number(ticket[1]), message_id: Number(id) }); await c.hostTool('reply_to_boss', { text: `#${ticket[1]} 停了。` }); }
        else if (ticket) { await c.hostTool('forward_to_ticket', { message_id: Number(id), ticket_id: Number(ticket[1]) }); await c.hostTool('reply_to_boss', { text: `转给 #${ticket[1]} 了。` }); }
        else if (/在干嘛|进度/.test(words)) { const r = await c.hostTool('list_tickets', {}); await c.hostTool('reply_to_boss', { text: r.ok ? r.text : '看不到工单。' }); }
        else { const r = await c.hostTool('open_ticket', { message_id: Number(id), routing_note: '' }); await c.hostTool('reply_to_boss', { text: r.ok ? r.text.replace(tr('已开'), tr('派出去了：')) : '没开成：' + r.error }); }
      }
      // Reports ("交了报告：…") and review outcomes ("做完了，审查通过。…") about one ticket.
      const report = /工单 #(\d+)「(.*?)」(?:交了报告：)?(.*)/.exec(text);
      if (report) {
        await wait(c, 200 * pace);
        if (/有问题要问老板/.test(report[3])) await c.hostTool('ask_boss', { ticket_id: Number(report[1]) });
        else await c.hostTool('reply_to_boss', { text: `「${report[2]}」${report[3].replace(/\s*用 reply_to_boss.*$/, '').slice(0, 40)}` });
      }
      c.settle();
    },
  };
}

function worker(pace: number): FakeScript {
  const step = async (c: FakeControl, name: string, args: unknown, ms: number) => { c.tool(name, args); await wait(c, ms * pace); };
  return {
    async onPrompt(c, text) {
      if (text === REPORT_NUDGE) { c.settle(); return; }
      // Everything said after this prompt counts, however early it arrives.
      const start = c.heard.length;
      const answered = /老板说/.test(text);
      await step(c, 'read', { path: 'README.md' }, 900);
      await step(c, 'grep', { pattern: 'TODO' }, 700);
      // "额度" in the request plays an account running out: the first session stops with a quota refusal (back in 20
      // minutes); once the ticket goes on (same session), it finishes normally.
      if (/额度/.test(text) && c.heard.length === 1) {
        c.settle('error', `HTTP 429 resets=${Math.floor(Date.now() / 1000) + 20 * 60}: 演示：账号额度用完`);
        return;
      }
      if (/问/.test(text) && !answered) {
        await c.hostTool('submit_report', { kind: 'question', question: '这个要不要顺便改一下文案？', options: [{ id: 'yes', label: '改' }, { id: 'no', label: '不改' }], recommended: 'no' });
        c.settle(); return;
      }
      if (/卡/.test(text) && !answered) {
        await c.hostTool('submit_report', { kind: 'blocked', where: '演示：找不到要改的文件', tried: '搜了整个仓库' });
        c.settle(); return;
      }
      await step(c, 'edit', { path: 'src/demo.ts' }, 1200);
      if (/慢/.test(text)) {
        while (c.heard.length <= start && !c.aborted) await wait(c, 300);
        if (c.aborted) return;
      }
      await step(c, 'bash', { command: 'npm test' }, 1500);
      if (c.aborted) return;
      const said = c.heard.filter(h => h.kind === 'steer').map(h => h.text).join('；');
      await c.hostTool('submit_report', { kind: 'done', summary: '演示：改好了' + (said ? '，也照你说的：' + said : ''), changed: ['src/demo.ts'], verification: { command: 'npm test', output: '演示数据：12 / 12 通过' } });
      c.settle();
    },
  };
}

/** Passes, unless the boss's words contain "审查不过": then it fails every time, so the boss decides after two. */
function reviewer(pace: number): FakeScript {
  return {
    async onPrompt(c, text) {
      if (/^你还没有调用 submit_review/.test(text)) { c.settle(); return; }
      await wait(c, 800 * pace);
      const fail = /审查不过/.test(text.split('\n小怪说它做了')[0]);
      await c.hostTool('submit_review', {
        verdict: fail ? 'fail' : 'pass',
        reason: fail ? '演示：没有对上原话，要先改标题再交' : '演示：三条都对',
        checks: [
          { label: '对上原话了吗', ok: !fail, detail: fail ? '演示：漏了老板说的标题' : '演示：做的就是老板要的事' },
          { label: '有验证结果吗', ok: true, detail: '演示：附了 npm test 的输出' },
          { label: '有没有多改', ok: true, detail: '演示：只动了 src/demo.ts' },
        ],
      });
      c.settle();
    },
  };
}

/** `pace` scales every pause; tests use a small number. */
export function demoScripts(pace = 1): FakeScripts {
  return spec => (spec.role === 'lead' ? lead(pace) : spec.role === 'reviewer' ? reviewer(pace) : worker(pace));
}
