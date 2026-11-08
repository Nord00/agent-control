// Anthropic first-party API list prices, USD per million tokens. Update when prices change:
// https://platform.claude.com/docs/en/about-claude/pricing
// Cache writes are derived from input: 1.25x for the 5-minute TTL, 2x for the 1-hour TTL.
// Costs are estimates: subscription plans, Bedrock and Vertex aren't billed at these rates.
const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  // Prompts over 100K tokens cost 5x on Haiku 5.5. Its cache read rate assumes the usual 0.1x.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, longPromptFactor: 5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
}
const CONTEXT_WINDOW = { 'claude-haiku-4-5': 200_000 }
const DEFAULT_CONTEXT_WINDOW = 1_000_000
const FAST_FACTOR = 2

// "claude-opus-5-5-20260401[1m]" -> "claude-opus-5-5"; an unknown model stays unpriced.
const baseModel = (model) => model.replace(/(-\d{8})?(\[.*\])?$/, '')

export const contextWindow = (model) => CONTEXT_WINDOW[baseModel(model)] ?? DEFAULT_CONTEXT_WINDOW

/** @param {Record<string, {input:number,output:number,cacheRead:number,cache5m:number,cache1h:number}>} byModel */
export function estimateCost(byModel) {
  let cost = 0
  let priced = false
  let partial = false
  for (const [key, t] of Object.entries(byModel)) {
    const [model, ...flags] = key.split(':')
    const p = PRICES[baseModel(model)]
    if (!p) {
      if (t.input + t.output + t.cacheRead + t.cache5m + t.cache1h > 0) partial = true
      continue
    }
    priced = true
    const factor = (flags.includes('fast') ? FAST_FACTOR : 1) * (flags.includes('long') ? (p.longPromptFactor ?? 1) : 1)
    cost +=
      (factor *
        (t.input * p.input +
          t.output * p.output +
          t.cacheRead * p.cacheRead +
          t.cache5m * p.input * 1.25 +
          t.cache1h * p.input * 2)) /
      1e6
  }
  return { cost: priced ? cost : null, costPartial: partial }
}
