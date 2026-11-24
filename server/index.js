// Minimal server: static files, authenticated POST /events, Map saved to a JSON file, WebSocket (/ws). No dependencies.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { METRICS, TURN_COMPLETE, mapHook } from './claude.js'

const PORT = Number(process.env.PORT) || 3000
const TOKEN = process.env.AGENT_CONTROL_TOKEN || ''
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const STATUSES = new Set(['working', 'waiting', 'completed'])
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }

const DATA_FILE = process.env.AGENT_CONTROL_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'agents.json')
const SAVE_DELAY_MS = 1000
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // finished or silent sessions are deleted after this
const STALE_WORKING_MS = 10 * 60 * 1000
const SETTLE_MS = 3000 // how long a session whose subagents finished has to wake up again

/** @type {Map<string, object>} */
const agents = new Map()
const clients = new Set()

// --- Persistence ---
let saveTimer
let saveFailed = false
function saveNow() {
  clearTimeout(saveTimer)
  saveTimer = undefined
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
    const tmp = `${DATA_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify([...agents.values()]), { mode: 0o600 })
    fs.renameSync(tmp, DATA_FILE)
    saveFailed = false
  } catch (e) {
    if (!saveFailed) console.warn(`Could not save ${DATA_FILE}: ${e.message}`)
    saveFailed = true
  }
}
const scheduleSave = () => {
  saveTimer ??= setTimeout(saveNow, SAVE_DELAY_MS)
}

function load() {
  let raw
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8')
  } catch {
    return // first run
  }
  let list
  try {
    list = JSON.parse(raw)
    if (!Array.isArray(list)) throw new Error('not a list')
  } catch (e) {
    // Keep the unreadable file instead of overwriting it on the next save.
    console.warn(`Could not read ${DATA_FILE} (${e.message}); starting empty, kept a copy as agents.json.bad`)
    try {
      fs.copyFileSync(DATA_FILE, `${DATA_FILE}.bad`)
    } catch {}
    return
  }
  const now = Date.now()
  for (const a of list) {
    if (typeof a?.id !== 'string' || !a.id) continue
    // The session may have finished while the server was down, so don't pulse "working"
    // forever. Its next event sets the real status.
    if (a.status === 'working' && now - (a.lastEventAt ?? a.startedAt) > STALE_WORKING_MS) {
      a.status = 'completed'
      a.endedAt = a.lastEventAt ?? now
      a.task = 'No activity since the server restarted'
    }
    agents.set(a.id, a)
  }
  // Saved before the server ignored them: Claude Code's internal helpers, which only report a
  // stop. They have no type of their own (so the default name), never called the model or a
  // tool, and were over within seconds. A real subagent always has at least one of those.
  let ghosts = 0
  for (const a of [...agents.values()]) {
    const ghost =
      a.parentId &&
      a.name === 'subagent' &&
      a.status === 'completed' &&
      !(a.requests > 0) &&
      !(a.toolCalls > 0) &&
      typeof a.endedAt === 'number' &&
      a.endedAt - a.startedAt <= 3000 &&
      ![...agents.values()].some((c) => c.parentId === a.id)
    if (ghost) agents.delete(a.id), ghosts++
  }
  if (ghosts) {
    console.log(`Removed ${ghosts} internal helper${ghosts === 1 ? '' : 's'} saved as subagents`)
    scheduleSave()
  }
  // Its settle timer didn't survive the restart.
  for (const a of agents.values()) {
    if (!a.turnEnded || hasActiveSubagents(a.id)) continue
    a.status = 'completed'
    a.turnEnded = false
    a.usedSubagents = false
    a.endedAt = a.lastEventAt ?? now
    a.task = TURN_COMPLETE
  }
}

const hasActiveSubagents = (id) => [...agents.values()].some((a) => a.parentId === id && a.status !== 'completed')

// Completes a session whose turn ended, unless it woke up or got more subagents meanwhile.
const settleTimers = new Map()
function settleLater(id) {
  clearTimeout(settleTimers.get(id)) // the window counts from the latest Stop
  settleTimers.set(
    id,
    setTimeout(() => {
      settleTimers.delete(id)
      if (agents.get(id)?.turnEnded && !hasActiveSubagents(id)) upsert({ id, status: 'completed', ended: false, task: TURN_COMPLETE })
    }, SETTLE_MS).unref(),
  )
}

// Removes sessions past retention, along with their subagents.
function prune() {
  const now = Date.now()
  const expired = (a) => !a.parentId && now - Math.max(a.lastEventAt ?? 0, a.endedAt ?? 0, a.startedAt ?? 0) > RETENTION_MS
  const gone = new Set([...agents.values()].filter(expired).map((a) => a.id))
  for (let grew = true; grew; ) {
    grew = false
    for (const a of agents.values()) {
      if (gone.has(a.id) || !a.parentId) continue
      if (gone.has(a.parentId) || !agents.has(a.parentId)) {
        gone.add(a.id)
        grew = true
      }
    }
  }
  for (const id of gone) {
    agents.delete(id)
    broadcast({ type: 'remove', id })
  }
  if (gone.size) scheduleSave()
}

// --- WebSocket (server -> client text frames only) ---
function frame(text) {
  const p = Buffer.from(text)
  let h
  if (p.length < 126) h = Buffer.from([0x81, p.length])
  else if (p.length < 65536) (h = Buffer.alloc(4)), (h[0] = 0x81), (h[1] = 126), h.writeUInt16BE(p.length, 2)
  else (h = Buffer.alloc(10)), (h[0] = 0x81), (h[1] = 127), h.writeBigUInt64BE(BigInt(p.length), 2)
  return Buffer.concat([h, p])
}
// --- Approvals: PermissionRequest hooks waiting for Allow / Deny from the dashboard ---
// Memory only: commands and patches can hold secrets, so they are never saved, and only clients
// with the token can read them. Everyone else sees which agent waits on which tool, as before.
const MAX_APPROVAL_WAIT_MS = 120_000
/** @type {Map<string, {id: string, agentId: string, sessionId: string, app: string, tool: string, summary?: string, description?: string, details?: string, questions?: object[], createdAt: number, expiresAt: number, timer: any, waiter?: (r: {decision: string | null, answers?: object}) => void}>} */
const approvals = new Map()
const kindOf = (a) => (a.questions ? 'question' : 'permission')
const publicApproval = (a) => ({ id: a.id, agentId: a.agentId, tool: a.tool, kind: kindOf(a), createdAt: a.createdAt, expiresAt: a.expiresAt })
const fullApproval = (a) => ({ ...publicApproval(a), sessionId: a.sessionId, app: a.app, summary: a.summary, description: a.description, details: a.details, questions: a.questions })
const broadcastApprovals = () => broadcast({ type: 'approvals', approvals: [...approvals.values()].map(publicApproval) })

const text = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : undefined)

// AskUserQuestion from Claude Code: 1-4 questions with options; anything else is ignored.
function cleanQuestions(list) {
  if (!Array.isArray(list)) return undefined
  const out = list
    .slice(0, 4)
    .map((q) => ({
      question: text(q?.question, 500),
      header: text(q?.header, 40),
      multiSelect: q?.multiSelect === true,
      options: (Array.isArray(q?.options) ? q.options : [])
        .slice(0, 8)
        .map((o) => ({ label: text(o?.label, 200), description: text(o?.description, 300) }))
        .filter((o) => o.label),
    }))
    .filter((q) => q.question)
  return out.length ? out : undefined
}

// Answers keyed by question text, one per question: an option label, labels joined with ", "
// for multi-select, or free text. Returns an error message, or nothing if they fit.
function badAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return 'answers are required for questions'
  const known = new Set(questions.map((q) => q.question))
  for (const [k, v] of Object.entries(answers)) {
    if (!known.has(k)) return `unknown question: ${k.slice(0, 80)}`
    if (typeof v !== 'string' || !v.trim() || v.length > 2000) return 'each answer must be text (1-2000 characters)'
  }
  if (Object.keys(answers).length !== known.size) return 'every question needs an answer'
}

function createApproval(agentId, sessionId, app, a) {
  const id = crypto.randomUUID()
  const wait = Math.min(MAX_APPROVAL_WAIT_MS, Math.max(1000, Number(a.waitMs) || 0))
  const now = Date.now()
  const approval = {
    id,
    agentId,
    sessionId,
    app,
    tool: text(a.tool, 100) ?? 'tool',
    summary: text(a.summary, 200),
    description: text(a.description, 300),
    details: text(a.details, 8000),
    questions: cleanQuestions(a.questions),
    createdAt: now,
    expiresAt: now + wait,
    // Ends just before the hook's own timeout, so the hook gets a clean "no decision".
    timer: setTimeout(() => closeApproval(id, null), wait).unref(),
  }
  approvals.set(id, approval)
  broadcastApprovals()
  return id
}

// Ends an approval: tells the waiting hook (decision or null = "use the normal prompt").
function closeApproval(id, decision, answers) {
  const a = approvals.get(id)
  if (!a) return null
  approvals.delete(id)
  clearTimeout(a.timer)
  a.waiter?.({ decision, answers })
  broadcastApprovals()
  return a
}

// The agent moved on without us (answered in the terminal, turn over): drop what it waited on.
// --- Settings: which apps ask the dashboard before showing their own approval prompt ---
// Codex can't show its prompt while the hook waits, so it starts off; Claude Code shows both.
const SETTINGS_FILE = path.join(path.dirname(DATA_FILE), 'settings.json')
const DEFAULT_SETTINGS = { approvals: { claude: true, codex: false } }
let settings = structuredClone(DEFAULT_SETTINGS)
function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    for (const app of ['claude', 'codex'])
      if (typeof s?.approvals?.[app] === 'boolean') settings.approvals[app] = s.approvals[app]
  } catch {} // first run, or unreadable: defaults
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
    fs.writeFileSync(`${SETTINGS_FILE}.tmp`, JSON.stringify(settings), { mode: 0o600 })
    fs.renameSync(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE)
  } catch (e) {
    console.warn(`Could not save ${SETTINGS_FILE}: ${e.message}`)
  }
}

function dropApprovals(match) {
  for (const a of [...approvals.values()]) if (match(a)) closeApproval(a.id, null)
}

// decision "pass" hands the request back to the app's own prompt, without answering it.
function decide(id, decision, answers) {
  const a = closeApproval(id, decision === 'pass' ? null : decision, answers)
  if (!a) return null
  if (decision === 'pass') return a
  const more = [...approvals.values()].some((o) => o.agentId === a.agentId)
  const verb = a.questions ? (decision === 'allow' ? 'Answered' : 'Declined') : decision === 'allow' ? 'Approved' : 'Denied'
  if (agents.has(a.agentId))
    upsert(
      more
        ? { id: a.agentId, status: 'waiting', attention: true }
        : { id: a.agentId, status: 'working', task: `${verb}: ${a.tool}` },
    )
  return a
}

const send = (socket, msg) => socket.write(frame(JSON.stringify(msg)))
const broadcast = (msg) => clients.forEach((s) => send(s, msg))

// --- Auth: shared secret in "Authorization: Bearer <token>" ---
function authorized(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  if (!m) return false
  const hash = (s) => crypto.createHash('sha256').update(s).digest()
  return crypto.timingSafeEqual(hash(m[1]), hash(TOKEN))
}

// --- Events ---
function upsert(ev) {
  if (!ev || typeof ev.id !== 'string' || !ev.id) return 'id is required'
  const prev = agents.get(ev.id)
  const status = ev.status ?? prev?.status ?? 'working'
  if (!STATUSES.has(status)) return 'status must be working | waiting | completed'
  const now = Date.now()
  const done = status === 'completed'
  const agent = {
    id: ev.id,
    parentId: ev.parentId ?? prev?.parentId ?? null,
    name: ev.name ?? prev?.name ?? ev.id,
    task: ev.task ?? prev?.task ?? '',
    status,
    // a new turn / resumed work restarts the clock
    startedAt: prev && !(prev.status === 'completed' && !done) ? prev.startedAt : now,
    endedAt: done ? (prev?.status === 'completed' ? prev.endedAt : now) : undefined,
    // ended = the whole session is over (vs. a completed turn)
    ended: done ? (ev.ended ?? prev?.ended ?? false) : false,
    lastEventAt: now,
    // Set only by an approval request; any later status change clears it. Usage-only
    // events carry no status and must not.
    attention: ev.status ? ev.attention === true : (prev?.attention ?? false),
    // Same rule: the turn ended but subagents may still wake the session.
    turnEnded: ev.status ? ev.turnEnded === true : (prev?.turnEnded ?? false),
    // Finishing is the only thing that ends a run of subagent turns.
    usedSubagents: status === 'completed' ? false : (ev.usedSubagents ?? prev?.usedSubagents ?? false),
  }
  // Parallel hooks can arrive out of order: don't let an older usage report replace a newer one.
  const stale = ev.requests !== undefined && ev.requests < (prev?.requests ?? 0)
  for (const k of METRICS) agent[k] = (stale ? undefined : ev[k]) ?? prev?.[k]
  agents.set(agent.id, agent)
  broadcast({ type: 'agent', agent })
  scheduleSave()
  return agent
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  // Liveness probe: no token required, reveals nothing about agents.
  if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true })

  // Browsers send Origin; refuse other sites even if they somehow hold the token.
  const sameOrigin = () => {
    if (!req.headers.origin) return true
    try {
      return new URL(req.headers.origin).host === req.headers.host
    } catch {
      return false
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') return json(200, settings)

  if (url.pathname === '/events' || url.pathname === '/api/agents' || url.pathname.startsWith('/api/approvals') || url.pathname === '/api/settings') {
    if (!TOKEN) return req.resume(), json(503, { error: 'AGENT_CONTROL_TOKEN is not set on the server' })
    if (!authorized(req)) return req.resume(), json(401, { error: 'unauthorized' })
  }

  if (req.method === 'POST' && url.pathname === '/events') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 65536) req.destroy()
    })
    req.on('end', () => {
      let ev
      try {
        ev = JSON.parse(body)
      } catch {
        return json(400, { error: 'invalid JSON' })
      }
      // Claude Code hook payload, or a plain agent event
      const isHook = typeof ev?.hook_event_name === 'string'
      const events = isHook ? mapHook(ev, agents) : [ev]
      if (!events) return json(400, { error: 'unsupported hook payload' })
      let last
      for (const e of events) {
        last = upsert(e)
        if (typeof last === 'string') return json(400, { error: last })
        if (e.settle) settleLater(e.id)
      }
      if (!isHook) return json(200, last)
      const hook = ev.hook_event_name
      const sid = ev.session_id
      // A new prompt, a finished turn or session: nothing is waiting on an approval any more.
      if (['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd'].includes(hook)) dropApprovals((a) => a.sessionId === sid)
      // The same agent finished a call to that tool: most likely answered in the terminal.
      if (hook === 'PostToolUse' || hook === 'PostToolUseFailure')
        dropApprovals((a) => a.agentId === (ev.agent_id ?? sid) && a.tool === ev.tool_name)
      let approval
      const asking = events.findLast((e) => e.attention)
      const app = ev.app === 'codex' ? 'codex' : 'claude'
      // Turned off for this app: no approval id, so the hook returns at once and the app asks.
      if (hook === 'PermissionRequest' && asking && ev.approval && typeof ev.approval === 'object' && settings.approvals[app])
        approval = createApproval(asking.id, sid, app, ev.approval)
      json(200, { ok: true, updates: events.length, approval })
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/agents') return json(200, [...agents.values()])

  if (req.method === 'GET' && url.pathname === '/api/approvals') return json(200, [...approvals.values()].map(fullApproval))

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    if (!sameOrigin()) return req.resume(), json(403, { error: 'cross-origin' })
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1024) req.destroy()
    })
    req.on('end', () => {
      let change
      try {
        change = JSON.parse(body)
      } catch {}
      const ap = change?.approvals
      if (!ap || typeof ap !== 'object' || !Object.entries(ap).every(([k, v]) => (k === 'claude' || k === 'codex') && typeof v === 'boolean'))
        return json(400, { error: 'expected {"approvals": {"claude"?: boolean, "codex"?: boolean}}' })
      Object.assign(settings.approvals, ap)
      saveSettings()
      // Turned off: hand what's waiting back to the app's own prompt right away.
      dropApprovals((a) => !settings.approvals[a.app])
      broadcast({ type: 'settings', settings })
      json(200, settings)
    })
    return
  }

  const am = /^\/api\/approvals\/([\w-]{1,64})(\/wait)?$/.exec(url.pathname)
  if (am && req.method === 'GET' && am[2]) {
    // The hook long-polls here until someone decides or the wait runs out.
    const a = approvals.get(am[1])
    if (!a) return json(404, { error: 'no such approval' })
    let answered = false
    a.waiter = (result) => {
      answered = true
      json(200, result)
    }
    // The hook gave up or was killed: the normal prompt is up, so stop offering the buttons.
    res.on('close', () => {
      if (!answered && approvals.get(a.id) === a) {
        a.waiter = undefined
        closeApproval(a.id, null)
      }
    })
    return
  }
  if (am && req.method === 'POST' && !am[2]) {
    if (!sameOrigin()) return req.resume(), json(403, { error: 'cross-origin' })
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 32768) req.destroy()
    })
    req.on('end', () => {
      let decision, answers
      try {
        ;({ decision, answers } = JSON.parse(body) ?? {})
      } catch {}
      if (!['allow', 'deny', 'pass'].includes(decision)) return json(400, { error: 'decision must be allow | deny | pass' })
      const pending = approvals.get(am[1])
      if (!pending) return json(404, { error: 'already answered or expired' })
      if (pending.questions && decision === 'allow') {
        const bad = badAnswers(pending.questions, answers)
        if (bad) return json(400, { error: bad })
      } else answers = undefined
      const a = decide(am[1], decision, answers)
      if (!a) return json(404, { error: 'already answered or expired' })
      json(200, { ok: true, id: a.id, decision })
    })
    return
  }

  // Static files from dist/
  const file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname)
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404)
    return res.end('Not found')
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (req.url !== '/ws' || !key) return socket.destroy()
  // Same-origin only, so other websites can't read agent state through the browser.
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) return socket.destroy()
    } catch {
      return socket.destroy()
    }
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  clients.add(socket)
  socket.on('close', () => clients.delete(socket))
  socket.on('error', () => socket.destroy())
  socket.on('data', (buf) => {
    if ((buf[0] & 0x0f) === 0x8) socket.end() // close frame; everything else is ignored
  })
  send(socket, { type: 'snapshot', agents: [...agents.values()] })
  send(socket, { type: 'approvals', approvals: [...approvals.values()].map(publicApproval) })
  send(socket, { type: 'settings', settings })
})

load()
loadSettings()
prune()
setInterval(prune, 60 * 60 * 1000).unref()
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (saveTimer) saveNow()
    process.exit(0)
  })
}

server.listen(PORT, () => {
  console.log(`Agent Control on http://localhost:${PORT}`)
  console.log(`Saving agents to ${DATA_FILE}`)
  if (!TOKEN) console.warn('WARNING: AGENT_CONTROL_TOKEN is not set; /events will reject all requests. Run: npm run install-hooks')
})
