import { useEffect, useRef, useState } from 'react'
import * as Icon from './Icons'
import { useDismiss } from './useDismiss'

// What every dashboard viewer gets over the WebSocket.
export interface PendingApproval {
  id: string
  agentId: string
  tool: string
  kind?: 'permission' | 'question' // AskUserQuestion: answered with options, not Allow / Deny
  createdAt: number
  expiresAt: number
}

// What only a browser holding the token can read: the actual command or patch.
export interface ApprovalDetail extends PendingApproval {
  app: 'claude' | 'codex'
  summary?: string
  description?: string
  details?: string
  questions?: Question[]
}

export interface Question {
  question: string
  header?: string
  multiSelect: boolean
  options: { label: string; description?: string }[]
}

export type Decision = 'allow' | 'deny' | 'pass' // pass = leave it to the app's own prompt
export type Decide = (id: string, decision: Decision, answers?: Record<string, string>) => Promise<void>

const APP_NAME = { claude: 'Claude Code', codex: 'Codex' } as const

// One question: pick an option (or several), or write your own answer.
function QuestionField({ q, value, onChange }: { q: Question; value: Picked; onChange: (v: Picked) => void }) {
  const toggle = (label: string) => {
    if (!q.multiSelect) return onChange({ labels: [label], other: '' })
    const has = value.labels.includes(label)
    onChange({ ...value, labels: has ? value.labels.filter((l) => l !== label) : [...value.labels, label] })
  }
  return (
    <fieldset className="ap-q">
      <legend>
        {q.header && <span className="ap-q-header">{q.header}</span>}
        {q.question}
        {q.multiSelect && <small> (choose any)</small>}
      </legend>
      <div className="ap-options">
        {q.options.map((o) => (
          <button
            key={o.label}
            type="button"
            className="ap-option"
            aria-pressed={value.labels.includes(o.label)}
            onClick={() => toggle(o.label)}
          >
            <b>{o.label}</b>
            {o.description && <span>{o.description}</span>}
          </button>
        ))}
      </div>
      <input
        className="ap-other"
        placeholder="Or write your own answer"
        value={value.other}
        onChange={(e) => onChange({ labels: q.multiSelect ? value.labels : [], other: e.target.value })}
      />
    </fieldset>
  )
}

interface Picked {
  labels: string[]
  other: string
}
const answerOf = (p: Picked | undefined) => [...(p?.labels ?? []), ...(p?.other.trim() ? [p.other.trim()] : [])].join(', ')

function QuestionForm({ questions, busy, disabled, onAnswer }: { questions: Question[]; busy: boolean; disabled: boolean; onAnswer: (a: Record<string, string>) => void }) {
  const [picked, setPicked] = useState<Record<string, Picked>>({})
  const answers = Object.fromEntries(questions.map((q) => [q.question, answerOf(picked[q.question])]))
  const complete = questions.every((q) => answers[q.question])
  return (
    <form
      className="ap-questions"
      onSubmit={(e) => {
        e.preventDefault()
        if (complete) onAnswer(answers)
      }}
    >
      {questions.map((q) => (
        <QuestionField
          key={q.question}
          q={q}
          value={picked[q.question] ?? { labels: [], other: '' }}
          onChange={(v) => setPicked((p) => ({ ...p, [q.question]: v }))}
        />
      ))}
      <div className="ap-actions">
        <button type="submit" className="ap-allow" disabled={!complete || busy || disabled}>
          {busy ? 'Sending…' : questions.length > 1 ? 'Send answers' : 'Send answer'}
        </button>
      </div>
    </form>
  )
}

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
  const [busy, setBusy] = useState<null | Decision>(null)
  const [error, setError] = useState('')
  const decide = async (d: Decision, answers?: Record<string, string>) => {
    setBusy(d)
    setError('')
    try {
      await onDecide(approval.id, d, answers)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the answer')
      setBusy(null)
    }
  }
  const questions = detail?.questions
  const showDetails = !questions && detail?.details && detail.details !== detail.summary
  const appName = detail ? APP_NAME[detail.app] : 'the app'
  return (
    <div className="ap-card" onClick={(e) => e.stopPropagation()} role="group" aria-label={`Approval for ${approval.tool}`}>
      <div className="ap-head">
        <Icon.Shield />
        <span className="ap-title">
          {agentName && <span className="ap-agent">{agentName} · </span>}
          {approval.kind === 'question' ? (
            <>Has a question</>
          ) : (
            <>
              Wants to use <b>{approval.tool}</b>
            </>
          )}
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
          {questions ? (
            <QuestionForm questions={questions} busy={busy === 'allow'} disabled={!!busy || left === 0} onAnswer={(a) => decide('allow', a)} />
          ) : (
            <>
              {detail.description && <p className="ap-desc">{detail.description}</p>}
              {detail.summary && <code className="ap-summary">{detail.summary}</code>}
              {showDetails && (
                <details className="ap-details">
                  <summary>{approval.tool === 'ExitPlanMode' ? 'Plan' : 'Full request'}</summary>
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
            </>
          )}
          {left > 0 && (
            <button className="link-button ap-pass" disabled={!!busy} onClick={() => decide('pass')}>
              {busy === 'pass' ? 'Handing back…' : `Answer in ${appName} instead`}
            </button>
          )}
          {error && <p className="ap-error">{error}</p>}
        </>
      )}
    </div>
  )
}

export interface Settings {
  approvals: Record<'claude' | 'codex', boolean>
}

// Which apps wait for the dashboard before showing their own approval prompt.
export function ApprovalSettings({ settings, hasToken, onUnlock, onChange }: {
  settings: Settings | null
  hasToken: boolean
  onUnlock: (token: string) => void
  onChange: (approvals: Partial<Settings['approvals']>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLSpanElement>(null)
  useDismiss(ref, () => setOpen(false), open)
  const on = settings ? Object.values(settings.approvals).some(Boolean) : false
  const toggle = async (app: 'claude' | 'codex') => {
    if (!settings) return
    setError('')
    try {
      await onChange({ [app]: !settings.approvals[app] })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    }
  }
  return (
    <span className="ap-settings" ref={ref}>
      <button
        className={`tool${on ? ' active' : ''}`}
        aria-expanded={open}
        aria-label="Approvals in the dashboard"
        title="Approvals in the dashboard"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon.Shield />
      </button>
      {open && (
        <div className="ap-settings-pop card" role="dialog" aria-label="Approvals in the dashboard">
          <h2>Approvals in the dashboard</h2>
          <p className="hint">
            When on, an agent's approval requests and questions show up here to answer. Off: the app asks as usual,
            without waiting.
          </p>
          {!hasToken ? (
            <TokenForm onUnlock={onUnlock} />
          ) : (
            settings && (
              <ul>
                {(['claude', 'codex'] as const).map((app) => (
                  <li key={app}>
                    <label>
                      <span>
                        {APP_NAME[app]}
                        <small>
                          {app === 'claude'
                            ? 'Asks in Claude Code at the same time; whichever answers first wins.'
                            : 'Codex waits for the dashboard (up to the wait time) before asking itself.'}
                        </small>
                      </span>
                      <input type="checkbox" role="switch" checked={settings.approvals[app]} onChange={() => toggle(app)} />
                    </label>
                  </li>
                ))}
              </ul>
            )
          )}
          {error && <p className="ap-error">{error}</p>}
        </div>
      )}
    </span>
  )
}
