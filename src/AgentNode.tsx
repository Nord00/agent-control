import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import type { Agent } from './sim'
import { RETIRE_MS, fmtCost, fmtTokens, modelName, newTokens, totalTokens } from './format'
import * as Icon from './Icons'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const CodeMark = () => (
  <svg className="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7.5 6 1.5 12l6 6M16.5 6l6 6-6 6M14 3.5 10 20.5" />
  </svg>
)

interface Props {
  agent: Agent
  from: { x: number; y: number } | null // parent position (spawn origin)
  selected: boolean
  pinned: boolean // brought back from Recent: stays until removed, so it doesn't fade out
  onSelect: (id: string) => void
}

// HTML rather than SVG, and every looping animation is transform or opacity only, so the
// browser can run them on the compositor without repainting.
export default function AgentNode({ agent: a, from, selected, pinned, onSelect }: Props) {
  const root = a.depth === 0
  const rootName = clip(a.name, 20)
  const label = a.ended
    ? 'Ended'
    : a.attention
      ? 'Needs approval'
      : a.status === 'working'
        ? 'Working'
        : a.status === 'waiting'
          ? 'Waiting'
          : 'Completed'
  const rings = a.ended ? 0 : a.status === 'working' || a.attention ? 2 : a.status === 'waiting' ? 1 : 0
  // Fixed when the session ends: changing an animation's delay on later renders would shift it.
  const fadeIn = useMemo(
    () => (a.ended ? Math.max(0, (a.endedAt ?? 0) + RETIRE_MS - Date.now()) : 0),
    [a.ended, a.endedAt],
  )

  const style = {
    left: a.x,
    top: a.y,
    '--r': a.r,
    '--dx': `${from ? from.x - a.x : 0}px`,
    '--dy': `${from ? from.y - a.y : 0}px`,
    // So nodes don't all beat in time.
    '--phase': `-${(a.seed % 2400) / 1000}s`,
    '--name-size': Math.min(29, 190 / (rootName.length * 0.54)),
    '--fade-in': `${fadeIn}ms`,
  } as CSSProperties

  const tokens = totalTokens(a.tokens)
  const caption = [
    a.model ? modelName(a.model) : null,
    tokens ? `${fmtTokens(newTokens(a.tokens))} new / ${fmtTokens(tokens)} total` : null,
    typeof a.cost === 'number' ? fmtCost(a.cost, a.costPartial) : null,
  ]
    .filter(Boolean)
    .join('  ·  ')

  return (
    <button
      type="button"
      className={`node ${a.status}${root ? ' root' : ''}${a.ended ? ' ended' : ''}${a.attention ? ' attention' : ''}${a.fresh ? ' spawn' : ''}${selected ? ' selected' : ''}${pinned ? ' pinned' : ''}`}
      style={style}
      aria-label={`${a.name}: ${label}`}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(a.id)
      }}
    >
      <span className="glow" />
      {rings > 0 && <span className="pulse" />}
      {rings > 1 && <span className="pulse second" />}
      <span className="disc" />
      <span className="sel" />
      {root ? (
        <span className="content">
          <CodeMark />
          <span className="name" title={a.name}>
            {rootName}
          </span>
          <span className="node-pill">
            {a.status === 'completed' ? <Icon.Check /> : <i />}
            {label}
          </span>
        </span>
      ) : (
        <span className="content">
          <CodeMark />
        </span>
      )}
      {root
        ? caption && <span className="caption">{caption}</span>
        : <span className="caption sub" title={a.name}>{clip(a.name, 22)}</span>}
    </button>
  )
}
