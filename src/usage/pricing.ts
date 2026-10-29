// API-equivalent prices, to compare what sessions use. On a subscription plan nothing is charged per
// token; tokens and the plan's limits are what count (step 5, decision 1).
//
// Per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing (checked
// 2026-10-13). Cache writes cost 1.25 times input (5-minute cache); cache reads 0.1 times input unless
// the page names a price. Unknown models get no cost rather than a guess. The cost is worked out once,
// when a call is recorded: a price change here leaves the costs already stored as they were. Update when
// models or prices change.
interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  /** Higher prices for a call whose prompt (input, cache reads and cache writes) is over `above` tokens. */
  longPrompt?: { above: number; price: Price };
}

// Longest prefix first, so "claude-opus-5-5" wins over "claude-opus-5".
const PRICES: [prefix: string, price: Price][] = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-mythos-5', { input: 10, output: 50 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  // Opus 4.1 and Opus 4 (claude-opus-4-2025…) cost more than Opus 4.5 and later.
  ['claude-opus-4-1', { input: 15, output: 75 }],
  ['claude-opus-4-2', { input: 15, output: 75 }],
  ['claude-opus-4', { input: 5, output: 25 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.1 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet-4', { input: 3, output: 15 }],
  // The only model on the page priced by prompt length; every other one has one price up to 1M.
  ['claude-haiku-5-5', { input: 0.1, output: 0.5, longPrompt: { above: 100_000, price: { input: 0.5, output: 2.5 } } }],
  ['claude-haiku-4-5', { input: 1, output: 5 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4 }],
];

function priceFor(model: string): Price | null {
  const m = model.toLowerCase();
  return PRICES.find(([prefix]) => m.startsWith(prefix))?.[1] ?? null;
}

/** The API-equivalent cost of one model call in dollars, or null for an unknown model. */
export function callCost(model: string, t: { input: number; output: number; cacheWrite: number; cacheRead: number }): number | null {
  let p = priceFor(model);
  if (!p) return null;
  // Each call on its own, by its whole prompt, cache hits included (the page's long context pricing).
  if (p.longPrompt && t.input + t.cacheWrite + t.cacheRead > p.longPrompt.above) p = p.longPrompt.price;
  const perToken = 1 / 1_000_000;
  return (
    t.input * p.input * perToken +
    t.output * p.output * perToken +
    t.cacheWrite * p.input * 1.25 * perToken +
    t.cacheRead * (p.cacheRead ?? p.input * 0.1) * perToken
  );
}
