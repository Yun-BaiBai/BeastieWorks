'use strict';
// A stand-in for `omp --mode rpc` that speaks the same NDJSON protocol without any model. It plays a gremlin:
// reads, edits a file (asking approval), runs the tests (asking approval), then calls the host's report tool.
// Behaviour follows words in the prompt. Writes every frame it received to FAKE_OMP_LOG if set.
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), cwd = args[args.indexOf('--cwd') + 1], sessionDir = args[args.indexOf('--session-dir') + 1];
const log = process.env.FAKE_OMP_LOG;
const out = f => process.stdout.write(JSON.stringify(f) + '\n');
let session = path.join(sessionDir, 'fake-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.jsonl');
let seq = 0, aborted = false;
const waiting = new Map();
const ask = (frame) => new Promise(r => { waiting.set(frame.id, r); out(frame); });
if (log) fs.appendFileSync(log, JSON.stringify({ argv: args, env: { key: !!process.env.OPENAI_API_KEY, agentDir: process.env.PI_CODING_AGENT_DIR, secret: process.env.SHOULD_NOT_LEAK ?? null, magpieKey: process.env.AGENTCORP_MAGPIE_KEY ?? null } }) + '\n');

async function turn(id, text) {
  aborted = false;
  const tool = (name, a, result = 'ok', isError = false) => { const c = 'call' + ++seq; out({ type: 'tool_execution_start', toolCallId: c, toolName: name, args: a }); out({ type: 'tool_execution_end', toolCallId: c, toolName: name, isError, result: { content: [{ type: 'text', text: result }] } }); };
  if (/崩溃/.test(text)) process.exit(3);
  if (/孙进程/.test(text)) {   // a command omp started that would outlive it (S2.4)
    const gc = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: process.env });
    if (log) fs.appendFileSync(log, JSON.stringify({ grandchild: gc.pid }) + '\n');
    await new Promise(r => { waiting.set('steer', r); });
  }
  tool('read', { path: 'calc.py' }, 'def add(a, b):\n    return a - b');
  const target = /越界/.test(text) ? '../outside.txt' : 'calc.py';
  const edit = await ask({ type: 'extension_ui_request', id: 'ui' + ++seq, method: 'select', title: 'Allow tool: edit\nFile: ' + target, options: ['Approve', 'Approve edit for this session', 'Deny'] });
  if (aborted) return out({ type: 'prompt_result', id, status: 'aborted' });
  if (edit.value === 'Approve') { fs.writeFileSync(path.resolve(cwd, target), 'def add(a, b):\n    return a + b\n'); tool('edit', { path: target }); }
  else tool('edit', { path: target }, 'Tool call denied by user: edit', true);
  const command = /联网/.test(text) ? 'curl https://example.com' : process.execPath.includes(' ') ? 'node -e "0"' : 'node -e "0"';
  const run = await ask({ type: 'extension_ui_request', id: 'ui' + ++seq, method: 'select', title: 'Allow tool: bash\nCommand: ' + command, options: ['Approve', 'Deny'] });
  if (aborted) return out({ type: 'prompt_result', id, status: 'aborted' });
  out({ type: 'extension_ui_request', id: 'w' + ++seq, method: 'setWidget', widgetKey: 'x' });   // needs no answer
  const ok = edit.value === 'Approve' && run.value === 'Approve';
  if (/慢/.test(text)) await new Promise(r => { waiting.set('steer', r); });
  if (aborted) return out({ type: 'prompt_result', id, status: 'aborted' });
  const report = ok
    ? { kind: 'done', summary: '把减号改成了加号' + (steered ? '，并且' + steered : ''), changed: ['calc.py'], verification: { command, output: 'ok' } }
    : { kind: 'blocked', where: '审批没通过', tried: 'edit=' + edit.value + ' bash=' + run.value };
  const r = await ask({ type: 'host_tool_call', id: 'host' + ++seq, toolCallId: 't' + seq, toolName: 'submit_report', arguments: report });
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: r.isError ? '报告被退回' : '交了报告' }] } });
  out({ type: 'prompt_result', id, agentInvoked: true, status: 'completed', sessionSettled: true });
}
let steered = '';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    const f = JSON.parse(line);
    if (log) fs.appendFileSync(log, line + '\n');
    if (f.type === 'extension_ui_response' || f.type === 'host_tool_result') { const w = waiting.get(f.id); if (w) { waiting.delete(f.id); w(f); } continue; }
    if (f.type === 'set_host_tools') { out({ id: f.id, type: 'response', command: f.type, success: true, data: { toolNames: f.tools.map(t => t.name) } }); continue; }
    if (f.type === 'switch_session') { session = f.sessionPath; out({ id: f.id, type: 'response', command: f.type, success: true }); continue; }
    if (f.type === 'get_state') { fs.mkdirSync(path.dirname(session), { recursive: true }); fs.appendFileSync(session, ''); out({ id: f.id, type: 'response', command: f.type, success: true, data: { sessionFile: session, sessionId: path.basename(session), isStreaming: false } }); continue; }
    if (f.type === 'get_session_stats') { out({ id: f.id, type: 'response', command: f.type, success: true, data: { tokens: { total: 100 }, cost: 0.01 * seq } }); continue; }
    if (f.type === 'prompt') { out({ id: f.id, type: 'response', command: 'prompt', success: true }); void turn(f.id, f.message); continue; }
    if (f.type === 'steer') { steered = f.message; const w = waiting.get('steer'); if (w) { waiting.delete('steer'); w(); } continue; }
    if (f.type === 'abort') { aborted = true; for (const [k, w] of waiting) { waiting.delete(k); w({ value: 'Deny' }); } continue; }
  }
});
process.stdin.on('end', () => process.exit(0));
out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] });
