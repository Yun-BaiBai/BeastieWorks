import { spawnSync, execFile } from 'node:child_process';
import { join } from 'node:path';
export interface ProcessIdentity { pid: number; parent: number; started: string }
interface Query { file: string; args: string[]; timeout: number; parse(stdout: string): ProcessIdentity[] }
/** Read only identities, never command lines or environment. Failure is not an empty tree. */
function query(): Query {
  if (process.platform === 'win32') {
    const command = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o')} }) | ConvertTo-Json -Compress";
    return { file: join(process.env.SystemRoot ?? 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'), args: ['-NoProfile','-NonInteractive','-Command',command], timeout: 10_000, parse: stdout => {
      const rows: unknown = JSON.parse(stdout.replace(/^\uFEFF/,''));
      if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(row?.pid) || !Number.isSafeInteger(row?.parent) || typeof row?.started !== 'string' || !row.started)) throw new Error('INVALID_PROCESS_TREE');
      return rows;
    } };
  }
  return { file: 'ps', args: ['-axo','pid=,ppid=,lstart='], timeout: 5000, parse: stdout =>
    stdout.split('\n').filter(line=>line.trim()).map(line=>{const m=line.match(/^\s*(\d+)\s+(\d+)\s+(.+\S)\s*$/);if(!m)throw new Error('INVALID_PROCESS_TREE');return {pid:Number(m[1]),parent:Number(m[2]),started:m[3]};}) };
}
const maxBuffer = 8*1024*1024;
function inventory(): ProcessIdentity[] {
  const q = query(), result = spawnSync(q.file, q.args, { windowsHide: true, encoding: 'utf8', timeout: q.timeout, maxBuffer });
  if (result.error || result.status !== 0) throw new Error('PROCESS_TREE_QUERY_FAILED');
  return q.parse(result.stdout);
}
/** Same query without blocking the main process; periodic observation uses this. */
function inventoryAsync(): Promise<ProcessIdentity[]> {
  const q = query();
  return new Promise((resolve, reject) => {
    execFile(q.file, q.args, { windowsHide: true, encoding: 'utf8', timeout: q.timeout, maxBuffer }, (error, stdout) => {
      if (error) { reject(new Error('PROCESS_TREE_QUERY_FAILED')); return; }
      try { resolve(q.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
  });
}
/** Main-process audit surface: identity metadata only, no command lines or environment. */
export function processInventory():ProcessIdentity[] {return inventory();}
export function captureOwnedTree(pid: number): ProcessIdentity[] {return ownedTreeFrom(inventory(),pid);}
export async function captureOwnedTreeAsync(pid: number): Promise<ProcessIdentity[]> {return ownedTreeFrom(await inventoryAsync(),pid);}
/** The tree rooted at `pid` within one inventory snapshot. */
export function ownedTreeFrom(all: ProcessIdentity[], pid: number): ProcessIdentity[] {
  const root=all.find(row=>row.pid===pid);
  if(!root)throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
  const owned=new Map([[pid,root]]);
  // Windows reuses PIDs and keeps a dead parent's PID in ParentProcessId, so an older unrelated process can name a
  // recycled PID as its parent. A process that started before its supposed parent cannot be its child. Unparseable
  // times keep the old, inclusive behaviour.
  const born=(row:ProcessIdentity)=>Date.parse(row.started);
  const childOf=(row:ProcessIdentity,parent:ProcessIdentity)=>!(born(row)<born(parent));
  for(let previous=-1;previous!==owned.size;){previous=owned.size;for(const row of all){const parent=owned.get(row.parent);if(parent&&!owned.has(row.pid)&&childOf(row,parent))owned.set(row.pid,row);}}
  return [...owned.values()];
}
export function ownedTreeGone(proof: ProcessIdentity[]): boolean {
  if(!proof.length)throw new Error('PROCESS_TREE_PROOF_REQUIRED');
  const current=new Map(inventory().map(row=>[row.pid,row.started]));
  return proof.every(row=>current.get(row.pid)!==row.started);
}
