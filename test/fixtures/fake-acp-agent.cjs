'use strict';
// A stand-in ACP agent for tests: speaks the protocol over stdio, calls no model.
//   "ping"            -> answers "pong" in two chunks
//   "write a file"    -> asks permission first, then says what the answer was
//   "who"             -> says how many messages this session has had
//   FAKE_ACP_SIGNED_OUT=1 -> session/new fails with "Authentication required"
const readline = require('node:readline');
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const waiting = new Map();
let next = 1000, turns = 0;
// Session options the way real agents offer them: models inside named groups, and a reasoning effort.
const chosen = { model: 'a/fast', effort: 'low' };
const options = () => [
  { id: 'model', category: 'model', currentValue: chosen.model, options: [
    { name: 'Route A', options: [{ value: 'a/fast', name: 'Fast' }, { value: 'a/deep', name: 'Deep' }] },
    { name: 'Route B', options: [{ value: 'b/fast', name: 'Fast' }] } ] },
  { id: 'reasoning_effort', category: 'thought_level', currentValue: chosen.effort, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];
const ask = (method, params) => new Promise(resolve => { const id = next++; waiting.set(id, resolve); send({ id, method, params }); });
const say = (sessionId, text) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });

readline.createInterface({ input: process.stdin }).on('line', async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method === undefined) { waiting.get(m.id)?.(m.result ?? m.error); waiting.delete(m.id); return; }
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'fake', title: 'Fake Agent', version: '1' }, agentCapabilities: { loadSession: true }, authMethods: [] } });
  // A resumed session starts on the agent's defaults again, as Codex's does.
  if (m.method === 'session/load') { chosen.model = 'a/fast'; chosen.effort = 'low'; return send({ id: m.id, result: { configOptions: options() } }); }
  if (m.method === 'session/new') {
    if (process.env.FAKE_ACP_SIGNED_OUT) return send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    return send({ id: m.id, result: { sessionId: 's1', ...(process.env.FAKE_ACP_NO_OPTIONS ? {} : { configOptions: options() }) } });
  }
  if (m.method === 'session/set_config_option') {
    const key = m.params.configId === 'model' ? 'model' : 'effort';
    const offered = JSON.stringify(options().find(o => o.id === m.params.configId));
    if (!offered.includes('"value":' + JSON.stringify(m.params.value))) return send({ id: m.id, error: { code: -32602, message: 'unknown value' } });
    chosen[key] = m.params.value;
    return send({ id: m.id, result: { configOptions: options() } });
  }
  if (m.method === 'session/prompt') {
    turns++;
    const text = m.params.prompt.map(p => p.text ?? '').join('');
    const sessionId = m.params.sessionId;
    if (text.includes('write')) {
      const r = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 't1', title: 'Write notes.txt', kind: 'edit' }, options: [{ optionId: 'y', kind: 'allow_once', name: 'Allow' }, { optionId: 'n', kind: 'reject_once', name: 'Reject' }] });
      say(sessionId, r?.outcome?.optionId === 'y' ? 'written' : 'not allowed');
    } else if (text.includes('who')) say(sessionId, 'turn ' + turns);
    else if (text.includes('model')) say(sessionId, chosen.model + ' ' + chosen.effort);
    else { say(sessionId, 'po'); say(sessionId, 'ng'); }
    // FAKE_ACP_COST=reported: a running dollar total, as Claude's adapter sends it. =tokens: token counts only, as Codex.
    if (process.env.FAKE_ACP_COST === 'reported') send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 0.25 * turns, currency: 'USD' } } } });
    const usage = process.env.FAKE_ACP_COST === 'tokens' ? { usage: { totalTokens: 3100, inputTokens: 1000, cachedReadTokens: 2000, cachedWriteTokens: 0, outputTokens: 100 } } : {};
    return send({ id: m.id, result: { stopReason: 'end_turn', ...usage } });
  }
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
});
