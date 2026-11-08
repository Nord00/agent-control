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

  if (url.pathname === '/events' || url.pathname === '/api/agents') {
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
      json(200, isHook ? { ok: true, updates: events.length } : last)
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/agents') return json(200, [...agents.values()])

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
})

load()
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
