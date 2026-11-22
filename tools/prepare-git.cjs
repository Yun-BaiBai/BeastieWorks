'use strict';
// Before packaging: unpack the Git the app ships (老板 2026-11-20: friends' computers mostly have no git, and every
// ticket's copy, diff and accept runs on git) into build/git/, not kept in git. It is MinGit, the build Git for
// Windows makes for other programs to carry, checked against its published sha256. The app puts it on PATH only
// when the computer has no git of its own (src/main/index.ts).
// The archive comes from BEASTIE_MINGIT_ZIP (MinGit-2.56.1-64-bit.zip from git-for-windows/git v2.56.1.windows.1).

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const NAME = 'MinGit-2.56.1-64-bit.zip';
const SHA256 = '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd';

const zip = process.env.BEASTIE_MINGIT_ZIP;
if (!zip || !existsSync(zip)) {
  console.error(`[prepare-git] set BEASTIE_MINGIT_ZIP to ${NAME}`);
  process.exit(1);
}
const sum = createHash('sha256').update(readFileSync(zip)).digest('hex');
if (sum !== SHA256) {
  console.error(`[prepare-git] ${zip} is not the published ${NAME} (sha256 ${sum})`);
  process.exit(1);
}
const dir = join(__dirname, '..', 'build', 'git');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
// Windows' own tar (bsdtar, System32) reads zip files; named by its full path so a GNU tar earlier on PATH (Git's, on
// GitHub's runners) is not used. electron-builder 26 no longer brings 7zip-bin along.
const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
execFileSync(tar, ['-xf', zip, '-C', dir], { stdio: 'ignore' });
if (!existsSync(join(dir, 'cmd', 'git.exe'))) {
  console.error('[prepare-git] cmd/git.exe missing after unpacking');
  process.exit(1);
}
console.log(`[prepare-git] ${NAME} ready (sha256 ok)`);
