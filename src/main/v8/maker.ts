import { viaMagpie } from './magpieService';

/**
 * Which company's model does the work (requirements 32, 33: review counts only from another company). An agent's own
 * models are its maker's; a Magpie model (`magpie:<provider>/<model>`) is its provider's. Null: not known, and the
 * caller compares the agents instead.
 */
const AGENT_MAKER: Record<string, string> = {
  'codex-acp': 'openai', 'claude-acp': 'anthropic', 'antigravity-acp': 'google', gemini: 'google',
  dsh: 'deepseek', 'kimi-code': 'moonshot', 'grok-build': 'xai', 'qwen-code': 'alibaba',
};
const PROVIDER_MAKER: Record<string, string> = {
  claude: 'anthropic', anthropic: 'anthropic', codex: 'openai', openai: 'openai', chatgpt: 'openai',
  gemini: 'google', google: 'google', antigravity: 'google', deepseek: 'deepseek', kimi: 'moonshot', moonshot: 'moonshot',
  grok: 'xai', xai: 'xai', qwen: 'alibaba',
};

export function makerOf(agent: string, model: string | null): string | null {
  const m = viaMagpie(model);
  if (m) { const p = (m.split('/')[0] ?? '').toLowerCase(); return PROVIDER_MAKER[p] ?? (p || null); }
  return AGENT_MAKER[agent] ?? null;
}
