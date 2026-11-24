// Standard API list prices, USD per million tokens. Update when prices change:
// https://platform.claude.com/docs/en/about-claude/pricing
// https://developers.openai.com/api/docs/pricing (Codex models)
// Cache writes are derived from input: 1.25x for the 5-minute TTL (OpenAI: 30-minute), 2x for
// the 1-hour TTL. `long` multiplies input-side and output prices for long prompts.
// Costs are estimates: subscription plans (Claude, ChatGPT), Bedrock, Vertex and Fast mode
// on Codex aren't billed at these rates.
const OPENAI_LONG = { input: 2, output: 1.5 } // over 272K input tokens
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
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, long: { input: 5, output: 5 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  // OpenAI (as of November 2026; GPT-5.6 Sol's promotional rate ends November 30, 2026)
  'gpt-6.2-astra': { input: 8, output: 40, cacheRead: 0.4, long: OPENAI_LONG },
  'gpt-6.2-sol': { input: 2, output: 10, cacheRead: 0.1, long: OPENAI_LONG },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, long: OPENAI_LONG },
  'gpt-6.1-terra': { input: 1, output: 5, cacheRead: 0.05, long: OPENAI_LONG },
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1, long: OPENAI_LONG },
  'gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2, long: OPENAI_LONG },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, long: OPENAI_LONG },
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, long: OPENAI_LONG },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, long: OPENAI_LONG },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, long: OPENAI_LONG },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, long: OPENAI_LONG },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, long: OPENAI_LONG },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175 },
  'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
}
const CONTEXT_WINDOW = { 'claude-haiku-4-5': 200_000 }
const DEFAULT_CONTEXT_WINDOW = 1_000_000
const FAST_FACTOR = 2

// "claude-opus-5-5-20260401[1m]" -> "claude-opus-5-5", "gpt-5-2025-08-07" -> "gpt-5";
// an unknown model stays unpriced.
const baseModel = (model) => model.replace(/(-\d{8}|-\d{4}-\d{2}-\d{2})?(\[.*\])?$/, '')

// Unknown for non-Claude models, so no context meter rather than a wrong one.
export const contextWindow = (model) => {
  const m = baseModel(model)
  return CONTEXT_WINDOW[m] ?? (m.startsWith('claude-') ? DEFAULT_CONTEXT_WINDOW : undefined)
}

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
    const fast = flags.includes('fast') ? FAST_FACTOR : 1
    const long = flags.includes('long') ? p.long : undefined
    cost +=
      (fast * (long?.input ?? 1) * (t.input * p.input + t.cacheRead * p.cacheRead + t.cache5m * p.input * 1.25 + t.cache1h * p.input * 2) +
        fast * (long?.output ?? 1) * t.output * p.output) /
      1e6
  }
  return { cost: priced ? cost : null, costPartial: partial }
}
