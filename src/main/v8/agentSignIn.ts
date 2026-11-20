import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Whether each agent is signed in, asked the way the agent itself answers. The app never reads or stores a sign-in;
 * signing in is always done by the person, in the agent.
 *
 * Ported from OpenMausBot (Apache-2.0): `server/drivers/claude-auth-status.ts`, `codex-login.ts` and the key check in
 * `server/drivers/acp/deepseek.ts`. Their rule is kept: only an explicit "not signed in" counts as signed out; a
 * check that timed out or said nothing readable is "unknown".
 */

export type SignIn = 'yes' | 'no' | 'unknown';

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ failed: boolean; killed: boolean; said: string }> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 8000, maxBuffer: 65_536, env, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ failed: !!error, killed: (error as { killed?: boolean } | null)?.killed === true, said: `${stdout}\n${stderr ?? ''}` });
    });
  });
}

/** `claude auth status --json`: credential storage differs by platform, so the CLI's own answer is the only test. */
export async function claudeSignIn(cli: string, env: NodeJS.ProcessEnv): Promise<SignIn> {
  const r = await run(cli, ['auth', 'status', '--json'], env);
  if (r.killed) return 'unknown';
  try {
    const status: unknown = JSON.parse(r.said.slice(r.said.indexOf('{'), r.said.lastIndexOf('}') + 1));
    const loggedIn = status && typeof status === 'object' && 'loggedIn' in status ? (status as { loggedIn: unknown }).loggedIn : undefined;
    return loggedIn === true ? 'yes' : loggedIn === false ? 'no' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** `codex login status` says "Logged in using …" / "API key configured - …", "Not logged in", or an error line. */
export async function codexSignIn(cli: string | { command: string; args: string[] }, env: NodeJS.ProcessEnv): Promise<SignIn> {
  const c = typeof cli === 'string' ? { command: cli, args: [] } : cli;
  const r = await run(c.command, [...c.args, 'login', 'status'], env);
  if (!r.failed && /^(?:logged in|api key configured)\b/im.test(r.said)) return 'yes';
  return r.failed && /^(?:not logged in|error checking login status)\b/im.test(r.said) ? 'no' : 'unknown';
}

/**
 * DeepSeek Harness has no sign-in step: it reads a key from the environment or from its own files. A key found is
 * "yes". No key is "unknown", not "no": the desktop app can also be signed in with an account, which leaves no key.
 */
export function dshSignIn(env: NodeJS.ProcessEnv): SignIn {
  if (env.DEEPSEEK_API_KEY?.trim()) return 'yes';
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  for (const file of ['.credentials.yaml', '.env']) {
    try {
      const text = readFileSync(join(home, file), 'utf8');
      if (/^[ \t]*(?:export[ \t]+)?DEEPSEEK_API_KEY[ \t]*[:=][ \t]*["']?[^"'\s#]/m.test(text)) return 'yes';
    } catch { /* no such file */ }
  }
  return 'unknown';
}
