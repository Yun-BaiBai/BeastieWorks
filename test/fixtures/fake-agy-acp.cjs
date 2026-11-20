'use strict';
// A stand-in for Antigravity's agy_acp_server sign-in: answers initialize, and on authenticate prints its sign-in link
// on stdout like the real one, then "finishes" the Google sign-in after a moment by writing its token file.
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const dir = path.join(process.env.GEMINI_HOME, 'antigravity-acp');
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] } });
  if (m.method === 'authenticate') {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'seen.json'), JSON.stringify({ method: m.params.methodId, auth: settings.auth, fileStorage: process.env.AGY_ACP_FORCE_FILE_STORAGE }));
    process.stdout.write('Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=abc\n');
    setTimeout(() => { fs.writeFileSync(path.join(dir, 'acp_token.json'), '{}'); send({ id: m.id, result: {} }); }, 400);
  }
});
