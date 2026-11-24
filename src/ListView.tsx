import { useState } from 'react'
import type { Agent } from './sim'
import { STATUS_LABEL } from './sim'
import { APP_LABEL, TOKENS_NOTE, appOf, fmtCost, fmtDuration, fmtTokens, modelName, newTokens, sumUsage, totalTokens, withDescendants } from './format'
import * as Icon from './Icons'

const statusLabel = (a: Agent) => (a.ended ? 'Ended' : a.attention ? 'Needs approval' : STATUS_LABEL[a.status])
const statusClass = (a: Agent) => `${a.status}${a.attention ? ' attention' : ''}${a.ended ? ' ended' : ''}`

interface Props {
  agents: Agent[] // what's on the dashboard, already filtered
  selected: string | null
  now: number
  onSelect: (id: string) => void
  approvalCards: (agentIds: string[], named: boolean) => React.ReactNode
}

function Dot({ agent }: { agent: Agent }) {
  return <i className={`lv-dot ${statusClass(agent)}`} aria-hidden="true" />
}

function SubagentRows({ parent, agents, selected, onSelect, level }: { parent: Agent; agents: Agent[]; selected: string | null; onSelect: (id: string) => void; level: number }) {
  const children = agents.filter((a) => a.parentId === parent.id).sort((a, b) => a.startedAt - b.startedAt)
  return (
    <>
      {children.map((c) => {
        const tokens = totalTokens(c.tokens)
        return (
          <li key={c.id}>
            <button
              className={`lv-sub${c.id === selected ? ' selected' : ''}`}
              style={{ paddingLeft: 12 + level * 20 }}
              onClick={() => onSelect(c.id)}
              title={c.task || c.name}
            >
              <Dot agent={c} />
              <span className="lv-sub-name">{c.name}</span>
              <span className={`lv-status ${statusClass(c)}`}>{statusLabel(c)}</span>
              <span className="lv-sub-meta">
                {tokens ? fmtTokens(newTokens(c.tokens)) : '—'}
                {typeof c.cost === 'number' && ` · ${fmtCost(c.cost, c.costPartial)}`}
              </span>
            </button>
            <SubagentRows parent={c} agents={agents} selected={selected} onSelect={onSelect} level={level + 1} />
          </li>
        )
      })}
    </>
  )
}

function Metric({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="lv-metric" title={title}>
      <span>{label}</span>
      <b>{children}</b>
    </div>
  )
}

function Session({ root, agents, open, onToggle, selected, now, onSelect, approvalCards }: { root: Agent; agents: Agent[]; open: boolean; onToggle: () => void; selected: string | null; now: number; onSelect: (id: string) => void; approvalCards: Props['approvalCards'] }) {
  const family = withDescendants(root, agents)
  const subs = family.length - 1
  const activeSubs = family.filter((a) => a !== root && a.status !== 'completed' && !a.ended).length
  const usage = sumUsage(family)
  const total = totalTokens(usage.tokens)
  const app = appOf(root)
  const end = root.endedAt ?? now
  const contextPct = root.contextTokens && root.contextWindow ? Math.min(100, (root.contextTokens / root.contextWindow) * 100) : null
  const bodyId = `lv-body-${root.id}`
  // Shown whether or not the row is expanded: an approval shouldn't hide behind a click.
  const cards = approvalCards(family.map((a) => a.id), family.length > 1)

  return (
    <li className={`lv-session card ${statusClass(root)}${open ? ' open' : ''}${root.id === selected ? ' selected' : ''}`}>
      <button className="lv-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="lv-chevron"><Icon.Chevron /></span>
        <Dot agent={root} />
        <span className="lv-title">
          <span className="lv-name" title={root.name}>{root.name}</span>
          <span className="lv-sub-line">
            {[app ? APP_LABEL[app] : null, root.model ? modelName(root.model) : null, root.branch].filter(Boolean).join('  ·  ')}
          </span>
        </span>
        <span className={`lv-status ${statusClass(root)}`}>{statusLabel(root)}</span>
        <span className="lv-cols">
          <span title="Subagents (active)">
            <Icon.Branch /> {subs}
            {activeSubs > 0 && <small> ({activeSubs})</small>}
          </span>
          <span title={TOKENS_NOTE}>
            <Icon.Layers /> {total ? fmtTokens(newTokens(usage.tokens)) : '—'}
          </span>
          <span title="Estimated cost, with subagents">
            <Icon.Dollar /> {fmtCost(usage.cost, usage.costPartial).replace('$', '')}
          </span>
          <span title={root.endedAt ? 'Ran for' : 'Running'}>
            <Icon.Clock /> {fmtDuration(end - root.startedAt)}
          </span>
        </span>
      </button>

      {cards && <div className="lv-approvals">{cards}</div>}

      {open && (
        <div className="lv-body" id={bodyId}>
          {root.task && <p className="lv-task">{root.task}</p>}
          <div className="lv-metrics">
            <Metric label="Model" title={root.model}>
              {modelName(root.model)}
              {root.effort && <small>{root.effort}</small>}
            </Metric>
            <Metric label="Tokens" title={TOKENS_NOTE}>
              {total ? `${fmtTokens(newTokens(usage.tokens))} new / ${fmtTokens(total)}` : '—'}
            </Metric>
            <Metric label="Prompts / API calls">
              {root.prompts ?? 0} / {root.requests ?? 0}
            </Metric>
            <Metric label="Tool calls">{root.toolCalls ?? 0}</Metric>
            {contextPct !== null && (
              <Metric label="Context">
                {fmtTokens(root.contextTokens!)} / {fmtTokens(root.contextWindow!)}
                <span className="lv-meter" role="img" aria-label={`Context ${contextPct.toFixed(0)}% full`}>
                  <i style={{ width: `${contextPct}%` }} />
                </span>
              </Metric>
            )}
          </div>

          {subs > 0 && (
            <>
              <h3 className="lv-h3">Subagents</h3>
              <ul className="lv-subs">
                <SubagentRows parent={root} agents={agents} selected={selected} onSelect={onSelect} level={0} />
              </ul>
            </>
          )}

          <div className="lv-actions">
            <button className="panel-button" onClick={() => onSelect(root.id)}>
              Details
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

export default function ListView({ agents, selected, now, onSelect, approvalCards }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const ids = new Set(agents.map((a) => a.id))
  // Newest first; a session's position never changes while it runs.
  const roots = agents.filter((a) => !a.parentId || !ids.has(a.parentId)).sort((a, b) => b.startedAt - a.startedAt)
  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const allOpen = roots.length > 0 && roots.every((r) => expanded.has(r.id))

  if (!roots.length) return null
  return (
    <main className="list-view">
      <div className="lv-toolbar">
        <span>
          {roots.length} {roots.length === 1 ? 'session' : 'sessions'}
        </span>
        <button className="link-button" onClick={() => setExpanded(allOpen ? new Set() : new Set(roots.map((r) => r.id)))}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      <ul className="lv-sessions">
        {roots.map((r) => (
          <Session
            key={r.id}
            root={r}
            agents={agents}
            open={expanded.has(r.id)}
            onToggle={() => toggle(r.id)}
            selected={selected}
            now={now}
            onSelect={onSelect}
            approvalCards={approvalCards}
          />
        ))}
      </ul>
    </main>
  )
}
