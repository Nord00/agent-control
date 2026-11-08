// Claude Code hook -> Agent Control. Installed to ~/.agent-control/hook.mjs.
// Never blocks or fails Claude Code: short timeout, no stdout, always exit 0.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const done = () => process.exit(0)
setTimeout(done, 1000) // hard deadline (SessionEnd hooks only get ~1.5s)

const acDir = path.join(os.homedir(), '.agent-control')
const MAX_SCAN = 4 * 1024 * 1024 // bytes per run; a long backlog catches up over later events

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

function addTokens(into, row) {
  const t = (into[row.key] ??= { input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0 })
  for (const k of Object.keys(t)) t[k] += row[k]
}

// One billable API response from a transcript line. Only numbers and ids are kept, never content.
function toRow(line, mainTranscript) {
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return
  const o = JSON.parse(line)
  const m = o.message
  if (o.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') return
  if (mainTranscript && o.isSidechain) return // counted from the subagent's own transcript
  const u = m.usage
  const cacheRead = num(u.cache_read_input_tokens)
  const cacheWrite = num(u.cache_creation_input_tokens)
  const cache1h = Math.min(num(u.cache_creation?.ephemeral_1h_input_tokens), cacheWrite)
  const input = num(u.input_tokens)
  const context = input + cacheRead + cacheWrite
  // Flags that change the price: fast mode, and the long-prompt tier some models have.
  const key = `${m.model}${u.speed === 'fast' ? ':fast' : ''}${context > 100000 ? ':long' : ''}`
  return {
    id: m.id ?? o.uuid,
    key,
    model: m.model,
    effort: o.effort,
    branch: o.gitBranch,
    context,
    input,
    output: num(u.output_tokens),
    cacheRead,
    cache5m: cacheWrite - cache1h,
    cache1h,
  }
}

// Totals for a transcript, read incrementally: each hook is a new process, so the offset and
// running totals live in a small state file. A response is written as several adjacent lines
// with the same message id and must only be counted once.
function scanUsage(file, mainTranscript) {
  if (typeof file !== 'string' || !file) return
  const statePath = path.join(acDir, 'usage', `${crypto.createHash('sha1').update(file).digest('hex')}.json`)
  const fresh = () => ({ offset: 0, requests: 0, byModel: {}, cur: null })
  let s = fresh()
  try {
    s = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {}

  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size < s.offset) s = fresh() // transcript was replaced
    const len = Math.min(size - s.offset, MAX_SCAN)
    if (len > 0) {
      const buf = Buffer.allocUnsafe(len)
      fs.readSync(fd, buf, 0, len, s.offset)
      const end = buf.lastIndexOf(10)
      if (end < 0) {
        if (len === MAX_SCAN) s.offset += len // one giant line: skip past it
      } else {
        s.offset += end + 1
        for (const line of buf.toString('utf8', 0, end).split('\n')) {
          let row
          try {
            row = toRow(line, mainTranscript)
          } catch {}
          if (!row) continue
          if (s.cur && s.cur.id !== row.id) addTokens(s.byModel, s.cur)
          if (!s.cur || s.cur.id !== row.id) s.requests++
          s.cur = row
        }
      }
    }
  } finally {
    fs.closeSync(fd)
  }

  const tmp = `${statePath}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(s))
    fs.renameSync(tmp, statePath)
  } catch {
    // Lost the race with a parallel hook, or disk trouble: the next event rescans.
    fs.rmSync(tmp, { force: true })
  }

  if (!s.cur) return { requests: 0, byModel: {}, statePath }
  const byModel = structuredClone(s.byModel)
  addTokens(byModel, s.cur)
  return {
    model: s.cur.model,
    effort: s.cur.effort,
    branch: s.cur.branch,
    context: s.cur.context,
    requests: s.requests,
    byModel,
    statePath,
  }
}

function collect(file, mainTranscript, finished) {
  try {
    const u = scanUsage(file, mainTranscript)
    if (!u) return
    const { statePath, ...usage } = u
    if (finished) fs.rmSync(statePath, { force: true })
    return usage.requests ? usage : undefined
  } catch {
    // No transcript (yet) or unreadable: send the event without usage.
  }
}

try {
  let raw = ''
  process.stdin.setEncoding('utf8')
  for await (const c of process.stdin) raw += c
  const p = JSON.parse(raw)

  let cfg = {}
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(acDir, 'config.json'), 'utf8'))
  } catch {}
  const url = process.env.AGENT_CONTROL_URL || cfg.url
  const token = process.env.AGENT_CONTROL_TOKEN || cfg.token
  if (!url || !token) done()

  // Subagents have their own transcript beside the session's.
  const tp = typeof p.transcript_path === 'string' ? p.transcript_path : undefined
  const agentTranscript =
    p.agent_transcript_path ||
    (tp && p.agent_id && path.join(path.dirname(tp), path.basename(tp, '.jsonl'), 'subagents', `agent-${p.agent_id}.jsonl`))

  // Forward only what Agent Control needs (no prompts, commands, responses or tool output).
  const ti = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {}
  const detail = [ti.description, ti.file_path, ti.pattern].find((v) => typeof v === 'string' && v)
  const body = {
    session_id: p.session_id,
    hook_event_name: p.hook_event_name,
    cwd: p.cwd,
    source: p.source,
    reason: p.reason,
    session_title: p.session_title,
    model: typeof p.model === 'string' ? p.model : p.model?.id,
    agent_id: p.agent_id,
    agent_type: p.agent_type,
    tool_name: p.tool_name,
    tool_detail: detail?.slice(0, 80),
    usage: collect(tp, true, p.hook_event_name === 'SessionEnd'),
    agent_usage: p.agent_id ? collect(agentTranscript, false, p.hook_event_name === 'SubagentStop') : undefined,
  }
  await fetch(`${url.replace(/\/$/, '')}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(800),
  })
} catch {
  // Agent Control unavailable or bad input: ignore.
}
done()
