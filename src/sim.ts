export type Status = 'working' | 'waiting' | 'completed'

import { placeChild, placeRoot } from './layout'

export interface Tokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// Reported by the server when known; live sessions fill these in as they run.
export interface Metrics {
  model?: string
  effort?: string
  branch?: string
  requests?: number
  contextTokens?: number
  contextWindow?: number
  tokens?: Tokens
  cost?: number | null
  costPartial?: boolean
  toolCalls?: number
  prompts?: number
  lastEventAt?: number
  attention?: boolean // blocked on a tool approval
}

const METRIC_KEYS = [
  'model', 'effort', 'branch', 'requests', 'contextTokens', 'contextWindow',
  'tokens', 'cost', 'costPartial', 'toolCalls', 'prompts', 'lastEventAt', 'attention',
] as const

const metricsOf = (ev: Metrics) => {
  const m: Metrics = {}
  for (const k of METRIC_KEYS) (m as Record<string, unknown>)[k] = ev[k]
  return m
}

export interface Agent extends Metrics {
  id: string
  parentId: string | null
  depth: number
  name: string
  task: string
  status: Status
  x: number
  y: number
  r: number
  seed: number
  startedAt: number
  endedAt?: number
  ended?: boolean // live mode: the whole session is over (vs. a completed turn)
  fresh: boolean // spawned after load -> plays the spawn animation
}

export const STATUS_LABEL: Record<Status, string> = {
  working: 'Working',
  waiting: 'Waiting for input',
  completed: 'Completed',
}

const SUBS: [string, string][] = [
  ['search-codebase', 'Searching the repo for call sites'],
  ['read-config', 'Reading build and lint configuration'],
  ['run-tests', 'Running the unit test suite'],
  ['type-check', 'Type-checking changed modules'],
  ['draft-patch', 'Drafting a patch for review'],
  ['review-diff', 'Reviewing the working tree diff'],
  ['fetch-docs', 'Fetching API documentation'],
  ['migrate-schema', 'Preparing a schema migration'],
  ['lint', 'Linting and formatting changes'],
  ['trace-bug', 'Tracing a failing code path'],
]

let counter = 0
const rand = (n: number) => Math.random() * n
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]

// Made-up usage so demo mode shows the full UI.
function demoMetrics(model: string, scale: number): Metrics {
  const tokens = {
    input: Math.round(2000 * scale),
    output: Math.round(38000 * scale),
    cacheRead: Math.round(900000 * scale),
    cacheWrite: Math.round(60000 * scale),
  }
  const m = /sonnet/.test(model) ? 0.5 : /haiku/.test(model) ? 0.05 : 1
  return {
    model,
    effort: 'high',
    branch: 'main',
    requests: Math.round(24 * scale) + 1,
    contextTokens: Math.round(180000 * Math.sqrt(scale)),
    contextWindow: 1000000,
    tokens,
    cost: (m * (tokens.input * 4 + tokens.output * 20 + tokens.cacheRead * 0.2 + tokens.cacheWrite * 8)) / 1e6,
    toolCalls: Math.round(40 * scale),
    prompts: Math.max(1, Math.round(3 * scale)),
  }
}

function makeChild(list: Agent[], parent: Agent, status: Status, fresh: boolean): Agent {
  const depth = parent.depth + 1
  const r = depth === 1 ? 44 : 30
  const [name, task] = pick(SUBS)
  const now = Date.now()
  return {
    id: `a${++counter}`,
    parentId: parent.id,
    depth,
    name,
    task,
    status,
    ...placeChild(list, parent, r, name),
    r,
    seed: Math.floor(rand(1e9)),
    startedAt: now,
    endedAt: status === 'completed' ? now : undefined,
    fresh,
    ...demoMetrics('claude-haiku-5-5', 0.05 + rand(0.2)),
  }
}

// --- Live mode: events from the server ---
export interface AgentEvent extends Metrics {
  id: string
  parentId?: string | null
  name?: string
  task?: string
  status: Status
  startedAt: number
  endedAt?: number
  ended?: boolean
}

// Insert or update an agent; positions are only chosen once, on first sight.
export function applyEvent(list: Agent[], ev: AgentEvent, fresh: boolean): Agent[] {
  const patch = {
    status: ev.status,
    startedAt: ev.startedAt,
    endedAt: ev.endedAt,
    ended: ev.ended,
    ...metricsOf(ev),
  }
  const i = list.findIndex((a) => a.id === ev.id)
  if (i >= 0) {
    const next = [...list]
    next[i] = { ...list[i], ...patch, name: ev.name ?? list[i].name, task: ev.task ?? list[i].task }
    return next
  }
  const parent = ev.parentId ? list.find((a) => a.id === ev.parentId) : undefined
  const depth = parent ? parent.depth + 1 : 0
  const r = depth === 0 ? 110 : depth === 1 ? 44 : 30
  return [
    ...list,
    {
      id: ev.id,
      parentId: ev.parentId ?? null,
      depth,
      name: ev.name ?? ev.id,
      task: ev.task ?? '',
      ...patch,
      ...(parent ? placeChild(list, parent, r, ev.name ?? ev.id) : placeRoot(list, r, ev.name ?? ev.id)),
      r,
      seed: Math.floor(rand(1e9)),
      fresh,
    },
  ]
}

export function initialAgents(): Agent[] {
  const now = Date.now()
  const root = (
    name: string,
    task: string,
    status: Status,
    x: number,
    y: number,
    r: number,
    ago: number,
    model: string,
    scale: number,
  ): Agent => ({
    ...demoMetrics(model, scale),
    id: `a${++counter}`,
    parentId: null,
    depth: 0,
    name,
    task,
    status,
    x,
    y,
    r,
    seed: Math.floor(rand(1e9)),
    startedAt: now - ago,
    endedAt: status === 'completed' ? now - ago / 3 : undefined,
    fresh: false,
  })

  let list: Agent[] = [
    root('refactor-auth', 'Refactoring auth middleware to use session tokens', 'working', -520, -150, 110, 260000, 'claude-opus-5-5', 1.4),
    root('write-tests', 'Adding integration tests for the billing API', 'waiting', 480, -210, 110, 540000, 'claude-sonnet-5-5', 0.8),
    root('docs-sync', 'Syncing README with current CLI flags', 'completed', 40, 370, 110, 900000, 'claude-haiku-5-5', 0.3),
  ]
  const kid = (parentIdx: number, status: Status) => {
    const k = makeChild(list, list[parentIdx], status, false)
    k.startedAt = now - 30000 - rand(120000)
    if (status === 'completed') k.endedAt = k.startedAt + 20000
    list = [...list, k]
  }
  kid(0, 'completed')
  kid(0, 'working')
  kid(1, 'waiting')
  kid(2, 'completed')
  kid(2, 'completed')
  return list
}

// One simulated event per tick.
export function step(list: Agent[]): Agent[] {
  const now = Date.now()
  const working = list.filter((a) => a.status === 'working')
  const waiting = list.filter((a) => a.status === 'waiting')
  const update = (id: string, patch: Partial<Agent>) =>
    list.map((a) => (a.id === id ? { ...a, ...patch } : a))
  const kids = (id: string) => list.filter((a) => a.parentId === id)

  if (!working.length && !waiting.length) {
    const r = pick(list.filter((a) => a.depth === 0))
    return update(r.id, { status: 'working', startedAt: now, endedAt: undefined })
  }

  const roll = Math.random()
  const spawnable = working.filter((a) => a.depth < 2)
  if (roll < 0.38 && spawnable.length && list.length < 30) {
    const parent = pick(spawnable)
    return [...list, makeChild(list, parent, 'working', true)]
  }
  if (roll < 0.62) {
    const done = working.filter((a) => {
      const k = kids(a.id)
      if (k.some((c) => c.status !== 'completed')) return false
      return a.depth > 0 || k.length >= 2
    })
    if (done.length) return update(pick(done).id, { status: 'completed', endedAt: now })
  }
  if (roll < 0.8 && working.length) {
    return update(pick(working).id, { status: 'waiting' })
  }
  if (waiting.length) return update(pick(waiting).id, { status: 'working' })
  return list
}
