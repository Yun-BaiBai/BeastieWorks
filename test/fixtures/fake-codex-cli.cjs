'use strict';
// A stand-in for the codex program's sign-in commands. FAKE_CODEX_HOME holds a "signed-in" file once signed in.
//   login status          -> "Logged in using ChatGPT" (exit 0) or "Not logged in" (exit 1)
//   login --device-auth   -> prints OpenAI's device page and a code like the real one, then signs in after a moment
//                            (FAKE_CODEX_REFUSE=1: says device sign-in is not enabled and fails)
const fs = require('node:fs'), path = require('node:path');
const home = process.env.FAKE_CODEX_HOME;
const flag = path.join(home, 'signed-in');
const args = process.argv.slice(2).join(' ');
if (args === 'login status') {
  if (fs.existsSync(flag)) { console.log('Logged in using ChatGPT'); process.exit(0); }
  console.log('Not logged in'); process.exit(1);
}
if (args === 'login --device-auth') {
  if (process.env.FAKE_CODEX_REFUSE) { console.error('Error: device code login is not enabled for this workspace'); process.exit(1); }
  process.stdout.write('\u001b[1mWelcome to Codex\u001b[0m\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   ABCD-12345\n\n');
  setTimeout(() => { fs.writeFileSync(flag, 'yes'); console.log('Successfully logged in'); process.exit(0); }, 600);
  return;
}
process.exit(2);
