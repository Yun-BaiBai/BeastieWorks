'use strict';
// After electron-vite builds out/, copy the few files the main process reads by path next to it.

const { copyFileSync, mkdirSync, statSync } = require('node:fs');
const { dirname, join } = require('node:path');

const ROOT = join(__dirname, '..');
const MAIN_ASSETS = [
  // The window and taskbar icon.
  ['build/icon.png', 'out/main/tray-icon.png'],
  // The official ACP agent list as of the build, used when the live list cannot be fetched.
  ['src/main/v8/acp-registry.json', 'out/main/acp-registry.json'],
  // The app's own tools, as an MCP server an agent starts (hostToolBridge.ts).
  ['src/main/v8/host-tool-relay.cjs', 'out/main/host-tool-relay.cjs'],
];

for (const [fromRel, toRel] of MAIN_ASSETS) {
  const from = join(ROOT, fromRel);
  const to = join(ROOT, toRel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  const copied = statSync(to);
  if (!copied.isFile() || copied.size === 0) throw new Error(`Failed to copy main asset: ${fromRel} -> ${toRel}`);
}
console.log(`[copy-main-assets] ${MAIN_ASSETS.length} files`);
