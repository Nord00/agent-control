import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import AgentNode from './AgentNode'
import { TOKENS_NOTE, fmtCost, fmtDuration, fmtTokens, isRetired, modelName, newTokens, retiredAt, rootOf, sumUsage, totalTokens, withDescendants } from './format'
import { footprint, relocate, setStageRule } from './layout'
import Recent from './Recent'
import type { RecentSession } from './Recent'
import { STATUS_LABEL, applyEvent, initialAgents, step } from './sim'
import type { Agent, AgentEvent } from './sim'
import * as Icon from './Icons'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Space taken by the top and bottom bars, kept clear when fitting agents to the window.
const TOP_BAR = 84
const BOTTOM_BAR = 96
const MAX_FIT_ZOOM = 1.3

const COST_NOTE = 'Estimated at Anthropic API list prices. Subscription plans are not billed per token.'

// Per-browser preferences: storage can be unavailable, and the page must work without it.
function readPref(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

const notificationsSupported = () => typeof Notification !== 'undefined'

// What you removed from or brought back to the dashboard, per agent, in this browser.
interface Override {
  mode: 'show' | 'hide'
  at: number
}
type Overrides = Record<string, Override>
const OVERRIDE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // longer than the server keeps anything

function loadOverrides(): Overrides {
  try {
    const all = JSON.parse(readPref('ac.overrides') ?? '{}') as Overrides
    const cutoff = Date.now() - OVERRIDE_MAX_AGE_MS
    return Object.fromEntries(Object.entries(all).filter(([, o]) => o && o.at > cutoff))
  } catch {
    return {}
  }
}

// Removed, unless it has been active since: you shouldn't miss new work.
const removedAt = (a: Agent, ov: Overrides) => {
  const o = ov[a.id]
  return o?.mode === 'hide' && (a.lastEventAt ?? 0) <= o.at ? o.at : null
}

const sessionOnStage = (root: Agent, ov: Overrides, now: number) =>
  removedAt(root, ov) === null && (ov[root.id]?.mode === 'show' || !isRetired(root, now))

function isOnStage(a: Agent, byId: Map<string, Agent>, ov: Overrides, now: number) {
  const root = rootOf(a, byId)
  if (!sessionOnStage(root, ov, now)) return false
  // A removed subagent takes the ones under it along.
  let cur: Agent | undefined = a
  for (let i = 0; i < 16 && cur && cur !== root; i++) {
    if (removedAt(cur, ov) !== null) return false
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return true
}

const leftStageAt = (root: Agent, ov: Overrides) => removedAt(root, ov) ?? retiredAt(root)

function Row({ icon, label, children, title }: { icon?: ReactNode; label: string; children: ReactNode; title?: string }) {
  return (
    <div className="row" title={title}>
      <span className="row-icon">{icon}</span>
      <span className="row-label">{label}</span>
      <span className="row-value">{children}</span>
    </div>
  )
}

function TokenBreakdown({ tokens }: { tokens: NonNullable<Agent['tokens']> }) {
  const total = totalTokens(tokens) || 1
  const parts = [
    ['input', 'Input', tokens.input],
    ['output', 'Output', tokens.output],
    ['read', 'Cache read', tokens.cacheRead],
    ['write', 'Cache write', tokens.cacheWrite],
  ] as const
  return (
    <div className="tokens">
      <div className="token-bar" aria-hidden="true">
        {parts.map(([key, , n]) => (
          <i key={key} className={`t-${key}`} style={{ width: `${(n / total) * 100}%` }} />
        ))}
      </div>
      <ul>
        {parts.map(([key, label, n]) => (
          <li key={key}>
            <i className={`t-${key}`} />
            <span>{label}</span>
            <b>{fmtTokens(n)}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface PanelProps {
  agent: Agent
  agents: Agent[]
  onClose: () => void
  onStage: boolean
  canShow: boolean // false for a subagent whose session isn't on the dashboard
  onHide: () => void
  onShow: () => void
  removedSubagents: number
  onShowSubagents: () => void
}

function Panel({ agent, agents, onClose, onStage, canShow, onHide, onShow, removedSubagents, onShowSubagents }: PanelProps) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const parent = agents.find((a) => a.id === agent.parentId)
  const children = agents.filter((a) => a.parentId === agent.id)
  const end = agent.endedAt ?? Date.now()
  const family = withDescendants(agent, agents)
  const usage = sumUsage(family)
  const total = totalTokens(usage.tokens)
  const scope = family.length > 1 ? ' (with subagents)' : ''
  const contextPct =
    agent.contextTokens && agent.contextWindow ? Math.min(100, (agent.contextTokens / agent.contextWindow) * 100) : null
  return (
    <aside className="panel card">
      <button className="close" onClick={onClose} aria-label="Close">
        <Icon.Close />
      </button>
      <h2 title={agent.name}>{agent.name}</h2>
      <div className={`pill ${agent.status}`}>
        <i>{agent.status === 'completed' && <Icon.Check />}</i>
        {agent.ended ? 'Session ended' : agent.attention ? 'Needs approval' : STATUS_LABEL[agent.status]}
      </div>
      <p className="task">{agent.task}</p>

      <div className="rows">
        <Row icon={<Icon.Layers />} label="Type">
          {agent.depth === 0 ? 'Root agent' : 'Subagent'}
        </Row>
        {parent && <Row label="Parent">{parent.name}</Row>}
        <Row icon={<Icon.Branch />} label="Subagents">
          {children.length}
          {children.length > 0 && ` (${children.filter((c) => c.status !== 'completed').length} active)`}
        </Row>
        <Row icon={<Icon.Clock />} label={agent.endedAt ? 'Ran for' : 'Running'}>
          {fmtDuration(end - agent.startedAt)}
        </Row>
      </div>

      <h3>Usage</h3>
      <div className="rows">
        <Row icon={<Icon.Chip />} label="Model" title={agent.model}>
          {modelName(agent.model)}
          {agent.effort && <small>{agent.effort}</small>}
        </Row>
        <Row icon={<Icon.Dollar />} label={`Est. cost${scope}`} title={COST_NOTE}>
          {fmtCost(usage.cost, usage.costPartial)}
        </Row>
        {contextPct !== null && (
          <Row icon={<Icon.Gauge />} label="Context">
            {fmtTokens(agent.contextTokens!)} / {fmtTokens(agent.contextWindow!)}
          </Row>
        )}
        {contextPct !== null && (
          <div className="meter" role="img" aria-label={`Context ${contextPct.toFixed(0)}% full`}>
            <i style={{ width: `${contextPct}%` }} />
          </div>
        )}
        <Row icon={<Icon.Chat />} label="Prompts / API calls">
          {agent.prompts ?? (agent.depth === 0 ? 0 : '—')} / {agent.requests ?? 0}
        </Row>
        <Row icon={<Icon.Wrench />} label="Tool calls">
          {agent.toolCalls ?? 0}
        </Row>
        {agent.branch && (
          <Row icon={<Icon.Branch />} label="Git branch" title={agent.branch}>
            {agent.branch}
          </Row>
        )}
      </div>

      <h3 title={TOKENS_NOTE}>
        Tokens{scope} <b>{total ? `${fmtTokens(newTokens(usage.tokens))} new / ${fmtTokens(total)} total` : '—'}</b>
      </h3>
      {total > 0 ? (
        <TokenBreakdown tokens={usage.tokens} />
      ) : (
        <p className="hint">Appears after this agent's first API response.</p>
      )}

      <div className="panel-actions">
        {onStage ? (
          <button className="panel-button" onClick={onHide}>
            <Icon.EyeOff /> Remove from dashboard
          </button>
        ) : (
          canShow && (
            <button className="panel-button" onClick={onShow}>
              <Icon.Eye /> Show on dashboard
            </button>
          )
        )}
        {onStage && removedSubagents > 0 && (
          <button className="panel-button" onClick={onShowSubagents}>
            <Icon.Eye /> Show {removedSubagents} removed subagent{removedSubagents === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </aside>
  )
}

export default function App() {
  const demo = new URLSearchParams(location.search).has('demo')
  const [agents, setAgents] = useState<Agent[]>(() => (demo ? initialAgents() : []))
  const [selected, setSelected] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [view, setView] = useState(() => ({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    k: 1,
  }))
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  const stageRef = useRef<HTMLDivElement>(null)
  const moved = useRef(false)
  const touched = useRef(false) // once the user pans or zooms, stop auto-fitting
  const [now, setNow] = useState(() => Date.now())
  const [clearedBefore, setClearedBefore] = useState(() => Number(readPref('ac.clearedBefore')) || 0)
  const [notifyOn, setNotifyOn] = useState(
    () => readPref('ac.notify') === 'on' && notificationsSupported() && Notification.permission === 'granted',
  )
  const notifyOnRef = useRef(notifyOn)
  notifyOnRef.current = notifyOn
  const needingApproval = useRef(new Set<string>())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(t)
  }, [])

  const [overrides, setOverrides] = useState(loadOverrides)
  const overridesRef = useRef(overrides) // read by the layout between renders
  // New nodes are placed around what's actually on the dashboard.
  setStageRule((a, all) => isOnStage(a, all, overridesRef.current, Date.now()))

  const byId = new Map(agents.map((a) => [a.id, a]))
  const sel = selected ? byId.get(selected) : undefined
  // Retired or removed sessions leave the stage for the Recent list until cleared in this browser.
  const visible = agents.filter((a) => isOnStage(a, byId, overrides, now))
  const isCleared = (root: Agent) => !sessionOnStage(root, overrides, now) && leftStageAt(root, overrides) <= clearedBefore
  const recent: RecentSession[] = agents
    .filter((a) => !a.parentId && !sessionOnStage(a, overrides, now) && !isCleared(a))
    .map((a) => ({
      agent: a,
      reason: removedAt(a, overrides) !== null ? ('Removed' as const) : a.ended ? ('Ended' as const) : ('Inactive' as const),
      at: leftStageAt(a, overrides),
    }))
    .sort((a, b) => b.at - a.at)
  const counted = agents.filter((a) => !isCleared(rootOf(a, byId))) // what the totals cover

  const changeOverrides = (change: (o: Overrides) => void) => {
    const next = { ...overridesRef.current }
    change(next)
    overridesRef.current = next // before any relocation reads it
    setOverrides(next)
    writePref('ac.overrides', JSON.stringify(next))
  }
  const removeFromStage = (id: string) => changeOverrides((o) => void (o[id] = { mode: 'hide', at: Date.now() }))
  const showOnStage = (ids: string[]) => {
    changeOverrides((o) => {
      for (const id of ids) {
        const a = byId.get(id)
        // A retired session stays until you remove it; anything else just stops being removed.
        if (a && !a.parentId && isRetired(a, Date.now())) o[id] = { mode: 'show', at: Date.now() }
        else delete o[id]
      }
    })
    setAgents((l) => ids.reduce(relocate, l)) // its old spot may have been taken
    touched.current = false // frame it, even if you had panned away
  }
  const removedUnder = (agent: Agent) =>
    withDescendants(agent, agents).filter((a) => a !== agent && removedAt(a, overrides) !== null)
  const attention = visible.filter((a) => a.attention).length

  useEffect(() => {
    document.title = attention ? `(${attention}) Agent Control` : 'Agent Control'
  }, [attention])

  // Fires on the moment an agent starts needing approval, never for ones already waiting at load.
  const trackApprovals = useCallback((a: AgentEvent, live: boolean) => {
    const known = needingApproval.current
    if (!a.attention) return void known.delete(a.id)
    if (known.has(a.id)) return
    known.add(a.id)
    if (!live || !notifyOnRef.current || !notificationsSupported()) return
    if (Notification.permission !== 'granted') return
    if (!document.hidden && document.hasFocus()) return // already looking at it
    const n = new Notification(`${a.name ?? 'An agent'} needs approval`, {
      body: a.task,
      tag: a.id,
      icon: '/favicon.svg',
    })
    n.onclick = () => {
      window.focus()
      setSelected(a.id)
      n.close()
    }
  }, [])

  const toggleNotifications = async () => {
    if (notifyOn) {
      setNotifyOn(false)
      writePref('ac.notify', 'off')
      return
    }
    if ((await Notification.requestPermission()) !== 'granted') return setNotifyOn(false)
    setNotifyOn(true)
    writePref('ac.notify', 'on')
  }

  useEffect(() => {
    if (demo) {
      const t = setInterval(() => setAgents(step), 2800)
      return () => clearInterval(t)
    }
    // Live mode: WebSocket with auto-reconnect.
    let ws: WebSocket | undefined
    let timer: number | undefined
    let closed = false
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      ws.onopen = () => setLive(true)
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.type === 'snapshot') {
          // The snapshot is the whole truth: drop anything deleted while disconnected.
          const list = m.agents as AgentEvent[]
          const ids = new Set(list.map((a) => a.id))
          for (const a of list) trackApprovals(a, false)
          setAgents((l) => list.reduce((acc, ev) => applyEvent(acc, ev, false), l.filter((a) => ids.has(a.id))))
        } else if (m.type === 'agent') {
          trackApprovals(m.agent as AgentEvent, true)
          setAgents((l) => applyEvent(l, m.agent as AgentEvent, true))
        } else if (m.type === 'remove') {
          setAgents((l) => l.filter((a) => a.id !== m.id))
        }
      }
      ws.onclose = () => {
        setLive(false)
        if (!closed) timer = window.setTimeout(connect, 2000)
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(timer)
      ws?.close()
    }
  }, [demo, trackApprovals])

  useEffect(() => {
    const el = stageRef.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Frame every agent in the space between the bars.
  const fit = useCallback(
    (list: Agent[]) => {
      const availW = Math.max(100, size.w - 48)
      const availH = Math.max(100, size.h - TOP_BAR - BOTTOM_BAR)
      const midY = TOP_BAR + availH / 2
      if (!list.length) return setView({ x: size.w / 2, y: midY, k: 1 })
      const pad = 24 // room for the glow
      const boxes = list.map(footprint)
      const x0 = Math.min(...boxes.map((b) => b.x0)) - pad
      const x1 = Math.max(...boxes.map((b) => b.x1)) + pad
      const y0 = Math.min(...boxes.map((b) => b.y0)) - pad
      const y1 = Math.max(...boxes.map((b) => b.y1)) + pad
      const k = clamp(Math.min(availW / (x1 - x0), availH / (y1 - y0)), 0.25, MAX_FIT_ZOOM)
      setView({ k, x: size.w / 2 - (k * (x0 + x1)) / 2, y: midY - (k * (y0 + y1)) / 2 })
    },
    [size],
  )

  useEffect(() => {
    if (!touched.current) fit(visible)
  }, [visible.length, fit]) // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAt = useCallback((f: number, cx: number, cy: number) => {
    touched.current = true
    setView((v) => {
      const k = clamp(v.k * f, 0.25, 3)
      const s = k / v.k
      return { k, x: cx - (cx - v.x) * s, y: cy - (cy - v.y) * s }
    })
  }, [])

  // Wheel zoom toward the cursor (native listener so preventDefault works).
  useEffect(() => {
    const el = stageRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const sx = e.clientX
    const sy = e.clientY
    let lx = sx
    let ly = sy
    moved.current = false
    const move = (ev: PointerEvent) => {
      if (!moved.current && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
      moved.current = true
      touched.current = true
      const dx = ev.clientX - lx
      const dy = ev.clientY - ly
      lx = ev.clientX
      ly = ev.clientY
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const select = (id: string) => {
    if (!moved.current) setSelected(id)
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen?.().catch(() => {})
  }

  const totals = sumUsage(counted)
  const tokens = totalTokens(totals.tokens)
  const counts = { working: 0, waiting: 0, completed: 0 }
  for (const a of visible) counts[a.status]++

  return (
    <>
      <div className="aurora" aria-hidden="true">
        <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
          <defs>
            <linearGradient id="au1" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#3b3fd8" stopOpacity="0" />
              <stop offset="0.5" stopColor="#4f5bff" stopOpacity="0.75" />
              <stop offset="1" stopColor="#6a7bff" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="au2" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#3b3fd8" stopOpacity="0" />
              <stop offset="1" stopColor="#a56bff" stopOpacity="0.8" />
            </linearGradient>
          </defs>
          <path className="au-line" d="M60 310C190 215 320 250 470 190" stroke="url(#au1)" />
          <path className="au-line" d="M1270 800C1390 690 1480 710 1600 650" stroke="url(#au2)" />
        </svg>
      </div>

      <div
        ref={stageRef}
        className="stage"
        style={{
          backgroundSize: `${40 * view.k}px ${40 * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerDown={onPointerDown}
        onClick={() => {
          if (!moved.current) setSelected(null)
        }}
      >
        <div className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="links" aria-hidden="true">
            {visible.map((a) => {
              const p = a.parentId ? byId.get(a.parentId) : undefined
              if (!p) return null
              const dx = a.x - p.x
              const dy = a.y - p.y
              const side = a.seed % 2 ? 1 : -1
              // A slight curve: enough to feel organic, little enough to stay in its gap.
              const cx = (a.x + p.x) / 2 - dy * 0.06 * side
              const cy = (a.y + p.y) / 2 + dx * 0.06 * side
              return (
                <path
                  key={`l${a.id}`}
                  className={`link${a.fresh ? ' fresh' : ''}`}
                  pathLength={1}
                  d={`M${p.x} ${p.y}Q${cx} ${cy} ${a.x} ${a.y}`}
                />
              )
            })}
          </svg>
          {visible.map((a) => (
            <AgentNode
              key={a.id}
              agent={a}
              from={a.parentId ? byId.get(a.parentId) ?? null : null}
              selected={a.id === selected}
              pinned={overrides[rootOf(a, byId).id]?.mode === 'show'}
              onSelect={select}
            />
          ))}
        </div>
      </div>

      {visible.length === 0 && (
        <div className="empty">
          <h2>No active agents</h2>
          <p>{live ? 'Start a Claude Code session and it will appear here.' : 'Connecting to the server…'}</p>
        </div>
      )}

      <header className="topbar">
        <Icon.Logo />
        <h1>Agent Control</h1>
        <span className="divider" />
        <span className={`live ${demo || live ? 'on' : 'off'}`}>
          <i /> {demo ? 'Demo' : live ? 'Live' : 'Offline'}
        </span>
        <span className="stat">
          {visible.length} {visible.length === 1 ? 'agent' : 'agents'}
        </span>
        {attention > 0 && <span className="stat alert">{attention} needs approval</span>}
        {tokens > 0 && (
          <span className="stat" title={TOKENS_NOTE}>
            {fmtTokens(newTokens(totals.tokens))} new / {fmtTokens(tokens)} total tokens
          </span>
        )}
        {totals.cost !== null && (
          <span className="stat" title={COST_NOTE}>
            {fmtCost(totals.cost, totals.costPartial)} est.
          </span>
        )}
      </header>

      <div className="tools">
        {notificationsSupported() && !demo && (
          <button
            className={`tool${notifyOn ? ' active' : ''}`}
            aria-pressed={notifyOn}
            aria-label="Notify me when an agent needs approval"
            title={
              Notification.permission === 'denied'
                ? 'Notifications are blocked for this site in your browser settings'
                : notifyOn
                  ? 'Notifications on. Click to turn off'
                  : 'Notify me when an agent needs approval'
            }
            onClick={toggleNotifications}
          >
            {notifyOn ? <Icon.Bell /> : <Icon.BellOff />}
          </button>
        )}
        <button
          className="tool"
          aria-label="Fit all agents"
          title="Fit all agents"
          onClick={() => {
            touched.current = false
            fit(visible)
          }}
        >
          <Icon.Target />
        </button>
        <span className="tool-group">
          <button className="tool" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAt(1 / 1.25, size.w / 2, size.h / 2)}>
            <Icon.Minus />
          </button>
          <button className="tool" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)}>
            <Icon.ZoomIn />
          </button>
        </span>
        <button className="tool" aria-label="Toggle fullscreen" title="Fullscreen" onClick={toggleFullscreen}>
          <Icon.Expand />
        </button>
      </div>

      <footer className="statusbar">
        {(['working', 'waiting', 'completed'] as const).map((s) => (
          <div key={s} className="status-item">
            <i className={s} />
            <span>{STATUS_LABEL[s]}</span>
            <b>{counts[s]}</b>
          </div>
        ))}
      </footer>

      <Recent
        sessions={recent}
        now={now}
        onOpen={setSelected}
        onShow={(id) => showOnStage([id])}
        onClear={() => {
          const t = Date.now()
          setClearedBefore(t)
          writePref('ac.clearedBefore', String(t))
          setSelected((id) => (id && recent.some((r) => r.agent.id === id) ? null : id))
        }}
      />

      {sel && (
        <Panel
          agent={sel}
          agents={agents}
          onClose={() => setSelected(null)}
          onStage={isOnStage(sel, byId, overrides, now)}
          canShow={sessionOnStage(rootOf(sel, byId), overrides, now) || !sel.parentId}
          onHide={() => removeFromStage(sel.id)}
          onShow={() => showOnStage([sel.id])}
          removedSubagents={removedUnder(sel).length}
          onShowSubagents={() => showOnStage(removedUnder(sel).map((a) => a.id))}
        />
      )}
    </>
  )
}
