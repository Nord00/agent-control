// Claude Code / Codex hook -> Agent Control. Installed to ~/.agent-control/hook.mjs.
// Codex runs it as `node hook.mjs codex`; without an argument it's Claude Code.
// Never fails the agent: always exit 0. Every event is a short fire-and-forget report, except
// PermissionRequest, which waits up to approvalWaitSeconds (config.json, default 60, 0 = off) for
// an Allow or Deny from the dashboard. No answer means no output, so the normal prompt runs.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const app = process.argv[2] === 'codex' ? 'codex' : 'claude'
const done = () => process.exit(0)
let deadline = setTimeout(done, 1000) // hard deadline (SessionEnd hooks only get ~1.5s)
const MAX_WAIT_S = 120 // the installer gives PermissionRequest hooks a 130s timeout

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

// What the dashboard shows for an approval: the command, patch or arguments as text.
// Kept in the server's memory only until answered, never saved.
function approvalPreview(p) {
  const ti = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {}
  const cmd = Array.isArray(ti.command) ? ti.command.join(' ') : ti.command
  // Codex patches: the files they touch, from the patch headers.
  const files = typeof cmd === 'string' ? [...cmd.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]) : []
  const patch = files.length ? `${files[0]}${files.length > 1 ? ` (+${files.length - 1} more)` : ''}` : undefined
  const summary = [patch, cmd, ti.file_path, ti.url, ti.pattern, ti.path].find((v) => typeof v === 'string' && v)
  let details
  if (typeof cmd === 'string' && Object.keys(ti).every((k) => k === 'command' || k === 'description')) details = cmd
  else details = JSON.stringify(ti, null, 2)
  return {
    tool: typeof p.tool_name === 'string' ? p.tool_name.slice(0, 100) : 'tool',
    summary: summary?.split('\n')[0].slice(0, 200),
    description: typeof ti.description === 'string' ? ti.description.slice(0, 300) : undefined,
    details: details?.slice(0, 8000),
  }
}

const decisionOutput = (behavior) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: behavior === 'deny' ? { behavior, message: 'Denied from Agent Control.' } : { behavior },
    },
  })

// Codex PostModelRequest: token counts for one request attempt, numbers only.
function requestUsage(u) {
  if (!u || typeof u !== 'object') return
  return {
    input: num(u.input_tokens),
    cached: num(u.cached_input_tokens),
    cacheWrite: num(u.cache_write_input_tokens),
    output: num(u.output_tokens),
  }
}

try {
  let raw = ''
  process.stdin.setEncoding('utf8')
  for await (const c of process.stdin) raw += c
  const p = JSON.parse(raw)
  // Codex expects JSON (not nothing) from these; {} changes nothing.
  if (app === 'codex' && (p.hook_event_name === 'Stop' || p.hook_event_name === 'SubagentStop')) fs.writeSync(1, '{}\n')
  // Codex forks short-lived helper sessions (e.g. to name a new chat) that it keeps no history
  // for: transcript_path is null on every one of their events. They aren't work to show.
  if (app === 'codex' && p.transcript_path === null) done()

  let cfg = {}
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(acDir, 'config.json'), 'utf8'))
  } catch {}
  // Troubleshooting: "debugLog": true in config.json appends each payload to debug.jsonl here,
  // minus prompts, tool input/output and replies.
  if (cfg.debugLog === true) {
    try {
      const { prompt, tool_input, tool_response, last_assistant_message, ...meta } = p
      const line = JSON.stringify({ at: new Date().toISOString(), app, ...meta, omitted: Object.keys({ prompt, tool_input, tool_response, last_assistant_message }).filter((k) => p[k] !== undefined) })
      fs.appendFileSync(path.join(acDir, 'debug.jsonl'), line + '\n', { mode: 0o600 })
    } catch {}
  }
  const url = process.env.AGENT_CONTROL_URL || cfg.url
  const token = process.env.AGENT_CONTROL_TOKEN || cfg.token
  if (!url || !token) done()
  const base = url.replace(/\/$/, '')
  const waitS = Math.min(MAX_WAIT_S, Math.max(0, Number(cfg.approvalWaitSeconds ?? 60) || 0))
  const ask = p.hook_event_name === 'PermissionRequest' && waitS > 0

  // Subagents have their own transcript beside the session's.
  const tp = typeof p.transcript_path === 'string' ? p.transcript_path : undefined
  const agentTranscript =
    p.agent_transcript_path ||
    (tp && p.agent_id && path.join(path.dirname(tp), path.basename(tp, '.jsonl'), 'subagents', `agent-${p.agent_id}.jsonl`))

  // Forward only what Agent Control needs (no prompts, commands, responses or tool output).
  const ti = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {}
  // Codex file edits: only the first file name from the patch header, never the patch itself.
  const patched =
    p.tool_name === 'apply_patch' && typeof ti.command === 'string'
      ? /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(ti.command)?.[1]
      : undefined
  const detail = [ti.description, ti.file_path, ti.pattern, patched].find((v) => typeof v === 'string' && v)
  const codex = app === 'codex'
  const body = {
    app,
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
    // Claude Code: totals read from the transcripts. Codex: its transcript format isn't stable,
    // but each model request reports its own token counts, which the server adds up.
    usage: codex ? undefined : collect(tp, true, p.hook_event_name === 'SessionEnd'),
    agent_usage: !codex && p.agent_id ? collect(agentTranscript, false, p.hook_event_name === 'SubagentStop') : undefined,
    kind: codex ? p.kind : undefined,
    token_usage: codex ? requestUsage(p.token_usage) : undefined,
    approval: ask ? { ...approvalPreview(p), waitMs: waitS * 1000 } : undefined,
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const res = await fetch(`${base}/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(800),
  })
  const approvalId = ask && res.ok ? (await res.json())?.approval : undefined
  if (typeof approvalId === 'string') {
    // Wait for the dashboard. The server answers when someone decides or the wait runs out.
    clearTimeout(deadline)
    deadline = setTimeout(done, waitS * 1000 + 3000)
    const r = await fetch(`${base}/api/approvals/${encodeURIComponent(approvalId)}/wait`, {
      headers,
      signal: AbortSignal.timeout(waitS * 1000 + 2000),
    })
    const decision = r.ok ? (await r.json())?.decision : undefined
    if (decision === 'allow' || decision === 'deny') fs.writeSync(1, decisionOutput(decision) + '\n')
  }
} catch {
  // Agent Control unavailable or bad input: ignore.
}
done()
