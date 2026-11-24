// Maps Claude Code and Codex hook payloads to Agent Control agent events. Both send the
// same core fields and event names; `app` (set by the hook script) says which one it was.
//   session_id            -> root agent (id = session_id)
//   agent_id (subagents)  -> child agent, parent = session_id (the only documented parent link)
//   Stop                  -> turn completed (session still alive)
//   SessionEnd            -> session ended (completed + ended)
// Codex only:
//   PostModelRequest      -> one request's token counts, added to the agent's totals
//   Interrupt             -> turn stopped by the user
import { contextWindow, estimateCost } from './pricing.js'

const str = (v, n = 80) => (typeof v === 'string' && v ? v.slice(0, n) : undefined)
const base = (p) => str(p, 300)?.split(/[\\/]/).filter(Boolean).pop()
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export const TURN_COMPLETE = 'Turn complete, waiting for next prompt'
const OPENAI_LONG_CONTEXT = 272_000 // OpenAI's long-context prices apply above this many input tokens
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0 })

// Turns a hook's usage report into agent fields; the server owns pricing.
function usageFields(u) {
  if (!u || typeof u !== 'object') return {}
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const byModel = {}
  for (const [key, t] of Object.entries(u.byModel ?? {}).slice(0, 40)) {
    const row = {
      input: count(t?.input),
      output: count(t?.output),
      cacheRead: count(t?.cacheRead),
      cache5m: count(t?.cache5m),
      cache1h: count(t?.cache1h),
    }
    byModel[key.slice(0, 100)] = row
    tokens.input += row.input
    tokens.output += row.output
    tokens.cacheRead += row.cacheRead
    tokens.cacheWrite += row.cache5m + row.cache1h
  }
  const model = str(u.model, 60)
  const branch = str(u.branch, 80)
  return {
    model,
    effort: str(u.effort, 20),
    branch: branch === 'HEAD' ? undefined : branch, // HEAD = detached or not a git repo
    requests: count(u.requests),
    contextTokens: count(u.context),
    contextWindow: model ? contextWindow(model) : undefined,
    tokens,
    ...estimateCost(byModel),
  }
}

// Fields on an agent that aren't its identity or state; kept across events.
export const METRICS = [
  'model', 'effort', 'branch', 'requests', 'contextTokens', 'contextWindow',
  'tokens', 'cost', 'costPartial', 'toolCalls', 'prompts', 'app', 'usageByModel',
]

export function mapHook(p, agents) {
  const sid = str(p.session_id, 100)
  const hook = str(p.hook_event_name, 40)
  const aid = str(p.agent_id, 100)
  if (!sid || !hook) return null
  const app = p.app === 'codex' ? 'codex' : 'claude' // hooks installed before Codex support send no app

  const rootName = () => str(p.session_title, 40) ?? base(p.cwd) ?? 'session'
  const out = []
  const ensureRoot = () => {
    if (!agents.has(sid)) out.push({ id: sid, parentId: null, name: rootName(), task: '', status: 'working' })
  }
  const ensureSub = () => {
    ensureRoot()
    if (aid && !agents.has(aid))
      out.push({ id: aid, parentId: sid, name: str(p.agent_type, 40) ?? 'subagent', task: '', status: 'working' })
  }
  // Events fired inside a subagent carry agent_id and belong to that subagent.
  const actor = () => {
    aid ? ensureSub() : ensureRoot()
    return aid ?? sid
  }
  const tool = () => {
    const t = str(p.tool_name, 60) ?? 'tool'
    const d = str(p.tool_detail)
    return d ? `${t}: ${d}` : t
  }
  const activeSubagents = () => [...agents.values()].filter((a) => a.parentId === sid && a.status !== 'completed')
  const waitingFor = (n) => `Waiting for ${n} subagent${n === 1 ? '' : 's'}`
  const bump = (id, key) => (agents.get(id)?.[key] ?? 0) + 1
  // Attach fields to the agent's event in this batch, or send them alone if it already exists.
  const attach = (id, fields) => {
    const ev = out.findLast((e) => e.id === id)
    if (ev) Object.assign(ev, fields)
    else if (agents.has(id)) out.push({ id, ...fields })
  }

  switch (hook) {
    case 'SessionStart':
      if (p.source === 'compact') ensureRoot() // mid-turn compaction: don't change state
      else out.push({ id: sid, parentId: null, name: rootName(), task: 'Waiting for a prompt', status: 'waiting', ended: false })
      break
    case 'UserPromptSubmit':
      ensureRoot()
      out.push({ id: sid, status: 'working', ended: false, task: 'Working on a prompt', prompts: bump(sid, 'prompts') })
      break
    case 'PreToolUse':
      out.push({ id: actor(), status: 'working', task: `Using ${tool()}` })
      break
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const id = actor()
      out.push({ id, status: 'working', task: `Using ${tool()}`, toolCalls: bump(id, 'toolCalls') })
      break
    }
    case 'PermissionRequest':
      out.push({ id: actor(), status: 'waiting', attention: true, task: `Needs approval: ${tool()}` })
      break
    case 'Stop': {
      ensureRoot()
      // Background subagents: Stop fires while they run, then each result wakes the session
      // for another turn, one at a time. So once a turn has used subagents, Stop only means
      // "done" if none are active and nothing wakes the session within the settle window.
      const active = activeSubagents().length
      if (active) out.push({ id: sid, status: 'working', ended: false, turnEnded: true, task: waitingFor(active) })
      else if (agents.get(sid)?.usedSubagents) out.push({ id: sid, status: 'working', ended: false, turnEnded: true, settle: true, task: 'Finishing up' })
      else out.push({ id: sid, status: 'completed', ended: false, task: TURN_COMPLETE })
      break
    }
    case 'SubagentStart':
      if (!aid) return null
      ensureRoot()
      out.push({ id: aid, parentId: sid, name: str(p.agent_type, 40) ?? 'subagent', status: 'working', task: 'Subagent running' })
      out.push({ id: sid, usedSubagents: true })
      break
    case 'SubagentStop':
      if (!aid) return null
      // Claude Code also runs short internal helpers that report only their stop, with no
      // SubagentStart and no transcript. A real subagent was seen starting; skip the rest.
      if (!agents.has(aid)) break
      ensureSub()
      out.push({ id: aid, status: 'completed', task: 'Subagent finished' })
      // The session's turn already ended and was waiting on subagents: it completes
      // unless this result wakes it, and the settle window gives that time to happen.
      if (agents.get(sid)?.turnEnded) {
        const others = activeSubagents().filter((a) => a.id !== aid).length
        out.push(others ? { id: sid, task: waitingFor(others) } : { id: sid, settle: true, task: 'Finishing up' })
      }
      break
    case 'PostModelRequest': {
      // Codex reports usage per request attempt; the totals live on the agent.
      const u = p.token_usage
      if (!u || typeof u !== 'object') break
      const id = actor()
      const prev = agents.get(id)
      const model = str(p.model, 60) ?? prev?.model ?? 'unknown'
      // OpenAI counts cached and cache-write tokens as part of input_tokens.
      const input = count(u.input)
      const cached = Math.min(count(u.cached), input)
      const written = Math.min(count(u.cacheWrite), input - cached)
      const byModel = structuredClone(prev?.usageByModel ?? {})
      const t = (byModel[`${model}${input > OPENAI_LONG_CONTEXT ? ':long' : ''}`] ??= zero())
      t.input += input - cached - written
      t.output += count(u.output)
      t.cacheRead += cached
      t.cache5m += written
      attach(id, { ...usageFields({ model, requests: (prev?.requests ?? 0) + 1, context: input, byModel }), usageByModel: byModel })
      break
    }
    case 'Interrupt':
      ensureRoot()
      out.push({ id: sid, status: 'completed', ended: false, task: 'Interrupted, waiting for next prompt' })
      break
    case 'SessionEnd':
      if (!agents.has(sid)) break
      for (const a of agents.values())
        if (a.parentId === sid && a.status !== 'completed') out.push({ id: a.id, status: 'completed', task: 'Session ended' })
      out.push({ id: sid, status: 'completed', ended: true, task: `Session ended (${str(p.reason, 30) ?? 'other'})` })
      break
  }

  // Known before the first API response; usage below overrides it. Codex sends the model on
  // every event, including a subagent's own.
  const model = str(p.model, 60)
  if (model) attach(app === 'codex' ? (aid ?? sid) : sid, { model, contextWindow: contextWindow(model) })
  if (p.usage) attach(sid, usageFields(p.usage))
  if (aid && p.agent_usage) attach(aid, usageFields(p.agent_usage))
  for (const e of out) e.app ??= app
  return out
}
