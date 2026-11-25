import { useEffect, useRef, useState } from 'react'
import { TokenForm } from './Approvals'
import { fmtAgo, fmtCost, fmtDuration } from './format'
import type { Agent } from './sim'
import * as Icon from './Icons'

export type Severity = 'high' | 'medium' | 'low'
const SEVERITIES: Severity[] = ['high', 'medium', 'low']
const SEVERITY_LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' }
const VERDICT_LABEL = { approve: 'Looks good', comment: 'Comments', request_changes: 'Changes needed' } as const
const COVERAGE_LABEL = { yes: 'Covers the ticket', partly: 'Partly covers the ticket', no: "Doesn't cover the ticket", unclear: 'Ticket coverage unclear' } as const
const STATUS_TEXT = { running: 'Reviewing', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' } as const

// What every dashboard viewer gets over the WebSocket.
export interface ReviewSummary {
  id: string
  repo: string
  branch: string
  base: string
  status: keyof typeof STATUS_TEXT
  createdAt: number
  endedAt?: number
  agentId: string
  fix?: { status: FixStatus; agentId: string } // the latest fix of the accepted findings
  uncommitted?: boolean // the review included work that wasn't committed
  verdict?: keyof typeof VERDICT_LABEL
  counts: Record<Severity, number> // findings not dismissed
  total: number
}

interface Hunk {
  header: string
  oldStart: number
  newStart: number
  lines: string[]
}

export interface Finding {
  id: string
  severity: Severity
  category: string
  file?: string
  line?: number
  title: string
  detail?: string
  scenario?: string
  suggestion?: string
  status: 'open' | 'accepted' | 'dismissed'
  hunk?: Hunk
}

// Only with the token: the findings, the ticket, the repo's path.
type FixStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'undone'

// A fix made in your working copy, and exactly what it changed there.
interface Fix {
  status: FixStatus
  agentId: string
  branch: string
  findingIds: string[]
  model?: string
  effort?: string
  startedAt: number
  endedAt?: number
  summary?: string
  error?: string
  cost?: number
  results?: Record<string, { outcome: 'fixed' | 'skipped'; note?: string }>
  files?: { file: string; added: number; removed: number; binary: boolean; patch?: string }[]
  undoable?: boolean
  diffError?: string
}

interface Review extends Omit<ReviewSummary, 'fix'> {
  fix?: Fix
  // What every fix so far fixed (not undone), kept when a later fix runs.
  fixed?: Record<string, { outcome: 'fixed'; note?: string }>
  repoPath: string
  ticket?: string
  stat?: string
  summary?: string
  ticketCoverage?: { addressed: keyof typeof COVERAGE_LABEL; notes?: string }
  findings: Finding[]
  error?: string
  cost?: number
  model?: string
  effort?: string
}

type Api = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>

interface Props {
  token: string
  onUnlock: (t: string) => void
  reviews: ReviewSummary[]
  agents: Map<string, Agent>
  selected: string | null // review id, or null for the new-review form
  prefill?: { sessionId: string; at: number } // "Review changes" on an agent: its repo, branch and uncommitted work
  onSelect: (id: string | null) => void
  onShowAgent: (id: string) => void
}

export default function ReviewView({ token, onUnlock, reviews, agents, selected, onSelect, onShowAgent, prefill }: Props) {
  const api: Api = async (path, init) => {
    const r = await fetch(path, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    })
    if (r.status === 401) {
      onUnlock('')
      throw new Error('The token was not accepted')
    }
    const body = await r.json().catch(() => null)
    if (!r.ok) throw Object.assign(new Error(body?.error ?? `Request failed (${r.status})`), { status: r.status, body })
    return body
  }

  if (!token)
    return (
      <div className="list-view rv">
        <div className="rv-locked card">
          <h2>Reviews</h2>
          <TokenForm onUnlock={onUnlock} />
        </div>
      </div>
    )

  const current = selected ? reviews.find((r) => r.id === selected) : undefined
  return (
    <div className="list-view rv">
      <div className="rv-layout">
        <nav className="rv-side" aria-label="Reviews">
          <button className={`rv-new${!current ? ' active' : ''}`} onClick={() => onSelect(null)}>
            <Icon.Plus /> New review
          </button>
          {reviews.length === 0 && <p className="hint rv-side-empty">Reviews you start show up here.</p>}
          <ul>
            {reviews.map((r) => (
              <li key={r.id}>
                <button className={`rv-item${r.id === current?.id ? ' active' : ''}`} onClick={() => onSelect(r.id)}>
                  <span className={`lv-dot ${r.status === 'running' ? 'working' : r.status === 'done' ? 'completed' : 'ended'}`} />
                  <span className="rv-item-text">
                    <b>
                      {r.branch}
                      {r.uncommitted && <span className="rv-wip" title="Includes uncommitted changes"> + uncommitted</span>}
                    </b>
                    <small>
                      {r.repo} · {r.status === 'running' ? 'Reviewing…' : r.status === 'done' ? fmtAgo(Date.now() - (r.endedAt ?? r.createdAt)) : STATUS_TEXT[r.status]}
                    </small>
                  </span>
                  {r.status === 'done' && <Counts counts={r.counts} />}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="rv-main">
          {current ? (
            <ReviewDetail
              key={current.id}
              summary={current}
              api={api}
              agent={agents.get(current.agentId)}
              fixAgent={current.fix ? agents.get(current.fix.agentId) : undefined}
              onShowAgent={onShowAgent}
              onSelect={onSelect}
            />
          ) : (
            <NewReview api={api} onStarted={onSelect} prefill={prefill} />
          )}
        </main>
      </div>
    </div>
  )
}

function Counts({ counts }: { counts: Record<Severity, number> }) {
  const any = SEVERITIES.some((s) => counts[s])
  if (!any) return <span className="rv-clean" title="No findings"><Icon.Check /></span>
  return (
    <span className="rv-counts">
      {SEVERITIES.filter((s) => counts[s]).map((s) => (
        <span key={s} className={`sev ${s}`} title={`${counts[s]} ${SEVERITY_LABEL[s].toLowerCase()}`}>
          {counts[s]}
        </span>
      ))}
    </span>
  )
}

// --- New review ---

interface Repo {
  path: string
  name: string
  source: 'added' | 'session' // session: a repo your Claude Code or Codex sessions ran in
}
interface Branch {
  name: string
  at: number
  remote?: string | true // true: a remote branch; a name: the local branch's remote, when they differ
  ahead?: number
  behind?: number
}
interface Branches {
  branches: Branch[]
  base: string
  current: string
  hasRemote: boolean
  dirty: number // uncommitted files in the working copy
  fetchedAt?: number
  fetchError?: string
}

const branchLabel = (b: Branch) => {
  if (typeof b.remote !== 'string') return b.name
  const parts = [b.behind ? `${b.behind} behind` : '', b.ahead ? `${b.ahead} ahead` : ''].filter(Boolean)
  return `${b.name}  (${parts.join(', ')} ${b.remote})`
}

function BranchOptions({ branches }: { branches: Branch[] }) {
  const local = branches.filter((b) => b.remote !== true)
  const remote = branches.filter((b) => b.remote === true)
  const opts = (list: Branch[]) =>
    list.map((b) => (
      <option key={b.name} value={b.name}>
        {branchLabel(b)}
      </option>
    ))
  if (!remote.length) return <>{opts(local)}</>
  return (
    <>
      <optgroup label="Local">{opts(local)}</optgroup>
      <optgroup label="Remote">{opts(remote)}</optgroup>
    </>
  )
}

const readPref = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {}
}

// Which model reviews: Sonnet by default (strong on code at half Opus's price), Opus for what matters most.
const MODELS = [
  ['claude-sonnet-5-5', 'Sonnet 5.5', 'Fast and strong on code. A good default.'],
  ['claude-opus-5-5', 'Opus 5.5', 'Most thorough, about twice the cost. For big or important changes.'],
  ['', 'Claude Code default', 'Whatever model your Claude Code uses.'],
] as const
const EFFORTS = [
  ['', 'Default'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
] as const
const modelLabel = (id?: string) => MODELS.find(([m]) => m === (id ?? ''))?.[1] ?? id
const readChoice = <T extends readonly (readonly [string, ...string[]])[]>(key: string, list: T, fallback: string) => {
  const v = readPref(key)
  return v !== null && list.some(([k]) => k === v) ? v : fallback
}

let prefillApplied = 0 // a prefill is used once, not again when the form opens later

function NewReview({ api, onStarted, prefill }: { api: Api; onStarted: (id: string) => void; prefill?: Props['prefill'] }) {
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [repo, setRepo] = useState(() => readPref('ac.reviewRepo') ?? '')
  const [adding, setAdding] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [info, setInfo] = useState<Branches | null>(null)
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('')
  const [ticket, setTicket] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [withUncommitted, setWithUncommitted] = useState(true)
  const [model, setModel] = useState(() => readChoice('ac.reviewModel', MODELS, 'claude-sonnet-5-5'))
  const [effort, setEffort] = useState(() => readChoice('ac.reviewEffort', EFFORTS, ''))
  // Set by "Review changes": in that repo, pick the checked-out branch. Picking another repo or
  // branch yourself ends it.
  const preferCurrent = useRef<string | null>(null)

  // "Review changes" on an agent: its repository, the branch it's on, and what isn't committed.
  useEffect(() => {
    if (!prefill || prefill.at <= prefillApplied) return
    prefillApplied = prefill.at
    api<{ repo: string }>(`/api/review/session/${encodeURIComponent(prefill.sessionId)}`).then(
      (r) => {
        preferCurrent.current = r.repo
        setWithUncommitted(true)
        setBranch('')
        if (r.repo === repo) void loadBranches(false)
        else setRepo(r.repo)
      },
      (e) => setError(e.message),
    )
  }, [prefill?.at]) // eslint-disable-line react-hooks/exhaustive-deps

  // New sessions add repos to the list, so keep it fresh while the form is open.
  useEffect(() => {
    let stale = false
    const load = () =>
      api<Repo[]>('/api/review/repos').then((list) => {
        if (stale) return
        setRepos((old) => (JSON.stringify(old) === JSON.stringify(list) ? old : list))
        setRepo((r) => (list.some((x) => x.path === r) ? r : (list.find((x) => x.source === 'session') ?? list[0])?.path ?? ''))
      }, (e) => !stale && setError(e.message))
    load()
    const t = setInterval(load, 5000)
    window.addEventListener('focus', load)
    return () => {
      stale = true
      clearInterval(t)
      window.removeEventListener('focus', load)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!repo) return setInfo(null)
    writePref('ac.reviewRepo', repo)
    setInfo(null)
    setError('')
    let stale = false
    // What's there now at once, then again after fetching the remotes.
    void loadBranches(false, () => stale).then(() => {
      if (!stale) void loadBranches(true, () => stale)
    })
    return () => {
      stale = true
    }
  }, [repo]) // eslint-disable-line react-hooks/exhaustive-deps

  const [fetching, setFetching] = useState(false)
  const [baseTouched, setBaseTouched] = useState(false)
  const loadBranches = async (fetch: boolean | 'force', isStale: () => boolean = () => false) => {
    if (fetch) setFetching(true)
    try {
      const q = fetch ? `&fetch=${fetch === 'force' ? 'force' : '1'}` : ''
      const b = await api<Branches>(`/api/review/branches?repo=${encodeURIComponent(repo)}${q}`)
      if (isStale()) return
      const has = (n: string) => b.branches.some((x) => x.name === n)
      setInfo(b)
      // Keep what you picked if it still exists; otherwise the defaults.
      setBase((cur) => (baseTouched && has(cur) ? cur : b.base))
      const onCurrent = !!b.current && has(b.current)
      setBranch((cur) =>
        preferCurrent.current === repo && onCurrent
          ? b.current
          : cur && has(cur) && (cur !== b.base || (cur === b.current && b.dirty > 0))
            ? cur
            : // The branch you're on (with uncommitted work, even if it's the base), else the most recently changed one.
              onCurrent && (b.current !== b.base || b.dirty > 0)
              ? b.current
              : (b.branches.find((x) => x.name !== b.base && x.name !== b.base.replace(/^[^/]+\//, ''))?.name ?? ''),
      )
    } catch (e) {
      if (!isStale()) setError((e as Error).message)
    } finally {
      if (fetch && !isStale()) setFetching(false)
    }
  }

  const addRepo = async () => {
    setError('')
    try {
      const r = await api<{ added: string; repos: Repo[] }>('/api/review/repos', { method: 'POST', body: { path: newPath.trim() } })
      setRepos(r.repos)
      setRepo(r.added)
      setNewPath('')
      setAdding(false)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await api<{ id: string }>('/api/reviews', {
        method: 'POST',
        body: { repo, branch, base, ticket, model, effort, includeUncommitted: canIncludeUncommitted && withUncommitted },
      })
      setTicket('')
      onStarted(r.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const names = info?.branches.map((b) => b.name) ?? []
  // Work in progress can be included for the branch that is checked out.
  const canIncludeUncommitted = !!info && info.dirty > 0 && branch === info.current
  const uncommittedOnly = canIncludeUncommitted && withUncommitted // then the branch may be the base itself
  return (
    <form
      className="rv-form card"
      onSubmit={(e) => {
        e.preventDefault()
        if (repo && branch && base) void start()
      }}
    >
      <h2>New review</h2>
      <p className="hint">
        A read-only Claude Code agent reviews the branch's changes in a separate checkout and reports what it finds here.
        Your working copy isn't touched.
      </p>

      <label className="rv-field">
        <span>Repository</span>
        <div className="rv-row">
          <select
            value={repo}
            onChange={(e) => {
              preferCurrent.current = null
              setRepo(e.target.value)
            }}
            disabled={!repos?.length}
          >
            {!repos?.length && <option value="">{repos ? 'Waiting for a session…' : 'Loading…'}</option>}
            {(['session', 'added'] as const).map((src) => {
              const list = repos?.filter((r) => r.source === src) ?? []
              // The same name twice (two clones): show the parent folder too.
              const label = (r: Repo) =>
                repos!.filter((x) => x.name === r.name).length > 1 ? `${r.name} (${r.path.split('/').slice(-2, -1)[0]})` : r.name
              return (
                list.length > 0 && (
                  <optgroup key={src} label={src === 'session' ? 'From your sessions' : 'Added by you'}>
                    {list.map((r) => (
                      <option key={r.path} value={r.path} title={r.path}>
                        {label(r)}
                      </option>
                    ))}
                  </optgroup>
                )
              )
            })}
          </select>
          <button type="button" className="panel-button" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            <Icon.Plus /> Add
          </button>
        </div>
      </label>
      {repo ? (
        <p className="hint rv-path">{repo}</p>
      ) : (
        repos?.length === 0 && (
          <p className="hint rv-empty">
            Repositories show up here by themselves once a Claude Code or Codex session does something in them, or add one by
            its path.
          </p>
        )
      )}
      {adding && (
        <div className="rv-row rv-add">
          <input
            placeholder="/Users/you/projects/my-repo"
            value={newPath}
            spellCheck={false}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (newPath.trim()) void addRepo()
              }
            }}
          />
          <button type="button" className="panel-button" disabled={!newPath.trim()} onClick={addRepo}>
            Add repository
          </button>
        </div>
      )}

      <div className="rv-two">
        <label className="rv-field">
          <span>Branch to review</span>
          <select
            value={branch}
            onChange={(e) => {
              preferCurrent.current = null
              setBranch(e.target.value)
            }}
            disabled={!info}
          >
            <BranchOptions branches={info?.branches ?? []} />
          </select>
        </label>
        <label className="rv-field">
          <span>Compared with</span>
          <select
            value={base}
            onChange={(e) => {
              setBase(e.target.value)
              setBaseTouched(true)
            }}
            disabled={!info}
          >
            <BranchOptions branches={info?.branches ?? []} />
          </select>
        </label>
      </div>
      {(() => {
        const picked = info?.branches.find((b) => b.name === branch)
        const old = picked && typeof picked.remote === 'string' && picked.behind
        return (
          <div className="rv-remote">
            {old ? (
              <span className="rv-warn">
                Your local {picked.name} is {picked.behind} commit{picked.behind === 1 ? '' : 's'} behind {picked.remote as string}.{' '}
                <button type="button" className="link-button" onClick={() => setBranch(picked.remote as string)}>
                  Review {picked.remote as string} instead
                </button>
              </span>
            ) : null}
            {info?.hasRemote && (
              <span className="hint">
                {fetching
                  ? 'Fetching from the remote…'
                  : info.fetchError
                    ? `Could not fetch (${info.fetchError}), showing what was fetched last.`
                    : info.fetchedAt
                      ? `Remote branches fetched ${fmtAgo(Date.now() - info.fetchedAt)}.`
                      : ''}
                {!fetching && (
                  <button type="button" className="link-button" onClick={() => loadBranches('force')}>
                    Fetch now
                  </button>
                )}
              </span>
            )}
          </div>
        )
      })()}

      <div className="rv-two">
        <label className="rv-field">
          <span>Model</span>
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value)
              writePref('ac.reviewModel', e.target.value)
            }}
            title={MODELS.find(([m]) => m === model)?.[2]}
          >
            {MODELS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <small className="rv-sub">{MODELS.find(([m]) => m === model)?.[2]}</small>
        </label>
        <label className="rv-field">
          <span>Effort</span>
          <select
            value={effort}
            onChange={(e) => {
              setEffort(e.target.value)
              writePref('ac.reviewEffort', e.target.value)
            }}
          >
            {EFFORTS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <small className="rv-sub">How long it thinks. Higher finds more, costs more.</small>
        </label>
      </div>

      {canIncludeUncommitted && (
        <label className="rv-check">
          <input type="checkbox" checked={withUncommitted} onChange={(e) => setWithUncommitted(e.target.checked)} />
          <span>
            Include uncommitted changes{' '}
            <small>
              {info.dirty} file{info.dirty === 1 ? '' : 's'} changed in your working copy, reviewed as they are now
            </small>
          </span>
        </label>
      )}

      <label className="rv-field">
        <span>
          Ticket <small>optional</small>
        </span>
        <textarea
          rows={6}
          value={ticket}
          onChange={(e) => setTicket(e.target.value)}
          placeholder="Paste the ticket's title and description. The reviewer also checks whether the change does what it asks."
        />
      </label>

      {error && <p className="ap-error">{error}</p>}
      <div className="rv-actions">
        <button type="submit" className="ap-allow rv-start" disabled={busy || !repo || !branch || !base || (branch === base && !uncommittedOnly)}>
          {busy ? 'Starting…' : 'Start review'}
        </button>
        {info && names.length < 2 && !uncommittedOnly ? (
          <span className="hint">{names.length ? `This repository only has one branch (${names[0]}).` : 'This repository has no branches yet.'} Create a branch to review it.</span>
        ) : (
          branch && branch === base && !uncommittedOnly && <span className="hint">Pick two different branches.</span>
        )}
      </div>
    </form>
  )
}

// --- One review ---

function ReviewDetail({ summary, api, agent, fixAgent, onShowAgent, onSelect }: {
  summary: ReviewSummary
  api: Api
  agent?: Agent
  fixAgent?: Agent
  onShowAgent: (id: string) => void
  onSelect: (id: string | null) => void
}) {
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Severity | 'all'>('all')
  const [showDismissed, setShowDismissed] = useState(false)
  // Most serious first by default; by file is handier while fixing.
  const [order, setOrder] = useState<'severity' | 'file'>(() => (readPref('ac.reviewOrder') === 'file' ? 'file' : 'severity'))
  const changeOrder = (o: 'severity' | 'file') => {
    setOrder(o)
    writePref('ac.reviewOrder', o)
  }
  const [copied, setCopied] = useState(false)
  const [fixOpen, setFixOpen] = useState(false)
  const [, tick] = useState(0)

  // Start, stop or undo the fix. A 409 means another session works in the repo: ask first.
  const fixAction = async (path: '' | '/cancel' | '/undo', body: Record<string, unknown> = {}) => {
    setError('')
    try {
      setReview(await api<Review>(`/api/reviews/${summary.id}/fix${path}`, { method: 'POST', body }))
      setFixOpen(false)
    } catch (e) {
      const err = e as Error & { status?: number; body?: { busy?: { name: string }[] } }
      if (path === '' && err.status === 409) {
        const names = err.body?.busy?.map((b) => b.name).join(', ') ?? 'Another session'
        const go = window.confirm(`${names} is working in this repository right now. Two agents editing the same files can get in each other's way.\n\nFix anyway?`)
        if (go) return fixAction('', { ...body, force: true })
        return
      }
      setError(err.message)
    }
  }

  // Fetch again whenever the summary says something changed.
  const version = `${summary.status}|${summary.endedAt}|${JSON.stringify(summary.counts)}|${summary.fix?.status}`
  useEffect(() => {
    api<Review>(`/api/reviews/${summary.id}`).then(setReview, (e) => setError(e.message))
  }, [summary.id, version]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (summary.status !== 'running' && summary.fix?.status !== 'running') return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [summary.status, summary.fix?.status])

  const setStatus = async (f: Finding, status: Finding['status']) => {
    try {
      setReview(await api<Review>(`/api/reviews/${summary.id}/findings/${f.id}`, { method: 'POST', body: { status } }))
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const cancel = () => api(`/api/reviews/${summary.id}`, { method: 'POST', body: { cancel: true } }).catch((e) => setError(e.message))
  const remove = async () => {
    try {
      await api(`/api/reviews/${summary.id}`, { method: 'DELETE' })
      onSelect(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const again = async () => {
    if (!review) return
    try {
      const r = await api<{ id: string }>('/api/reviews', {
        method: 'POST',
        body: {
          repo: review.repoPath,
          branch: review.branch,
          base: review.base,
          ticket: review.ticket,
          model: review.model ?? '',
          effort: review.effort ?? '',
          includeUncommitted: review.uncommitted ? 'auto' : false,
        },
      })
      onSelect(r.id)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const findings = review?.findings ?? []
  const dismissed = findings.filter((f) => f.status === 'dismissed').length
  const shown = findings.filter((f) => (showDismissed || f.status !== 'dismissed') && (filter === 'all' || f.severity === filter))
  // The server sends findings most serious first, so each group keeps that order.
  const groups = new Map<string, Finding[]>()
  for (const f of shown) {
    const key = order === 'file' ? (f.file ?? 'General') : f.severity
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  const accepted = findings.filter((f) => f.status === 'accepted')
  // What a new fix would take on: accepted, and not already fixed by an earlier fix.
  const lastFix = review?.fix && review.fix.status !== 'undone' ? review.fix : undefined
  const toFix = accepted.filter((f) => !review?.fixed?.[f.id])

  const copyAccepted = async () => {
    const lines = [`Fix these review findings on branch ${summary.branch}:`, '']
    for (const f of accepted) {
      lines.push(`- [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}: ` : ''}${f.title}`)
      if (f.detail) lines.push(`  ${f.detail}`)
      if (f.scenario) lines.push(`  Fails when: ${f.scenario}`)
      if (f.suggestion) lines.push(`  Suggested fix: ${f.suggestion}`)
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy to the clipboard')
    }
  }

  const end = summary.endedAt ?? Date.now()
  const cost = review?.cost ?? agent?.cost
  return (
    <div className="rv-detail">
      <header className="rv-head card">
        <div className="rv-title">
          <h2>
            <Icon.Branch /> {summary.branch}
            {summary.uncommitted && <span className="rv-wip-badge">+ uncommitted</span>}
            <span className="rv-base">→ {summary.base}</span>
          </h2>
          <div className="rv-meta">
            <span>{summary.repo}</span>
            {review?.stat && <span>{review.stat}</span>}
            <span>{summary.status === 'running' ? `Running ${fmtDuration(end - summary.createdAt)}` : `Took ${fmtDuration(end - summary.createdAt)}`}</span>
            {review && (
              <span>
                {modelLabel(review.model)}
                {review.effort ? `, ${review.effort} effort` : ''}
              </span>
            )}
            {cost != null && <span>{fmtCost(cost)} est.</span>}
          </div>
        </div>
        <div className="rv-head-actions">
          {summary.status === 'done' && summary.verdict && <span className={`rv-verdict ${summary.verdict}`}>{VERDICT_LABEL[summary.verdict]}</span>}
          {summary.status !== 'done' && <span className={`rv-state ${summary.status}`}>{STATUS_TEXT[summary.status]}</span>}
          {agent && (
            <button className="panel-button" onClick={() => onShowAgent(agent.id)} title="Show the review agent's session">
              <Icon.Eye /> Agent
            </button>
          )}
          {summary.status === 'running' ? (
            <button className="panel-button" onClick={cancel}>
              Stop
            </button>
          ) : (
            <>
              <button className="panel-button" onClick={again} disabled={!review} title="Review the branch again, with the same ticket">
                Run again
              </button>
              <button className="panel-button" onClick={remove} title="Delete this review">
                Delete
              </button>
            </>
          )}
        </div>
      </header>

      {error && <p className="ap-error">{error}</p>}

      {summary.status === 'running' && (
        <div className="rv-running card">
          <span className="rv-spinner" aria-hidden="true" />
          <div>
            <b>Reviewing the changes…</b>
            <p className="hint">{agent?.task || 'Starting the review agent'}{agent?.toolCalls ? ` · ${agent.toolCalls} tool calls` : ''}</p>
          </div>
        </div>
      )}

      {(summary.status === 'failed' || summary.status === 'cancelled') && (
        <div className="rv-failed card">
          <b>{summary.status === 'failed' ? 'The review failed' : 'The review was stopped'}</b>
          {review?.error && <pre>{review.error}</pre>}
        </div>
      )}

      {review?.summary && (
        <section className="rv-summary card">
          <p>
            <Prose text={review.summary} />
          </p>
          {review.ticketCoverage && (
            <div className={`rv-ticket ${review.ticketCoverage.addressed}`}>
              <b>{COVERAGE_LABEL[review.ticketCoverage.addressed]}</b>
              {review.ticketCoverage.notes && (
                <p>
                  <Prose text={review.ticketCoverage.notes} />
                </p>
              )}
            </div>
          )}
          {review.ticket && (
            <details className="rv-ticket-text">
              <summary>Ticket</summary>
              <pre>{review.ticket}</pre>
            </details>
          )}
        </section>
      )}

      {review?.fix && (
        <FixCard
          fix={review.fix}
          agent={fixAgent}
          findings={findings}
          onStop={() => fixAction('/cancel')}
          onUndo={() => {
            if (window.confirm('Undo the fix? This takes back exactly the changes it made. Your own changes stay.')) void fixAction('/undo')
          }}
          onReviewAgain={again}
          onShowAgent={onShowAgent}
        />
      )}

      {summary.status === 'done' && (
        <>
          <div className="rv-toolbar">
            <span className="app-filter card" role="group" aria-label="Severity">
              <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                All <small>{findings.filter((f) => showDismissed || f.status !== 'dismissed').length}</small>
              </button>
              {SEVERITIES.map((s) => (
                <button key={s} aria-pressed={filter === s} onClick={() => setFilter(s)}>
                  <i className={`sev-dot ${s}`} /> {SEVERITY_LABEL[s]}{' '}
                  <small>{findings.filter((f) => f.severity === s && (showDismissed || f.status !== 'dismissed')).length}</small>
                </button>
              ))}
            </span>
            {dismissed > 0 && (
              <button className="link-button" onClick={() => setShowDismissed((v) => !v)}>
                {showDismissed ? 'Hide' : 'Show'} {dismissed} dismissed
              </button>
            )}
            <span className="rv-spacer" />
            <span className="app-filter card rv-order" role="group" aria-label="Group findings by">
              <button aria-pressed={order === 'severity'} onClick={() => changeOrder('severity')} title="Most serious first">
                Severity
              </button>
              <button aria-pressed={order === 'file'} onClick={() => changeOrder('file')} title="Grouped by file">
                File
              </button>
            </span>
            {accepted.length > 0 && (
              <button className="panel-button" onClick={copyAccepted} title="Copy the accepted findings as a prompt to paste into a coding session">
                {copied ? <><Icon.Check /> Copied</> : 'Copy as prompt'}
              </button>
            )}
            {findings.length > 0 && review?.fix?.status !== 'running' && (
              // Always there, so you know it exists: it works on the findings you accept.
              <button
                className="ap-allow rv-fix-button"
                disabled={!toFix.length}
                onClick={() => setFixOpen((v) => !v)}
                aria-expanded={fixOpen}
                title={
                  toFix.length
                    ? 'An agent fixes the accepted findings in your working copy'
                    : accepted.length
                      ? 'The accepted findings are already fixed'
                      : 'Accept the findings you want fixed, then fix them here'
                }
              >
                <Icon.Wrench /> {toFix.length ? `Fix ${toFix.length} accepted` : 'Fix'}
              </button>
            )}
          </div>
          {findings.length > 0 && !toFix.length && !accepted.length && (
            <p className="hint rv-fix-hint">Press Accept on the findings you want fixed, then Fix lets an agent fix them in your working copy.</p>
          )}
          {fixOpen && toFix.length > 0 && (
            <FixStart
              branch={summary.branch}
              count={toFix.length}
              replaces={!!lastFix?.files?.length}
              onStart={(model, effort) => fixAction('', { model, effort })}
              onCancel={() => setFixOpen(false)}
            />
          )}

          {findings.length === 0 ? (
            <div className="rv-none card">
              <Icon.Check />
              <p>No findings. The reviewer didn't find anything worth reporting.</p>
            </div>
          ) : shown.length === 0 ? (
            <p className="hint rv-pad">Nothing matches this filter.</p>
          ) : (
            [...groups].map(([key, list]) => (
              <section key={key} className="rv-file">
                {order === 'file' ? (
                  <h3>
                    <Icon.Code /> {key} <small>{list.length}</small>
                  </h3>
                ) : (
                  <h3 className="rv-sev-head">
                    <i className={`sev-dot ${key}`} /> {SEVERITY_LABEL[key as Severity]} <small>{list.length}</small>
                  </h3>
                )}
                {list.map((f) => (
                  <FindingCard
                    key={f.id}
                    f={f}
                    showFile={order === 'severity'}
                    fixed={review?.fixed?.[f.id] ?? lastFix?.results?.[f.id]}
                    onStatus={(s) => setStatus(f, s)}
                  />
                ))}
              </section>
            ))
          )}
        </>
      )}
    </div>
  )
}

function FindingCard({ f, showFile, fixed, onStatus }: {
  f: Finding
  showFile: boolean
  fixed?: { outcome: 'fixed' | 'skipped'; note?: string }
  onStatus: (s: Finding['status']) => void
}) {
  const dismissed = f.status === 'dismissed'
  const toggle = (s: 'accepted' | 'dismissed') => onStatus(f.status === s ? 'open' : s)
  return (
    <article className={`rv-finding card ${f.severity} ${f.status}`}>
      <div className="rv-f-head">
        <span className={`sev-badge ${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
        <span className="rv-cat">{f.category}</span>
        <h4>
          <Prose text={f.title} />
        </h4>
        {fixed && (
          <span className={`rv-fixed ${fixed.outcome}`} title={fixed.note}>
            {fixed.outcome === 'fixed' ? 'Fixed by agent' : 'Skipped by agent'}
          </span>
        )}
        {showFile && f.file ? (
          <code className="rv-loc" title={f.file}>
            {f.file}
            {f.line ? `:${f.line}` : ''}
          </code>
        ) : (
          f.line && <code className="rv-loc">:{f.line}</code>
        )}
      </div>
      {!dismissed && (
        <>
          {f.detail && (
            <p className="rv-f-detail">
              <Prose text={f.detail} />
            </p>
          )}
          {f.scenario && (
            <div className="rv-f-block">
              <span>What goes wrong</span>
              <p>
                <Prose text={f.scenario} />
              </p>
            </div>
          )}
          {f.suggestion && (
            <div className="rv-f-block">
              <span>Suggested fix</span>
              <p>
                <Prose text={f.suggestion} />
              </p>
            </div>
          )}
          {f.hunk && <HunkView hunk={f.hunk} line={f.line} />}
        </>
      )}
      <div className="rv-f-actions">
        <button className="rv-act accept" aria-pressed={f.status === 'accepted'} onClick={() => toggle('accepted')}>
          <Icon.Check /> {f.status === 'accepted' ? 'Accepted' : 'Accept'}
        </button>
        <button className="rv-act dismiss" aria-pressed={dismissed} onClick={() => toggle('dismissed')}>
          <Icon.Close /> {dismissed ? 'Dismissed' : 'Dismiss'}
        </button>
      </div>
    </article>
  )
}

// Which model fixes and how hard it thinks, then go. Remembered like the review's choice.
function FixStart({ branch, count, replaces, onStart, onCancel }: {
  branch: string
  count: number
  replaces: boolean // the last fix's changes are still in place
  onStart: (model: string, effort: string) => Promise<void> | void
  onCancel: () => void
}) {
  const [model, setModel] = useState(() => readChoice('ac.fixModel', MODELS, 'claude-sonnet-5-5'))
  const [effort, setEffort] = useState(() => readChoice('ac.fixEffort', EFFORTS, ''))
  const [busy, setBusy] = useState(false)
  return (
    <div className="rv-fix-start card">
      <p>
        An agent fixes the {count} accepted finding{count === 1 ? '' : 's'} in your working copy on <b>{branch}</b>. It can only
        edit files: no commands, no commits, no branch switching. You see exactly what it changed afterwards, and can undo it.
      </p>
      {replaces && (
        <p className="rv-warn">
          The last fix's changes stay in your working copy, but after this you can only undo the new fix from here.
        </p>
      )}
      <div className="rv-fix-row">
        <select
          value={model}
          aria-label="Model"
          onChange={(e) => {
            setModel(e.target.value)
            writePref('ac.fixModel', e.target.value)
          }}
        >
          {MODELS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={effort}
          aria-label="Effort"
          onChange={(e) => {
            setEffort(e.target.value)
            writePref('ac.fixEffort', e.target.value)
          }}
        >
          {EFFORTS.map(([id, label]) => (
            <option key={id} value={id}>
              {id ? `${label} effort` : 'Default effort'}
            </option>
          ))}
        </select>
        <span className="rv-spacer" />
        <button className="panel-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="ap-allow rv-fix-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await onStart(model, effort)
            setBusy(false)
          }}
        >
          {busy ? 'Starting…' : 'Start fix'}
        </button>
      </div>
    </div>
  )
}

const FIX_TITLE: Record<FixStatus, string> = {
  running: 'Fixing…',
  done: 'Fix done',
  failed: 'The fix failed',
  cancelled: 'The fix was stopped',
  undone: 'Fix undone',
}

function FixCard({ fix, agent, findings, onStop, onUndo, onReviewAgain, onShowAgent }: {
  fix: Fix
  agent?: Agent
  findings: Finding[]
  onStop: () => void
  onUndo: () => void
  onReviewAgain: () => void
  onShowAgent: (id: string) => void
}) {
  const files = fix.files ?? []
  const fixedCount = Object.values(fix.results ?? {}).filter((r) => r.outcome === 'fixed').length
  const skipped = Object.entries(fix.results ?? {}).filter(([, r]) => r.outcome === 'skipped')
  const title = (id: string) => findings.find((f) => f.id === id)?.title ?? id
  const end = fix.endedAt ?? Date.now()
  return (
    <section className={`rv-fix card ${fix.status}`}>
      <div className="rv-fix-head">
        {fix.status === 'running' ? <span className="rv-spinner" aria-hidden="true" /> : <Icon.Wrench />}
        <div className="rv-fix-title">
          <b>{FIX_TITLE[fix.status]}</b>
          <small>
            {fix.findingIds.length} finding{fix.findingIds.length === 1 ? '' : 's'} on {fix.branch}
            {' · '}
            {modelLabel(fix.model)}
            {fix.status === 'running' ? ` · ${fmtDuration(end - fix.startedAt)}` : ` · took ${fmtDuration(end - fix.startedAt)}`}
            {fix.cost != null && ` · ${fmtCost(fix.cost)} est.`}
          </small>
        </div>
        <span className="rv-spacer" />
        {agent && (
          <button className="panel-button" onClick={() => onShowAgent(agent.id)}>
            <Icon.Eye /> Agent
          </button>
        )}
        {fix.status === 'running' ? (
          <button className="panel-button" onClick={onStop}>
            Stop
          </button>
        ) : (
          <>
            {fix.status !== 'undone' && files.length > 0 && fix.undoable && (
              <button className="panel-button" onClick={onUndo} title="Take back exactly the changes this fix made">
                Undo fix
              </button>
            )}
            {fix.status !== 'undone' && files.length > 0 && (
              <button className="ap-allow rv-fix-button" onClick={onReviewAgain} title="Review the branch again, with the fix">
                Review again
              </button>
            )}
          </>
        )}
      </div>

      {fix.status === 'running' && <p className="hint">{agent?.task || 'Starting the fix agent'}</p>}
      {fix.summary && fix.status !== 'running' && (
        <p className="rv-fix-summary">
          <Prose text={fix.summary} />
          {fix.results && ` (${fixedCount} fixed${skipped.length ? `, ${skipped.length} skipped` : ''})`}
        </p>
      )}
      {fix.error && <pre className="rv-fix-error">{fix.error}</pre>}
      {fix.diffError && <p className="ap-error">{fix.diffError}</p>}
      {skipped.length > 0 && fix.status !== 'undone' && (
        <ul className="rv-skipped">
          {skipped.map(([id, r]) => (
            <li key={id}>
              <b>Skipped: {title(id)}</b> {r.note && <span>{r.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {fix.status !== 'running' && fix.status !== 'undone' && (
        <div className="rv-fix-files">
          {files.length === 0 ? (
            <p className="hint">The fix didn't change any files.</p>
          ) : (
            <>
              <p className="hint">
                Changed in your working copy, not committed. Only the fix's own edits are shown, not your other uncommitted work.
                {!fix.undoable && ' This fix is too big to undo from here.'}
              </p>
              {files.map((f) => (
                <details key={f.file} className="rv-fix-file">
                  <summary>
                    <code>{f.file}</code>
                    <span className="rv-plus">+{f.added}</span>
                    <span className="rv-minus">−{f.removed}</span>
                  </summary>
                  {f.binary ? <p className="hint">Binary file</p> : <PatchView patch={f.patch ?? ''} />}
                </details>
              ))}
            </>
          )}
        </div>
      )}
      {fix.status === 'undone' && <p className="hint">The fix's changes were taken back. Your own changes are as they were.</p>}
    </section>
  )
}

// A unified diff for one file, without the git headers.
function PatchView({ patch }: { patch: string }) {
  // Drop git's headers, which come before the first @@. After that, a line like "--- x" is a
  // removed line that started with "-- ", not a header.
  const all = patch.split('\n')
  const lines = all.slice(Math.max(0, all.findIndex((l) => l.startsWith('@@')))).filter(Boolean)
  return (
    <div className="rv-hunk rv-patch">
      <table>
        <tbody>
          {lines.map((l, i) => {
            const kind = l.startsWith('@@') ? 'hdr' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx'
            return (
              <tr key={i} className={kind}>
                <td className="sign">{kind === 'add' ? '+' : kind === 'del' ? '−' : ''}</td>
                <td className="code">{kind === 'hdr' ? l : l.slice(1) || ' '}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// `code` in the agent's prose, shown as code.
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`\n]+`)/).map((part, i) =>
        part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part,
      )}
    </>
  )
}

const CONTEXT = 5 // lines shown around the finding's line before you expand the hunk

function HunkView({ hunk, line }: { hunk: Hunk; line?: number }) {
  const [all, setAll] = useState(false)
  let o = hunk.oldStart
  let n = hunk.newStart
  const rows = hunk.lines.map((l) => {
    const kind = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx'
    const row = { kind, text: l.slice(1), old: kind === 'add' ? null : o, nw: kind === 'del' ? null : n }
    if (kind !== 'add') o++
    if (kind !== 'del') n++
    return row
  })
  const at = line ? rows.findIndex((r) => r.nw === line) : -1
  const from = at < 0 || all ? 0 : Math.max(0, at - CONTEXT)
  const to = at < 0 || all ? rows.length : Math.min(rows.length, at + CONTEXT + 1)
  const hidden = rows.length - (to - from)
  return (
    <div className="rv-hunk" role="figure" aria-label="Diff">
      <div className="rv-hunk-head">
        <span>{hunk.header}</span>
        {(hidden > 0 || all) && at >= 0 && (
          <button className="link-button" onClick={() => setAll((v) => !v)}>
            {all ? 'Show less' : `Show ${hidden} more lines`}
          </button>
        )}
      </div>
      <table>
        <tbody>
          {rows.slice(from, to).map((r, i) => (
            <tr key={i} className={`${r.kind}${line && r.nw === line ? ' target' : ''}`}>
              <td className="ln">{r.old ?? ''}</td>
              <td className="ln">{r.nw ?? ''}</td>
              <td className="sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</td>
              <td className="code">{r.text || ' '}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
