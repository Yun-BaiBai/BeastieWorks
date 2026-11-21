'use strict';
// A stand-in ACP agent that uses the app's tools the way a real one does: it starts the MCP server named in
// session/new, lists its tools, and calls them. No model.
//   As the lead: "老板（消息 #N）：…"            -> open_ticket(message_id N), then reply_to_boss
//                "工单 #N「…」交了报告：…"       -> reply_to_boss with the report line
//   As a gremlin: anything else                  -> asks to write a file (approval), writes it, submit_report done
//   FAKE_TOOLS_OUTSIDE=1  the gremlin asks to write outside its folder first (must be refused)
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const { spawn } = require('node:child_process');

const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const waiting = new Map();
const costSoFar = {};
let next = 1000;
const ask = (method, params) => new Promise(resolve => { const id = next++; waiting.set(id, resolve); send({ id, method, params }); });
const say = (sessionId, text) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });

// ---- a tiny MCP client over the server's stdio ----
let mcp = null, mcpNext = 1, tools = [], cwd = process.cwd();
// The session's options: a mode, a model and a reasoning effort, answered back in full after each change like a real agent.
const opts = [{ id: 'mode', category: 'mode', currentValue: 'open', options: [{ value: 'open' }, { value: 'closed' }] },
  { id: 'model', category: 'model', currentValue: 'm1', options: [{ value: 'm1' }, { value: 'm2' }] },
  { id: 'effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] }];
const mcpWaiting = new Map();
function mcpStart(server) {
  const env = { ...process.env };
  for (const e of server.env || []) env[e.name] = e.value;
  const child = spawn(server.command, server.args || [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const settle = mcpWaiting.get(m.id); if (settle) { mcpWaiting.delete(m.id); settle(m); }
  });
  mcp = child;
}
const mcpAsk = (method, params) => new Promise(resolve => { const id = mcpNext++; mcpWaiting.set(id, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
async function call(sessionId, name, args) {
  // Like Codex: ask permission before calling an MCP tool, naming the server and the tool.
  // Exactly as Codex's adapter 2.6.0 does it: first the call is reported (title mcp.<server>.<tool>), then the
  // approval names the call by its id only.
  const callId = 'mcp-' + name + '-' + (++next);
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: callId, kind: 'execute', title: `mcp.beastie.${name}`, status: 'pending', rawInput: { server: 'beastie', tool: name, arguments: args } } } });
  const ok = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: callId, kind: 'execute', status: 'pending' }, _meta: { is_mcp_tool_approval: true }, options: [{ optionId: 'y', kind: 'allow_once', name: 'Allow' }, { optionId: 'n', kind: 'reject_once', name: 'Reject' }] });
  if (ok?.outcome?.optionId !== 'y') return { refused: true };
  const r = await mcpAsk('tools/call', { name, arguments: args });
  return r.result;
}

readline.createInterface({ input: process.stdin }).on('line', async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method === undefined) { waiting.get(m.id)?.(m.result ?? m.error); waiting.delete(m.id); return; }
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-tools', version: '1' }, agentCapabilities: {}, authMethods: [] } });
  if (m.method === 'session/new') {
    // FAKE_TOOLS_SIGNED_OUT_FLAG=<file>: refuse sessions while that file exists (a signed-out agent).
    if (process.env.FAKE_TOOLS_SIGNED_OUT_FLAG && fs.existsSync(process.env.FAKE_TOOLS_SIGNED_OUT_FLAG)) return send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    cwd = m.params.cwd;
    if (process.env.FAKE_TOOLS_NEW_DELAY && /ticket-/.test(path.basename(cwd))) await new Promise(r => setTimeout(r, Number(process.env.FAKE_TOOLS_NEW_DELAY)));
    fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'light.txt'), `${path.basename(cwd)} env=${process.env.LIGHT_MARK ?? '-'} meta=${JSON.stringify(m.params._meta ?? null)}
`);
    const server = (m.params.mcpServers || [])[0];
    if (server) {
      mcpStart(server);
      await mcpAsk('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
      tools = (await mcpAsk('tools/list', {})).result.tools.map(t => t.name);
    }
    return send({ id: m.id, result: { sessionId: 's-' + path.basename(cwd), configOptions: opts } });
  }
  if (m.method === 'session/set_config_option') {
    fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'modes.txt'), `${path.basename(cwd)} ${m.params.configId}=${m.params.value}\n`);
    const o = opts.find(x => x.id === m.params.configId); if (o) o.currentValue = m.params.value;
    return send({ id: m.id, result: { configOptions: opts } });
  }
  if (m.method === 'session/prompt') {
    // FAKE_TOOLS_QUOTA_MODEL=<model>: a gremlin on that model is refused, the way an agent says its quota ran out.
    if (process.env.FAKE_TOOLS_QUOTA_MODEL && /ticket-/.test(path.basename(cwd)) && opts.find(o => o.id === 'model').currentValue === process.env.FAKE_TOOLS_QUOTA_MODEL) {
      fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'quota.txt'), path.basename(cwd) + ' refused on ' + process.env.FAKE_TOOLS_QUOTA_MODEL + '\n');
      return send({ id: m.id, error: { code: -32000, message: 'You have hit your usage limit. Try again later.' } });
    }
    const text = m.params.prompt.map(p => p.text ?? '').join('');
    const sessionId = m.params.sessionId;
    fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'prompts.txt'), path.basename(cwd) + ': ' + text.replace(/\n/g, ' ').slice(-200) + '\n');
    fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'tools.txt'), `${path.basename(cwd)}: ${tools.join(',')}\n`);
    const boss = /老板（消息 #(\d+)）/.exec(text);
    const table = /圆桌 #(\d+)「/.exec(text);
    if (boss && /出方案/.test(/老板（消息 #\d+）：(.*)$/m.exec(text)?.[1] ?? '') && tools.includes('open_roundtable')) {
      // A6: the lead opens a roundtable instead of a ticket.
      await call(sessionId, 'open_roundtable', { message_id: Number(boss[1]), title: '登录怎么改' });
    } else if (boss && /拆/.test(/老板（消息 #\d+）：(.*)$/m.exec(text)?.[1] ?? '') && tools.includes('open_split')) {
      // A12: the lead opens a split instead of a ticket.
      await call(sessionId, 'open_split', { message_id: Number(boss[1]), title: '两个页面' });
    } else if (tools.includes('submit_split')) {
      // A12: the splitter may read, never write; FAKE_TOOLS_SPLIT=no says it can't be split.
      const w = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 'sw', title: 'Write x', kind: 'edit', locations: [{ path: path.join(cwd, 'x.md') }] }, options: [{ optionId: 'y', kind: 'allow_once', name: 'Allow' }, { optionId: 'n', kind: 'reject_once', name: 'Reject' }] });
      fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'split.txt'), `${process.env.FAKE_TOOLS_NAME ?? '?'} write=${w?.outcome?.optionId} ${text.replace(/\n/g, ' ')}\n`);
      await call(sessionId, 'submit_split', process.env.FAKE_TOOLS_SPLIT === 'no'
        ? { can_split: false, why: '两页共用一个样式文件，改的时候会撞' }
        : { can_split: true, why: '两页各改各的文件', pieces: [{ title: '登录页', what: '只改 login.html' }, { title: '注册页', what: '只改 signup.html' }] });
    } else if (boss && /工序/.test(/老板（消息 #\d+）：(.*)$/m.exec(text)?.[1] ?? '') && tools.includes('open_chain')) {
      // A15: the lead opens a chain of stages instead of one ticket.
      const r = await call(sessionId, 'open_chain', { message_id: Number(boss[1]), title: '宣传片', stages: [{ title: '剪辑', what: '剪出粗剪版' }, { title: '配音', what: '按粗剪配旁白' }] });
      fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'chain.txt'), JSON.stringify(r) + '\n');
    } else if (table && tools.includes('submit_plans')) {
      fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'merge.txt'), text.replace(/\n/g, ' ') + '\n');
      await call(sessionId, 'submit_plans', { roundtable_id: Number(table[1]), plan_a: { title: '小改', summary: '只改登录页', from: '方案 1' }, plan_b: { title: '大改', summary: '换掉整个登录', from: '方案 2' }, recommended: 'A', note: 'A 快，B 彻底' });
    } else if (tools.includes('submit_proposal')) {
      // A6: a proposer first tries to write (must be refused: proposers only read), then hands in its plan.
      const w = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 'pw', title: 'Write plan.md', kind: 'edit', locations: [{ path: path.join(cwd, 'plan.md') }] }, options: [{ optionId: 'y', kind: 'allow_once', name: 'Allow' }, { optionId: 'n', kind: 'reject_once', name: 'Reject' }] });
      const r = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 'pr', title: 'Read', kind: 'execute', rawInput: { command: 'git log --oneline' } }, options: [{ optionId: 'y', kind: 'allow_once', name: 'Allow' }, { optionId: 'n', kind: 'reject_once', name: 'Reject' }] });
      fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'proposals.txt'), `${process.env.FAKE_TOOLS_NAME ?? '?'} cwd=${path.basename(cwd)} write=${w?.outcome?.optionId} read=${r?.outcome?.optionId} brief=${text.replace(/\n/g, ' ').slice(0, 80)}\n`);
      if (process.env.FAKE_TOOLS_PROPOSE_DELAY) await new Promise(res => setTimeout(res, Number(process.env.FAKE_TOOLS_PROPOSE_DELAY)));
      await call(sessionId, 'submit_proposal', { title: '方案 by ' + (process.env.FAKE_TOOLS_NAME ?? '?'), approach: '先这样再那样', tradeoffs: '快但粗', effort: '半天' });
    } else if (tools.includes('submit_notes')) {
      // A10: the notes step. One line resting on the boss's own words, one made up (no such words), one secret: only
      // the first may be kept.
      fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'notes.txt'), text.replace(/\n/g, ' ') + '\n');
      const said = (/老板这张工单的原话：\n(.*)/.exec(text) ?? [])[1] ?? '';
      await call(sessionId, 'submit_notes', { items: [
        { text: '老板说过：' + said, kind: 'preference', evidence: said },
        { text: '老板喜欢蓝色', kind: 'preference', evidence: '我最喜欢蓝色' },
        { text: '密钥 token: sk-abcdefghijklmnopqrstuvwx', kind: 'fact', evidence: said },
      ] });
    } else if (tools.includes('submit_patrol')) {
      // A11: the patrol's glance. FAKE_TOOLS_DRIFT=1 says the gremlin has drifted.
      fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'patrol.txt'), text.replace(/\n/g, ' ') + '\n');
      await call(sessionId, 'submit_patrol', process.env.FAKE_TOOLS_DRIFT ? { on_track: false, reason: '在改无关的配色文件' } : { on_track: true, reason: '在做登录页' });
    } else if (boss && tools.includes('open_ticket')) {
      await call(sessionId, 'open_ticket', { message_id: Number(boss[1]), routing_note: '派给小怪', title: '加一行问候' });
      await call(sessionId, 'reply_to_boss', { text: '派出去了。' });
    } else if (/交了报告/.test(text) && tools.includes('reply_to_boss')) {
      await call(sessionId, 'reply_to_boss', { text: '小怪干完了：' + text.slice(0, 60) });
    } else if (tools.includes('submit_review')) {
      fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'reviews.txt'), path.basename(cwd) + '\n');
      const fail = process.env.FAKE_TOOLS_REVIEW === 'fail';
      await call(sessionId, 'submit_review', { verdict: fail ? 'fail' : 'pass', reason: fail ? '少了一句' : '对上了', checks: [
        { label: '对上原话了吗', ok: !fail, detail: 'hello.txt 写了你好' }, { label: '有验证结果吗', ok: true, detail: '有' }, { label: '有没有多改', ok: true, detail: '没有' }] });
    } else if (tools.includes('submit_report')) {
      // FAKE_TOOLS_SKILL=<name>: first fetch that skill from the app's skill library, like a gremlin that needs it.
      if (process.env.FAKE_TOOLS_SKILL && tools.includes('use_skill')) {
        const got = await call(sessionId, 'use_skill', { name: process.env.FAKE_TOOLS_SKILL });
        fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'skill.txt'), JSON.stringify(got).slice(0, 300) + '\n');
      }
      // Each file name is unique to the ticket, so two tickets' work can both be accepted.
      const file = path.join(cwd, 'hello-' + path.basename(cwd) + '.txt');
      fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'working.txt'), `start ${path.basename(cwd)} ${Date.now()}\n`);
      fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'briefs.txt'), path.basename(cwd) + ' ' + text.replace(/\n/g, ' ') + '\n');
      // FAKE_TOOLS_COST=<usd>: the gremlin reports this much spent (ACP usage_update, a running total) as it starts,
      // on its ticket's first session only (a later session of the same ticket works for free).
      const costMark = path.join(process.env.FAKE_TOOLS_LOG, 'cost-' + path.basename(cwd));
      if (process.env.FAKE_TOOLS_COST && !fs.existsSync(costMark)) {
        fs.writeFileSync(costMark, '');
        costSoFar[sessionId] = (costSoFar[sessionId] ?? 0) + Number(process.env.FAKE_TOOLS_COST);
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: 1000, size: 200000, cost: { amount: costSoFar[sessionId], currency: 'USD' } } } });
      }
      if (process.env.FAKE_TOOLS_DELAY) await new Promise(r => setTimeout(r, Number(process.env.FAKE_TOOLS_DELAY)));
      fs.appendFileSync(path.join(process.env.FAKE_TOOLS_LOG, 'working.txt'), `end ${path.basename(cwd)} ${Date.now()}\n`);
      if (process.env.FAKE_TOOLS_OUTSIDE) {
        const r = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 'w0', title: 'Write', kind: 'edit', locations: [{ path: path.join(cwd, '..', '..', 'outside.txt') }] }, options: [{ optionId: 'y', kind: 'allow_once', name: 'Allow' }, { optionId: 'n', kind: 'reject_once', name: 'Reject' }] });
        say(sessionId, r?.outcome?.optionId === 'y' ? 'wrote outside' : 'outside refused');
      }
      const r = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 'w1', title: 'Write ' + path.basename(file), kind: 'edit', locations: [{ path: file }] }, options: [{ optionId: 'y', kind: 'allow_once', name: 'Allow' }, { optionId: 'n', kind: 'reject_once', name: 'Reject' }] });
      if (r?.outcome?.optionId === 'y') fs.writeFileSync(file, '你好\n');
      await call(sessionId, 'submit_report', { kind: 'done', summary: '加了 ' + path.basename(file), changed: [path.basename(file)], verification: { command: 'type ' + path.basename(file), output: '你好' } });
    } else {
      say(sessionId, 'no tools');
    }
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
});
process.stdin.on('end', () => { try { mcp?.kill(); } catch {} process.exit(0); });
