import { tr } from '@shared/i18n';
import { BRAND_MARKS, type BrandMark } from './brandMarks';

/**
 * Which agent is behind a gremlin: the harness it runs in and the model's provider, by its official mark.
 * Providers without a mark in Simple Icons get a lettered badge in the same shape.
 */

interface Provider { key: string; name: string; mark: BrandMark | null; letters: string; color: string }

const LETTERED: Record<string, Omit<Provider, 'key' | 'mark'>> = {
  deepseek: { name: 'DeepSeek', letters: 'DS', color: '#4d6bfe' },
  moonshot: { name: 'Kimi', letters: 'K', color: '#15120f' },
  zhipu: { name: tr('智谱'), letters: tr('智'), color: '#3859ff' },
  openrouter: { name: 'OpenRouter', letters: 'OR', color: '#6467f2' },
  unknown: { name: tr('模型'), letters: '?', color: '#8a7c68' },
};

/** "openai/gpt-5.4-mini", "anthropic/claude-…", "deepseek-chat", "qwen3-coder" … → the provider. */
export function providerOf(model: string | null): Provider {
  const m = (model ?? '').toLowerCase();
  const pick = (key: string): Provider => {
    const mark = BRAND_MARKS[key] ?? null;
    if (mark) return { key, name: mark.name, mark, letters: '', color: mark.color };
    const l = LETTERED[key] ?? LETTERED.unknown;
    return { key, mark: null, ...l };
  };
  const vendor = m.includes('/') ? m.split('/')[0] : '';
  if (vendor === 'openai' || /^(gpt|o\d|codex)/.test(m.replace(/^.*\//, ''))) return pick('openai');
  if (vendor === 'anthropic' || m.includes('claude')) return pick('claude');
  if (vendor === 'google' || m.includes('gemini')) return pick('gemini');
  if (vendor === 'deepseek' || m.includes('deepseek')) return pick('deepseek');
  if (vendor === 'moonshot' || /kimi|moonshot/.test(m)) return pick('moonshot');
  if (vendor === 'zhipu' || vendor === 'zai' || /glm/.test(m)) return pick('zhipu');
  if (vendor === 'alibaba' || vendor === 'dashscope' || m.includes('qwen')) return pick('alibaba');
  if (vendor === 'xai' || m.includes('grok')) return pick('xai');
  if (vendor === 'mistral' || /mistral|codestral/.test(m)) return pick('mistral');
  if (vendor === 'meta' || m.includes('llama')) return pick('meta');
  if (vendor === 'ollama') return pick('ollama');
  if (vendor === 'openrouter') return pick('openrouter');
  return pick('unknown');
}

export function ProviderMark({ model, size = 16 }: { model: string | null; size?: number }) {
  const p = providerOf(model);
  return <span className="v8-mark" style={{ width: size, height: size, background: p.mark ? '#fff' : p.color }} title={p.name} aria-label={p.name}>
    {p.mark
      ? <svg viewBox={p.mark.viewBox} width={size * 0.66} height={size * 0.66} aria-hidden="true"><path d={p.mark.d} fill={p.color} /></svg>
      : <b style={{ fontSize: size * (p.letters.length > 1 ? 0.38 : 0.5) }}>{p.letters}</b>}
  </span>;
}

/** The detail-card block: harness and model, each with its badge. */
export function AgentBadge({ harness, model }: { harness: { kind: 'fake' | 'acp'; label: string }; model: string | null }) {
  const p = providerOf(model);
  return <div className="v8-agent">
    <div className="v8-agent-row">
      <span className="v8-mark v8-mark-harness" style={{ width: 34, height: 34 }} aria-hidden="true"><b>{harness.kind === 'acp' ? tr('本') : tr('演')}</b></span>
      <div><span className="v8-cap">{tr('外壳')}</span><b>{harness.label}</b></div>
    </div>
    <div className="v8-agent-row">
      <ProviderMark model={model} size={34} />
      <div><span className="v8-cap">{p.key === 'unknown' ? tr('模型') : tr('模型 · ') + p.name}</span><b className="v8-agent-model">{model ?? tr('默认模型')}</b></div>
    </div>
  </div>;
}
