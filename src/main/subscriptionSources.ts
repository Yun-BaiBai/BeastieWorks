import { closeSync,existsSync,fstatSync,lstatSync,mkdirSync,openSync,readSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
export type SubscriptionProvider='claude'|'codex'|'copilot'|'gemini'|'grok';
export interface SubscriptionSource {id:string;provider:SubscriptionProvider;path:string;destination:string;area:'home'|'config'}
export function subscriptionSources(home:string,config:string):SubscriptionSource[]{return [
  {id:'claude-auth',provider:'claude',path:join(home,'.claude','.credentials.json'),destination:'.claude/.credentials.json',area:'home'},
  {id:'codex-auth',provider:'codex',path:join(home,'.codex','auth.json'),destination:'.codex/auth.json',area:'home'},
  {id:'copilot-cli',provider:'copilot',path:join(home,'.copilot','config.json'),destination:'.copilot/config.json',area:'home'},
  {id:'copilot-hosts',provider:'copilot',path:join(config,'github-copilot','hosts.json'),destination:'github-copilot/hosts.json',area:'config'},
  {id:'copilot-apps',provider:'copilot',path:join(config,'github-copilot','apps.json'),destination:'github-copilot/apps.json',area:'config'},
  {id:'gemini-auth',provider:'gemini',path:join(home,'.gemini','oauth_creds.json'),destination:'.gemini/oauth_creds.json',area:'home'},
  {id:'grok-auth',provider:'grok',path:join(home,'.grok','auth.json'),destination:'.grok/auth.json',area:'home'},
];}
/** Presence only. A file is a candidate, never proof of valid login or quota. */
export function discoverSubscriptions(home:string,config:string):Array<{id:string;provider:SubscriptionProvider;path:string;bytes:number;safe:boolean}>{return subscriptionSources(home,config).filter(s=>existsSync(s.path)).map(s=>{const stat=lstatSync(s.path);return {id:s.id,provider:s.provider,path:s.path,bytes:stat.size,safe:stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4*1024*1024};});}
export function selectSubscriptionSources(home:string,config:string,providers:unknown):SubscriptionSource[]{
  if(!Array.isArray(providers)||!providers.length||providers.length>5||new Set(providers).size!==providers.length||providers.some(p=>!['claude','codex','copilot','gemini','grok'].includes(p)))throw Error('EXPLICIT_SUBSCRIPTION_PROVIDERS_REQUIRED');
  const available=subscriptionSources(home,config).filter(s=>providers.includes(s.provider)&&existsSync(s.path));if(providers.some(p=>!available.some(s=>s.provider===p)))throw Error('SELECTED_SUBSCRIPTION_SOURCE_MISSING');return available;
}
/** Copy approved sign-ins into the owned gateway profile; never rewrite originals. */
export function copySubscriptionSources(sources:SubscriptionSource[],home:string,config:string):void {
  const allowed=subscriptionSources('source-home','source-config');
  const copies=sources.map(s=>{
    if(!allowed.some(a=>a.id===s.id&&a.provider===s.provider&&a.area===s.area&&a.destination===s.destination))throw Error('INVALID_SUBSCRIPTION_DESTINATION');
    const stat=lstatSync(s.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw Error('SUBSCRIPTION_SOURCE_UNSAFE_OR_OVERSIZED');
    const fd=openSync(s.path,'r');let bytes:Buffer;try{const before=fstatSync(fd),buffer=Buffer.alloc(stat.size+1);let n=0;while(n<buffer.length){const got=readSync(fd,buffer,n,buffer.length-n,null);if(!got)break;n+=got;}const after=fstatSync(fd),current=lstatSync(s.path);if(n!==stat.size||before.ino!==stat.ino||before.dev!==stat.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs||current.ino!==before.ino||current.dev!==before.dev||current.isSymbolicLink())throw Error('SUBSCRIPTION_SOURCE_CHANGED');bytes=buffer.subarray(0,n);}finally{closeSync(fd);}
    try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();}catch{throw Error('SUBSCRIPTION_SOURCE_INVALID_JSON');}
    return {destination:join(s.area==='home'?home:config,...s.destination.split('/')),bytes};
  });
  for(const c of copies){mkdirSync(join(c.destination,'..'),{recursive:true});writeFileSync(c.destination,c.bytes,{flag:'wx',mode:0o600});}
}
