import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { validateSeatExecutable, workspacePath } from './safePaths';
import { copySubscriptionSources,type SubscriptionSource } from './subscriptionSources';

export const MAGPIE_RUNTIME = {
  version: '0.1.1336', commit: 'a77b5b4fc9eb258941e49324cbda2791b4c47e52',
  sha256: '29ab69019f6aa375c2a13811c71e862c40121dd4eaa0a31c252979bc1afb64ce',
};
const ensure = (ok: unknown, message: string): void => { if (!ok) throw new Error(message); };
export function localGatewayOrigin(input: string): string {
  const url = new URL(input);
  ensure(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && /^\/(v1\/?)?$/.test(url.pathname), 'MAGPIE_REQUIRES_LOCAL_ORIGIN');
  return url.origin;
}
export function remoteGatewayOrigin(input:string):string {
  const url=new URL(input);ensure(!url.username&&!url.password&&!url.search&&!url.hash&&/^\/(v1\/?)?$/.test(url.pathname),'INVALID_REMOTE_MAGPIE_ORIGIN');
  ensure(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)),'REMOTE_MAGPIE_REQUIRES_TLS');return url.origin;
}
export function gatewayAuthorization(envName?:string):string {
  if(envName===undefined)return 'Bearer magpie-agentcorp';
  ensure(/^AGENTCORP_GATEWAY_AUTH_[A-Z0-9_]{1,64}$/.test(envName),'INVALID_GATEWAY_AUTH_ENV');
  const value=process.env[envName];ensure(typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\r\n\0]/.test(value),'GATEWAY_AUTH_ENV_UNAVAILABLE');return value!;
}
export interface GatewayObservation {
  available: boolean; status: number | null; observed_at: number; value: unknown | null; error?: string;
}
export class MagpieClient {
  readonly origin: string;
  constructor(endpoint: string, private timeout = 5000, private signal?: AbortSignal,remote=false,private authorization='Bearer magpie-agentcorp') { this.origin = remote?remoteGatewayOrigin(endpoint):localGatewayOrigin(endpoint); }
  private async read(path: string): Promise<GatewayObservation> {
    try {
      const response = await fetch(this.origin + path, {
        redirect: 'error', signal: this.signal ? AbortSignal.any([this.signal,AbortSignal.timeout(this.timeout)]) : AbortSignal.timeout(this.timeout),
        headers: { 'User-Agent': 'AgentCorp/0.1', Authorization: this.authorization },
      });
      if (!response.ok) { await response.body?.cancel(); return { available: false, status: response.status, observed_at: Date.now(), value: null }; }
      const reader = response.body?.getReader(); if (!reader) throw new Error('EMPTY_GATEWAY_RESPONSE');
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > 1024 * 1024) { await reader.cancel(); throw new Error('GATEWAY_RESPONSE_TOO_LARGE'); }
        chunks.push(next.value);
      }
      return { available: true, status: response.status, observed_at: Date.now(), value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch (error) {
      return { available: false, status: null, observed_at: Date.now(), value: null, error: error instanceof Error ? error.name : 'GATEWAY_UNAVAILABLE' };
    }
  }
  async probe(): Promise<GatewayObservation> {
    const result = await this.read('/api/hello');
    if (result.available && (result.value as { name?: string })?.name !== 'magpie') return { ...result, available: false, value: null, error: 'NOT_MAGPIE' };
    return result;
  }
  async models(): Promise<GatewayObservation> {
    const result = await this.read('/v1/models');
    if (result.available && !Array.isArray((result.value as { data?: unknown })?.data)) return { ...result, available: false, value: null, error: 'INVALID_MODEL_CATALOG' };
    return result;
  }
  route(session: string): Promise<GatewayObservation> { return this.read('/v1/magpie/route?session=' + encodeURIComponent(session)); }
  trace():Promise<GatewayObservation> { return this.read('/v1/magpie/trace'); }
  quotas(): Promise<GatewayObservation> { return this.read('/v1/magpie/quotas'); }
  // This pinned upstream supports q (substring search), not a session filter.
  // Return its raw page; consumers must check row.session before task accounting.
  usage(session: string, offset = 0): Promise<GatewayObservation> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('INVALID_USAGE_OFFSET');
    return this.read('/v1/magpie/usage/requests?q=' + encodeURIComponent(session) + '&period=all&via=through&limit=100&offset=' + offset);
  }
}

/**
 * inPlace (v8, 老板 2026-11-20): Magpie reads each agent's own sign-in where the agent keeps it, the way the Magpie app
 * does ("nothing is stored twice", providers-accounts.md), so a token it renews is the one the agent uses too. Its own
 * settings, cache and data stay in the private folder. `env` adds the places to look (CLAUDE_CONFIG_DIR of the app's
 * Claude, PATH for the `claude` program the Claude bridge runs).
 */
interface MagpieStartOptions { root: string; executable: string; inPlace?: { env: Record<string, string> }; subscriptionSources?:SubscriptionSource[]; fixtureUpstream?: string; fixtureProtocol?: 'responses' | 'chat'|'anthropic'|'gemini';fixturePool?:{secondUpstream:string;strategy:'smart'|'order'|'rotate'|'usage'|'pace'} }
export interface MagpieStatus { running: boolean; starting: boolean; stopping: boolean; pid: number | null; origin: string | null; directory: string | null; version: string;remote?:boolean }
/** Private, explicitly started sidecar. No default-port probing or account discovery. */
export class MagpieGateway {
  private remote: {origin:string;directory:string;authorizationEnv?:string}|null=null;
  private child: ChildProcess | null = null;
  private origin: string | null = null;
  private directory: string | null = null;
  private starting = false;
  private stopping = false;
  private cancelled = false;
  private stopPromise: Promise<void> | null = null;
  private startupDone: Promise<void> | null = null;
  status(): MagpieStatus { if(this.remote)return {running:true,starting:false,stopping:false,pid:null,origin:this.remote.origin,directory:this.remote.directory,version:'remote-unverified',remote:true};return { running: !!this.child && this.child.exitCode === null && !this.starting && !this.stopping, starting: this.starting, stopping: this.stopping, pid: this.child?.pid ?? null, origin: this.origin, directory: this.directory, version: MAGPIE_RUNTIME.version }; }
  client(signal?:AbortSignal):MagpieClient {const state=this.status();ensure(state.running&&state.origin,'MAGPIE_NOT_RUNNING');return new MagpieClient(state.origin!,5000,signal,!!this.remote,this.remote?gatewayAuthorization(this.remote.authorizationEnv):undefined);}
  async connectRemote(root:string,endpoint:string,authorizationEnv?:string):Promise<MagpieStatus> {
    ensure(!this.child&&!this.remote&&!this.starting&&!this.stopping,'MAGPIE_ALREADY_RUNNING');
    const origin=remoteGatewayOrigin(endpoint),authorization=gatewayAuthorization(authorizationEnv);this.starting=true;this.cancelled=false;
    let done!:()=>void;this.startupDone=new Promise(resolve=>done=resolve);
    try{const client=new MagpieClient(origin,5000,undefined,true,authorization),hello=await client.probe();ensure(hello.available,'REMOTE_MAGPIE_UNAVAILABLE_OR_WRONG_SERVICE');ensure((await client.models()).available,'REMOTE_MAGPIE_CATALOG_UNAVAILABLE');ensure(!this.cancelled,'MAGPIE_START_CANCELLED');const directory=workspacePath(root,'.agentcorp/gateways/remote/'+randomUUID());mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'connection.json'),JSON.stringify({origin,authorization_env:authorizationEnv??null,remote:true})+'\n',{flag:'wx'});this.remote={origin,directory,authorizationEnv};return this.status();}finally{this.starting=false;this.startupDone=null;done();}
  }

  async start(options: MagpieStartOptions): Promise<MagpieStatus> {
    ensure(!this.child && !this.remote && !this.starting && !this.stopping, 'MAGPIE_ALREADY_RUNNING');
    validateSeatExecutable(options.executable);
    ensure(createHash('sha256').update(readFileSync(options.executable)).digest('hex') === MAGPIE_RUNTIME.sha256, 'MAGPIE_BINARY_DIGEST_MISMATCH');
    if (options.fixtureUpstream) localGatewayOrigin(options.fixtureUpstream);
    this.starting = true;
    this.cancelled = false;
    let finishStartup!: () => void;
    this.startupDone = new Promise(resolve => { finishStartup = resolve; });
    try {
      const directory = workspacePath(options.root, '.agentcorp/gateways/magpie/' + randomUUID());
      const home = join(directory, 'home'), config = join(directory, 'config'), cache = join(directory, 'cache'), data = join(directory, 'data'), state = join(directory, 'state'), temp = join(directory, 'tmp');
      for (const path of [home,config,cache,data,state,temp,join(config,'magpie'),join(home,'AppData/Roaming'),join(home,'AppData/Local')]) mkdirSync(path, { recursive: true });
      if(options.subscriptionSources?.length)copySubscriptionSources(options.subscriptionSources,home,config);
      const discover=!!options.subscriptionSources?.length||!!options.inPlace;
      writeFileSync(join(config, 'magpie/settings.json'), JSON.stringify({ noAccountDiscovery: !discover, noWSLAgents: true, noStats: true, noUsageStats: true, noAutoUpdate: true, noAutoDownload: true, autoRestart: false, lan: false }));
      if (options.fixtureUpstream) {
        const first={
          id: 'agentcorp-fixture', name: 'AgentCorp local fixture', key: '',
          [options.fixtureProtocol??'responses']: localGatewayOrigin(options.fixtureUpstream) + (options.fixtureProtocol==='anthropic'?'':options.fixtureProtocol==='gemini'?'/v1beta':'/v1'),
          baseAPI: options.fixtureProtocol ?? 'responses', models: ['fixture-model'],
        };
        const pool=options.fixturePool;
        writeFileSync(join(config, 'magpie/providers.json'), JSON.stringify({ noAutoGroups: true, providers:pool?[first,{id:'agentcorp-fixture-b',name:'AgentCorp second fixture',key:'',responses:localGatewayOrigin(pool.secondUpstream)+'/v1',baseAPI:'responses',models:['fixture-model']}]:[first],...(pool?{groups:[{id:'fixture-pool',name:'Synthetic pool',members:['agentcorp-fixture/fixture-model','agentcorp-fixture-b/fixture-model'],routing:pool.strategy,affinity:'session',patience:-1},{id:'fixture-nested',name:'Synthetic nested',members:['group/fixture-pool'],routing:pool.strategy,affinity:'session',patience:-1}]}:{}) }));
      }
      // Reserve an ephemeral loopback port; a collision makes startup fail, never reuse an unknown service.
      const port = await new Promise<number>((resolve, reject) => {
        const reservation = createServer(); reservation.on('error', reject);
        reservation.listen(0, '127.0.0.1', () => { const port = (reservation.address() as { port: number }).port; reservation.close(error => error ? reject(error) : resolve(port)); });
      });
      const origin = `http://127.0.0.1:${port}`;
      ensure(!this.cancelled, 'MAGPIE_START_CANCELLED');
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined && /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|LANG|LC_ALL|LC_CTYPE|TZ)$/i.test(key)) env[key] = value;
      const real = options.inPlace ? { HOME: process.env.USERPROFILE ?? process.env.HOME ?? home, USERPROFILE: process.env.USERPROFILE ?? process.env.HOME ?? home, APPDATA: process.env.APPDATA ?? join(home,'AppData/Roaming'), LOCALAPPDATA: process.env.LOCALAPPDATA ?? join(home,'AppData/Local'), ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) } : null;
      Object.assign(env, real ?? {
        HOME: home, USERPROFILE: home, APPDATA: join(home,'AppData/Roaming'), LOCALAPPDATA: join(home,'AppData/Local'),
      }, {
        XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_DATA_HOME: data, XDG_STATE_HOME: state,
        TEMP: temp, TMP: temp, MAGPIE_ADDR: `127.0.0.1:${port}`, MAGPIE_NO_ACCOUNTS: discover?'0':'1',
      }, options.inPlace?.env ?? {});
      if (options.inPlace?.env.PATH) {
        // Windows keeps one PATH whatever its spelling: drop every spelling, then set one with the extra folders first.
        const system = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH');
        for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
        env.Path = options.inPlace.env.PATH + (process.platform === 'win32' ? ';' : ':') + (system ? process.env[system] ?? '' : '');
      }
      const child = spawn(options.executable, ['serve'], { cwd: directory, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
      this.child = child; this.directory = directory; this.origin = origin;
      let startupError: Error | null = null, tail = '';
      child.on('error', error => { startupError = error; });
      const capture = (part: Buffer): void => { tail = (tail + part.toString('utf8')).slice(-8000); };
      child.stdout?.on('data', capture); child.stderr?.on('data', capture);
      child.once('exit', () => { if (this.child === child) this.child = null; });
      const client = new MagpieClient(origin, 500), deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        ensure(!this.cancelled, 'MAGPIE_START_CANCELLED');
        if (startupError || child.exitCode !== null) throw new Error('MAGPIE_START_FAILED:' + (startupError ? (startupError as Error).message : tail.slice(-1000)));
        const hello = await client.probe();
        ensure(!this.cancelled, 'MAGPIE_START_CANCELLED');
        if (hello.available && this.child === child && child.exitCode === null) {
          this.starting = false;
          return this.status();
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('MAGPIE_START_TIMEOUT');
    } catch (error) { await this.stopChild(); throw error; }
    finally { this.starting = false; this.startupDone = null; finishStartup(); }
  }

  stop(): Promise<void> {
    this.cancelled = true;
    this.remote=null; // A remote process belongs to its host; disconnect never kills it.
    const startup = this.startupDone, stopped = this.stopChild();
    // Quit/relaunch must also wait for a cancelled pre-spawn reservation to settle.
    return startup ? Promise.all([startup, stopped]).then(() => undefined) : stopped;
  }

  private stopChild(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) { this.origin = null; return Promise.resolve(); }
    if (!child.pid) { this.child = null; this.origin = null; return Promise.resolve(); }
    this.stopping = true;
    const task = (async () => { try {
      // This child is owned by this instance; no process-name or global-port sweeping.
      if (child.exitCode === null) child.kill();
      if (child.exitCode === null) await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('MAGPIE_EXIT_UNCONFIRMED')); }, 5000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
      this.child = null; this.origin = null;
    } finally { this.stopping = false; } })();
    const completion = task.finally(() => { if (this.stopPromise === completion) this.stopPromise = null; });
    this.stopPromise = completion;
    return this.stopPromise;
  }
}
