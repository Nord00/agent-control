import { useState } from 'react'
import { RETIRE_MS, fmtAgo, fmtCost } from './format'
import type { Agent } from './sim'
import * as Icon from './Icons'

export interface RecentSession {
  agent: Agent
  reason: 'Removed' | 'Ended' | 'Inactive'
  at: number // when it left the dashboard, or went quiet
}

interface Props {
  sessions: RecentSession[] // newest first
  now: number
  onOpen: (id: string) => void
  onShow: (id: string) => void
  onClear: () => void
}

export default function Recent({ sessions, now, onOpen, onShow, onClear }: Props) {
  const [open, setOpen] = useState(false)
  if (!sessions.length) return null
  return (
    <div className="recent">
      {open && (
        <div className="recent-list card">
          <div className="recent-head">
            <h2>Recent sessions</h2>
            <button
              className="link-button"
              onClick={() => {
                onClear()
                setOpen(false)
              }}
            >
              Clear all
            </button>
          </div>
          <ul>
            {sessions.map(({ agent: s, reason, at }) => (
              <li key={s.id}>
                <button className="recent-open" onClick={() => onOpen(s.id)} title={s.name}>
                  <span className="recent-name">{s.name}</span>
                  <span className="recent-meta">
                    {reason} {fmtAgo(now - at)}
                    {typeof s.cost === 'number' && ` · ${fmtCost(s.cost, s.costPartial)}`}
                  </span>
                </button>
                <button
                  className="recent-show"
                  onClick={() => onShow(s.id)}
                  aria-label={`Show ${s.name} on the dashboard`}
                  title="Show on the dashboard"
                >
                  <Icon.Eye />
                </button>
              </li>
            ))}
          </ul>
          <p className="hint">
            Ended sessions move here after {RETIRE_MS / 60000} minutes and are deleted after 7 days. Sessions come back
            on their own when they're active again.
          </p>
        </div>
      )}
      <button className="recent-toggle card" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon.History /> Recent <b>{sessions.length}</b>
      </button>
    </div>
  )
}
