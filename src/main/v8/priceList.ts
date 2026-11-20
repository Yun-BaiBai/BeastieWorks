import snapshotData from './prices/litellm-snapshot.json';
import fallbackData from './prices/pricing-fallback.json';

/**
 * What a turn cost, when the agent does not say it in dollars itself.
 *
 * The way CodeBurn does it (github.com/getagentseal/codeburn, MIT, Copyright (c) 2026 AgentSeal; `src/models.ts`):
 * a compact price table ships inside the program, so nothing is downloaded. The two files in `prices/` are CodeBurn's
 * own (commit 40d5880, 2026-11-09): `litellm-snapshot.json` is LiteLLM's public list cut down to the prices, plus
 * hand-checked rows; `pricing-fallback.json` fills in models LiteLLM does not have yet, used only when nothing
 * else matches. Each row is [input, output, cacheWrite, cacheRead, fast, longContextTier, flex, ultrafast], USD per
 * token. A model in neither table is not priced: its cost stays "unknown" rather than a guess.
 */

type Tier = { threshold: number; input: number; output: number; cacheWrite: number | null; cacheRead: number | null };
type Row = [number, number, number | null, number | null, number | null, Tier | null, ...unknown[]];

/**
 * Tokens of one turn as ACP agents report them (`usage` on the end of a prompt). `input` does not include the
 * cached tokens: Codex reported totalTokens 26257 = inputTokens 14604 + cachedReadTokens 11648 + outputTokens 5.
 */
export interface TurnTokens { input: number; cachedRead: number; cacheWrite: number; output: number }

const lower = (table: Record<string, unknown>) => new Map(Object.entries(table).map(([k, v]) => [k.toLowerCase(), v as Row]));
const SNAPSHOT = lower(snapshotData as Record<string, unknown>);
const FALLBACK = lower(fallbackData as Record<string, unknown>);

/** The price row for a model name as agents write it: any case, with or without a maker prefix or a [1m] suffix. */
export function priceRow(model: string): Row | null {
  const key = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  if (!key) return null;
  const bare = key.slice(key.lastIndexOf('/') + 1);
  for (const table of [SNAPSHOT, FALLBACK]) {
    const row = table.get(key) ?? table.get(bare);
    if (row && typeof row[0] === 'number' && typeof row[1] === 'number') return row;
  }
  return null;
}

/** USD for one turn at list prices. CodeBurn's rules: a missing cache price is input × 1.25 (write) or × 0.1
 *  (read); past the long-context threshold the whole turn is billed at the higher tier. */
export function priceTurn(model: string, t: TurnTokens): number | null {
  const row = priceRow(model);
  if (!row) return null;
  let [input, output, cacheWrite, cacheRead] = row;
  const tier = row[5];
  if (tier && t.input + t.cachedRead + t.cacheWrite > tier.threshold) {
    input = tier.input; output = tier.output;
    if (tier.cacheWrite !== null) cacheWrite = tier.cacheWrite;
    if (tier.cacheRead !== null) cacheRead = tier.cacheRead;
  }
  return t.input * input + t.output * output + t.cacheWrite * (cacheWrite ?? input * 1.25) + t.cachedRead * (cacheRead ?? input * 0.1);
}

/** Kept as a class so a later version can refresh the table; today the table is the one shipped with the app. */
export class PriceList {
  load(): Promise<void> { return Promise.resolve(); }
  price(model: string | null, t: TurnTokens): number | null { return model ? priceTurn(model, t) : null; }
}
