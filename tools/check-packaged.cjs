'use strict';
// After packaging: start the packaged program as Node and load everything that runs outside the source tree, so a
// module the packager left out fails here and not on the person's computer (老板 2026-11-28: 1.0.0–1.0.2 shipped
// without npm's own modules and without zod, so no agent could be installed or talked to).
// Usage: node tools/check-packaged.cjs [folder of the packaged program, default dist/win-unpacked]
const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os'), path = require('node:path');

const dir = path.resolve(process.argv.slice(2).find(a => existsSync(path.join(a, 'Beastie Works.exe'))) || path.join(__dirname, '..', 'dist', 'win-unpacked'));
const exe = path.join(dir, 'Beastie Works.exe'), res = path.join(dir, 'resources'), asar = path.join(res, 'app.asar');
const unpacked = path.join(res, 'app.asar.unpacked', 'node_modules');
if (!existsSync(exe)) { console.error('[check-packaged] no program at ' + exe); process.exit(1); }
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const run = (args, cwd) => spawnSync(exe, args, { env, cwd, encoding: 'utf8', timeout: 120000 });
const js = code => run(['-e', code]);
const q = JSON.stringify;
const npmCli = [path.join(res, 'npm', 'bin', 'npm-cli.js'), path.join(unpacked, 'npm', 'bin', 'npm-cli.js')].find(existsSync);

const checks = [
  ['npm starts', () => npmCli ? run([npmCli, '--version']) : { status: 1, stderr: 'npm-cli.js missing' }],
  ['npm installs a package from the computer', () => {
    // A package made on the spot, so nothing is downloaded.
    const t = mkdtempSync(path.join(os.tmpdir(), 'bw-pack-'));
    try {
      require('node:fs').mkdirSync(path.join(t, 'p')); require('node:fs').writeFileSync(path.join(t, 'p', 'package.json'), '{"name":"p","version":"1.0.0"}');
      require('node:fs').mkdirSync(path.join(t, 'd'));
      const r = run([npmCli, 'install', '--prefix', path.join(t, 'd'), '--no-audit', '--no-fund', '--offline', path.join(t, 'p')], t);
      if (r.status === 0 && !existsSync(path.join(t, 'd', 'node_modules', 'p', 'package.json'))) return { status: 1, stderr: 'installed nothing' };
      return r;
    } finally { rmSync(t, { recursive: true, force: true }); }
  }],
  ['the agent protocol library loads', () => js(`const p=require(${q(path.join(asar, 'node_modules', '@agentclientprotocol', 'sdk', 'package.json'))});const e=p.exports['.'];const f=typeof e==='string'?e:(e.import&&(e.import.default||e.import))||e.default;import(require('url').pathToFileURL(require('path').join(${q(path.join(asar, 'node_modules', '@agentclientprotocol', 'sdk'))},f)).href).then(m=>{if(typeof m.client!=='function'||typeof m.ndJsonStream!=='function'){console.error('client or ndJsonStream missing');process.exit(2)}},e=>{console.error(e);process.exit(1)})`)],
  ['the database loads', () => js(`const D=require(${q(path.join(asar, 'node_modules', 'better-sqlite3'))});new D(':memory:').prepare('select 1').get()`)],
  ['the speech engine loads', () => js(`require(${q(path.join(unpacked, 'koffi'))});require(${q(path.join(unpacked, 'transcribe-cpp'))})`)],
  // Every package the program needs, and every package those need (peer packages too, unless optional), is there.
  ['every package the program needs is packed', () => js(`const fs=require('fs'),path=require('path'),nm=${q(path.join(asar, 'node_modules'))},un=${q(unpacked)};const seen=new Set(),miss=[];const has=n=>fs.existsSync(path.join(nm,n,'package.json'))||fs.existsSync(path.join(un,n,'package.json'));const walk=(n,from)=>{if(seen.has(n))return;seen.add(n);if(!has(n)){miss.push(n+' (for '+from+')');return}const p=JSON.parse(fs.readFileSync(fs.existsSync(path.join(nm,n,'package.json'))?path.join(nm,n,'package.json'):path.join(un,n,'package.json'),'utf8'));const opt=p.peerDependenciesMeta||{};for(const k of Object.keys(p.dependencies||{}))walk(k,n);for(const k of Object.keys(p.peerDependencies||{}))if(!(opt[k]&&opt[k].optional))walk(k,n)};const top=JSON.parse(fs.readFileSync(${q(path.join(asar, 'package.json'))},'utf8'));for(const k of Object.keys(top.dependencies))walk(k,'the program');if(miss.length){console.error('missing: '+miss.join(', '));process.exit(1)}`)],
];
let bad = 0;
for (const [name, fn] of checks) {
  const r = fn();
  const ok = r.status === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : '\n     ' + String(r.stderr || r.stdout || r.error || '').trim().split('\n').slice(-6).join('\n     ')}`);
}
if (bad) { console.error(`[check-packaged] ${bad} failed`); process.exit(1); }
console.log('[check-packaged] all passed');
