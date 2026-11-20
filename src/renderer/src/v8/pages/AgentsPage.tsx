import './agents.css';
import { useEffect, useRef, useState } from 'react';
import type { AgentQuota, ChatTurn, ChoiceList, RosterRow, RosterView, SessionChoices, SignInFlow } from '@shared/v8/agents';
import { QuotaLine } from '../QuotaLine';
import { QuotaRuleBox } from '../QuotaRuleBox';
import { InstallBox } from '../InstallBox';
import { art } from '../gremlins';
import type { Hero } from './Pages';

interface Line { who: 'you' | 'agent' | 'note'; text: string }

const STATE: Record<RosterRow['state'], string> = { ready: '已装好', missing_program: '缺程序', not_installed: '没装', unsupported: '装不了' };
const SIGN: Record<RosterRow['signIn'], string> = { yes: '已登录', no: '未登录', unknown: '登录未知' };

/**
 * Every agent the app knows: which are on this computer, which are signed in, and a plain chat with one of them.
 * The chat is the smallest real thing: one sentence out, the agent's own answer back. It runs in an empty folder and
 * refuses every request to read, write or run.
 */
export function AgentsPage({ hero }: { hero: Hero }) {
  const [view, setView] = useState<RosterView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, Line[]>>({});
  const [text, setText] = useState('');
  const [waiting, setWaiting] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  /** What each agent offers, read from the agent itself once it is started. A string is why it could not be read. */
  const [choices, setChoices] = useState<Record<string, SessionChoices | string>>({});
  const end = useRef<HTMLDivElement>(null);
  /** Each ready agent's quota, read from its maker (no message, no quota used). */
  const [quotas, setQuotas] = useState<Record<string, AgentQuota>>({});
  const readQuotas = (rows: RosterRow[], fresh: boolean) => {
    for (const r of rows.filter(x => x.state === 'ready')) {
      window.cth.v8.agentQuota(r.id, fresh).then(q => setQuotas(old => ({ ...old, [r.id]: q })), () => undefined);
    }
  };

  const load = () => {
    setFailed(null);
    window.cth.v8.agents().then(v => { setView(v); setPicked(p => p ?? v.rows.find(r => r.state === 'ready')?.id ?? null); readQuotas(v.rows, false); }, e => setFailed(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lines, waiting, picked]);

  const rows = view?.rows ?? [];
  const here = rows.filter(r => r.state === 'ready' || r.state === 'missing_program');
  const shown = all ? rows : here;
  const agent = rows.find(r => r.id === picked) ?? null;
  const talk = picked ? lines[picked] ?? [] : [];
  const add = (id: string, more: Line[]) => setLines(old => ({ ...old, [id]: [...(old[id] ?? []), ...more] }));

  // Picking an agent that can talk starts it and asks what models it has. Nothing is sent to a model for this.
  useEffect(() => {
    if (!agent || agent.state !== 'ready' || agent.signIn === 'no' || choices[agent.id]) return;
    const id = agent.id;
    window.cth.v8.agentChoices(id).then(c => setChoices(old => ({ ...old, [id]: c })), e => setChoices(old => ({ ...old, [id]: e instanceof Error ? e.message : String(e) })));
  }, [agent?.id, agent?.state, agent?.signIn]);   // eslint-disable-line react-hooks/exhaustive-deps
  const offered = agent ? choices[agent.id] : undefined;
  const choose = (kind: 'model' | 'effort', value: string) => {
    if (!agent) return;
    const id = agent.id;
    window.cth.v8.agentChoose(id, kind, value).then(c => setChoices(old => ({ ...old, [id]: c })), e => add(id, [{ who: 'note', text: '没换成：' + (e instanceof Error ? e.message : String(e)) }]));
  };

  const send = () => {
    const said = text.trim();
    if (!agent || agent.state !== 'ready' || !said || waiting) return;
    const id = agent.id;
    setText(''); setWaiting(id); add(id, [{ who: 'you', text: said }]);
    window.cth.v8.agentSay(id, said).then((t: ChatTurn) => {
      const more: Line[] = [];
      if (t.reply) more.push({ who: 'agent', text: t.reply });
      if (t.refused.length) more.push({ who: 'note', text: '它想做这些事，这里一律不让：' + t.refused.join('、') });
      if (t.error) more.push({ who: 'note', text: '没答完：' + t.error });
      if (!more.length) more.push({ who: 'note', text: '它答完了，但没有说话。' });
      add(id, more);
    }, e => add(id, [{ who: 'note', text: '没发出去：' + (e instanceof Error ? e.message : String(e)) }])).finally(() => setWaiting(null));
  };

  return <section className="v8p v8a" aria-label="agent 名单">
    <div className="v8a-head">
      <img className="v8-g v8p-hero" style={hero} src={art('alien', 'reading')} alt="" />
      <div><span className="v8-cap">agent 名单 · 这台电脑</span><h1>谁在，谁能说话</h1>
        <p className="v8m-sub">{view ? `装好的 ${here.length} 个，名单上一共 ${rows.length} 个。看名单和额度都不花额度。` : failed ? '名单没读出来：' + failed : '正在看这台电脑上有哪些 agent…'}</p></div>
    </div>

    <div className="v8a-list" role="list">
      {shown.map(r => <button key={r.id} type="button" role="listitem" className={'v8a-row is-' + r.state + (r.id === picked ? ' is-picked' : '')} aria-pressed={r.id === picked} onClick={() => setPicked(r.id)}>
        <b>{r.name}</b>
        <span className={'v8a-tag is-' + r.state}>{STATE[r.state]}</span>
        {r.state === 'ready' && <span className={'v8a-tag is-sign-' + r.signIn}>{SIGN[r.signIn]}</span>}
        <small>{r.note}</small>
        {r.state === 'ready' && <QuotaLine q={quotas[r.id]} />}
      </button>)}
      {view && !shown.length && <p className="v8m-sub">这台电脑上还没有装好的 agent。</p>}
      {view && <button type="button" className="v8-quiet-btn v8a-more" onClick={() => setAll(a => !a)}>{all ? '只看装好的' : `看全部 ${rows.length} 个（含没装的）`}</button>}
      {failed && <button type="button" className="v8-back" onClick={load}>再读一次</button>}
      {view && <QuotaRuleBox />}
      {view && here.length > 0 && <button type="button" className="v8-quiet-btn v8a-more" onClick={() => { setQuotas({}); readQuotas(rows, true); }}>重新读额度</button>}
    </div>

    <div className="v8a-chat">
      {agent ? <>
        <span className="v8-cap">跟 {agent.name} 说一句</span>
        {agent.state === 'ready' && agent.signIn === 'no' && agent.canSignIn && <SignInBox id={agent.id} name={agent.name} onDone={load} />}
        <InstallBox row={agent} onDone={v => { setView(v); readQuotas(v.rows, false); }} />
        {typeof offered === 'object' && (offered.model || offered.effort) && <div className="v8a-pick">
          {offered.model && <Pick label="模型" list={offered.model} disabled={!!waiting} onChange={v => choose('model', v)} />}
          {offered.effort && <Pick label="推理档位" list={offered.effort} disabled={!!waiting} onChange={v => choose('effort', v)} />}
        </div>}
        {offered === undefined && agent.state === 'ready' && agent.signIn !== 'no' && <p className="v8m-sub">正在问它有哪些模型（第一次要等十几秒，不花额度）…</p>}
        {typeof offered === 'string' && <p className="v8a-line is-note"><span>说明</span>没读到它有哪些模型：{offered}</p>}
        <div className="v8a-talk" aria-live="polite">
          {!talk.length && !(agent.signIn === 'no' && agent.canSignIn) && <p className="v8m-sub">{agent.state === 'ready'
            ? '发一句话，看它回。这是真的消息，会用掉它的一点额度。它在一个空文件夹里，读写文件和跑命令的请求一律不让。'
            : agent.note}</p>}
          {talk.map((l, i) => <p key={i} className={'v8a-line is-' + l.who}><span>{l.who === 'you' ? '你' : l.who === 'agent' ? agent.name : '说明'}</span>{l.text}</p>)}
          {waiting === agent.id && <p className="v8a-line is-note"><span>说明</span>等它回话…</p>}
          <div ref={end} />
        </div>
        <div className="v8p-ask">
          <input value={text} disabled={agent.state !== 'ready'} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(); }}
            placeholder={agent.state === 'ready' ? '比如：你好，回两个字' : '这个 agent 现在说不了话'} aria-label={'跟 ' + agent.name + ' 说话'} />
          <button type="button" className="v8-send" disabled={agent.state !== 'ready' || !!waiting || !text.trim()} onClick={send}>发话</button>
        </div>
      </> : <p className="v8m-sub">左边选一个 agent。</p>}
    </div>
  </section>;
}

/** One drop-down of what the agent offers. Its own names are shown as they are; a group is the agent's own heading. */
function Pick({ label, list, disabled, onChange }: { label: string; list: ChoiceList; disabled: boolean; onChange(value: string): void }) {
  const groups = [...new Set(list.choices.map(c => c.group))];
  return <label className="v8a-select"><span className="v8-cap">{label}</span>
    <select value={list.current ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)}>
      {list.current === null && <option value="" disabled>它自己默认的</option>}
      {groups.map(g => g === null
        ? list.choices.filter(c => c.group === null).map(c => <option key={c.id} value={c.id}>{c.label}</option>)
        : <optgroup key={g} label={g}>{list.choices.filter(c => c.group === g).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>)}
    </select>
  </label>;
}

/**
 * Signing in to an agent from the roster. The agent's own program shows its maker's sign-in page (and usually opens
 * the browser by itself); the person signs in there. If the page then shows a code, it is pasted here.
 */
function SignInBox({ id, name, onDone }: { id: string; name: string; onDone(): void }) {
  const [flow, setFlow] = useState<SignInFlow | null>(null);
  const [starting, setStarting] = useState(false);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const why = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);

  // While it waits, ask now and then whether the person has finished on the maker's page.
  useEffect(() => {
    if (flow?.phase !== 'waiting') return;
    const t = setInterval(() => {
      void window.cth.v8.agentSignInStatus(id, flow.flowId).then(f => { if (f && f.phase !== 'waiting') setFlow(f); }, () => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [id, flow?.flowId, flow?.phase]);
  useEffect(() => { if (flow?.phase === 'succeeded') onDone(); }, [flow?.phase]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { void window.cth.v8.agentSignInCancel(id).catch(() => undefined); }, [id]);

  const start = () => {
    setStarting(true); setProblem(null); setCode('');
    window.cth.v8.agentSignInStart(id).then(setFlow, e => setProblem(why(e))).finally(() => setStarting(false));
  };
  const send = () => {
    if (!flow) return;
    setProblem(null);
    window.cth.v8.agentSignInCode(id, flow.flowId, code).then(setFlow, e => setProblem(why(e)));
  };

  if (!flow || flow.phase === 'cancelled') {
    return <div className="v8a-signin">
      <p>{name} 还没登录。点下面的按钮，它会打开官方的登录页，你在那里用自己的账号登录。小怪工坊不会看到也不会保存你的密码。</p>
      <button type="button" className="v8-send" disabled={starting} onClick={start}>{starting ? '正在打开登录页…' : '去登录'}</button>
      {problem && <small className="v8a-problem">{problem}</small>}
    </div>;
  }
  if (flow.phase === 'succeeded') return <div className="v8a-signin is-ok"><p>登录好了。现在可以跟 {name} 说话了。</p></div>;
  if (flow.phase !== 'waiting') {
    return <div className="v8a-signin"><p>没登录上：{flow.message ?? '原因没说。'}</p>
      <button type="button" className="v8-send" onClick={start}>再试一次</button></div>;
  }
  return <div className="v8a-signin">
    {flow.code ? <>
      <p><button type="button" className="v8a-link" disabled={!flow.url} onClick={() => flow.url && void window.cth.openExternal(flow.url)}>点这里打开 {name} 的登录页</button>，用你自己的账号登录，再在页面上输入这串代码：</p>
      <p className="v8a-code">{flow.code}</p>
      <p>输入完等几秒，这里会自己变成登录好了。</p>
    </> : <>
    <p>浏览器里应该已经打开了登录页。如果没打开，<button type="button" className="v8a-link" disabled={!flow.url} onClick={() => flow.url && void window.cth.openExternal(flow.url)}>点这里打开</button>。</p>
    <p>登录完，如果页面上给了一串代码，贴到下面；没给代码的话等几秒，这里会自己变成登录好了。</p>
    </>}
    {!flow.code && <div className="v8p-ask">
      <input value={code} onChange={e => setCode(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(); }} placeholder="登录页给的代码" aria-label="登录页给的代码" />
      <button type="button" className="v8-send" disabled={!code.trim()} onClick={send}>交代码</button>
    </div>}
    <button type="button" className="v8-quiet-btn" onClick={() => { void window.cth.v8.agentSignInCancel(id).then(() => setFlow(null)); }}>取消</button>
    {problem && <small className="v8a-problem">{problem}</small>}
  </div>;
}
