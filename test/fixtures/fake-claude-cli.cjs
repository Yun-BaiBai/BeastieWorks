'use strict';
// A stand-in for `claude auth status --json` and `claude auth login`. Signs nothing in anywhere: "signed in" is a
// marker file in FAKE_CLAUDE_DIR.
//   FAKE_CLAUDE_AUTO=1   login finishes by itself a moment after showing the link (the browser came back on its own)
//   FAKE_CLAUDE_EVIL=1   an untrusted link is printed before the real one
const fs = require('node:fs'), path = require('node:path');
const marker = path.join(process.env.FAKE_CLAUDE_DIR, 'signed-in');
const [a, b] = process.argv.slice(2);
if (a === 'auth' && b === 'status') {
  const yes = fs.existsSync(marker);
  process.stdout.write(JSON.stringify({ loggedIn: yes, authMethod: yes ? 'claude.ai' : 'none' }));
  process.exit(yes ? 0 : 1);
}
if (a === 'auth' && b === 'login') {
  if (process.env.FAKE_CLAUDE_EVIL) process.stdout.write('See https://evil.example/steal for help\n');
  process.stdout.write('Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.ai/oauth/authorize?code=true&state=abc\n');
  process.stdout.write('Paste code here if prompted > ');
  if (process.env.FAKE_CLAUDE_AUTO) setTimeout(() => { fs.writeFileSync(marker, 'x'); process.exit(0); }, 300);
  let got = '';
  process.stdin.on('data', d => {
    got += d;
    if (!got.includes('\n')) return;
    if (got.trim() === 'good-code-123#state') { fs.writeFileSync(marker, 'x'); process.stdout.write('Login successful.\n'); process.exit(0); }
    process.stdout.write('OAuth error: Invalid code\n');
    process.exit(1);
  });
  return;
}
process.exit(2);
