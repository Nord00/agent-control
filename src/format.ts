import type { Agent, Tokens } from './sim'

export const totalTokens = (t?: Tokens) => (t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0)

// Excludes cache reads, which re-count the same context on every API call.
export const newTokens = (t?: Tokens) => (t ? t.input + t.output + t.cacheWrite : 0)

export const TOKENS_NOTE = 'New = input + output + cache writes. Total also counts cache reads, which re-read the same context on every API call.'

export const RETIRE_MS = 5 * 60 * 1000 // how long an ended session stays on the stage
const INACTIVE_MS = 24 * 60 * 60 * 1000 // sessions can vanish without a SessionEnd event

export function rootOf(a: Agent, byId: Map<string, Agent>) {
  let cur = a
  for (let i = 0; i < 16 && cur.parentId; i++) {
    const p = byId.get(cur.parentId)
    if (!p) break
    cur = p
  }
  return cur
}

// When a session left the stage, or will: only meaningful for root agents.
export const retiresAt = (root: Agent) =>
  root.ended ? (root.endedAt ?? 0) + RETIRE_MS : (root.lastEventAt ?? root.startedAt) + INACTIVE_MS

export const isRetired = (root: Agent, now: number) => now >= retiresAt(root)

// When the session actually finished or went quiet, for ordering and clearing.
export const retiredAt = (root: Agent) => (root.ended ? (root.endedAt ?? 0) : (root.lastEventAt ?? root.startedAt))

export function fmtAgo(ms: number) {
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function fmtTokens(n: number) {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`
}

export function fmtCost(cost: number | null | undefined, partial?: boolean) {
  if (cost === null || cost === undefined) return '—'
  const s = cost > 0 && cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`
  return partial ? `≥ ${s}` : s
}

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// "claude-opus-5-5-20260401" -> "Opus 5.5". Anything unrecognized is shown as is.
export function modelName(id?: string) {
  if (!id) return '—'
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(id)
  if (!m) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

export interface Rollup {
  tokens: Tokens
  cost: number | null
  costPartial: boolean
}

// Sums usage over the given agents.
export function sumUsage(agents: Agent[]): Rollup {
  const tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let cost: number | null = null
  let costPartial = false
  for (const a of agents) {
    if (a.tokens) {
      tokens.input += a.tokens.input
      tokens.output += a.tokens.output
      tokens.cacheRead += a.tokens.cacheRead
      tokens.cacheWrite += a.tokens.cacheWrite
    }
    if (typeof a.cost === 'number') cost = (cost ?? 0) + a.cost
    if (a.costPartial || (a.tokens && totalTokens(a.tokens) > 0 && typeof a.cost !== 'number')) costPartial = true
  }
  return { tokens, cost, costPartial }
}

// An agent plus everything spawned under it.
export function withDescendants(agent: Agent, agents: Agent[]): Agent[] {
  const out = [agent]
  for (let i = 0; i < out.length; i++) out.push(...agents.filter((a) => a.parentId === out[i].id))
  return out
}
