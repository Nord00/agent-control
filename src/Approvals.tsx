import { useEffect, useState } from 'react'
import * as Icon from './Icons'

// What every dashboard viewer gets over the WebSocket.
export interface PendingApproval {
  id: string
  agentId: string
  tool: string
  createdAt: number
  expiresAt: number
}

// What only a browser holding the token can read: the actual command or patch.
export interface ApprovalDetail extends PendingApproval {
  app: 'claude' | 'codex'
  summary?: string
  description?: string
  details?: string
}

export type Decide = (id: string, decision: 'allow' | 'deny') => Promise<void>

interface CardProps {
  approval: PendingApproval
  detail?: ApprovalDetail
  hasToken: boolean
  onUnlock: (token: string) => void
  onDecide: Decide
  agentName?: string // shown when the card isn't already under its agent
}

function useSecondsLeft(until: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return Math.max(0, Math.ceil((until - now) / 1000))
}

export function TokenForm({ onUnlock }: { onUnlock: (token: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <form
      className="ap-unlock"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim()) onUnlock(value.trim())
      }}
    >
      <label>
        To see and answer approvals here, paste the <code>token</code> from <code>~/.agent-control/config.json</code>.
        It stays in this browser.
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Agent Control token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button className="panel-button" type="submit" disabled={!value.trim()}>
        Unlock
      </button>
    </form>
  )
}

export function ApprovalCard({ approval, detail, hasToken, onUnlock, onDecide, agentName }: CardProps) {
  const left = useSecondsLeft(approval.expiresAt)
  const [busy, setBusy] = useState<null | 'allow' | 'deny'>(null)
  const [error, setError] = useState('')
  const decide = async (d: 'allow' | 'deny') => {
    setBusy(d)
    setError('')
    try {
      await onDecide(approval.id, d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the answer')
      setBusy(null)
    }
  }
  const showDetails = detail?.details && detail.details !== detail.summary
  return (
    <div className="ap-card" onClick={(e) => e.stopPropagation()} role="group" aria-label={`Approval for ${approval.tool}`}>
      <div className="ap-head">
        <Icon.Shield />
        <span className="ap-title">
          {agentName && <span className="ap-agent">{agentName} · </span>}
          Wants to use <b>{approval.tool}</b>
        </span>
        <span className="ap-timer" title="After this, the normal prompt in the terminal takes over">
          {left > 0 ? `${left}s` : 'In terminal'}
        </span>
      </div>
      {!hasToken ? (
        <TokenForm onUnlock={onUnlock} />
      ) : !detail ? (
        <p className="hint">Loading…</p>
      ) : (
        <>
          {detail.description && <p className="ap-desc">{detail.description}</p>}
          {detail.summary && <code className="ap-summary">{detail.summary}</code>}
          {showDetails && (
            <details className="ap-details">
              <summary>Full request</summary>
              <pre>{detail.details}</pre>
            </details>
          )}
          <div className="ap-actions">
            <button className="ap-deny" disabled={!!busy || left === 0} onClick={() => decide('deny')}>
              {busy === 'deny' ? 'Denying…' : 'Deny'}
            </button>
            <button className="ap-allow" disabled={!!busy || left === 0} onClick={() => decide('allow')}>
              {busy === 'allow' ? 'Allowing…' : 'Allow'}
            </button>
          </div>
          {error && <p className="ap-error">{error}</p>}
        </>
      )}
    </div>
  )
}
