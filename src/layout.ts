// Where nodes go. Positions are chosen once and never change, so nothing shifts under the
// cursor; every candidate is checked against the full footprint of everything on stage.
import { isRetired, rootOf } from './format'
import type { Agent } from './sim'

type Placed = Pick<Agent, 'x' | 'y' | 'r' | 'depth' | 'name'>
interface Rect {
  x0: number
  x1: number
  y0: number
  y1: number
}

const GAP = 18 // minimum empty space between footprints
const ROOT_CAPTION_HALF_WIDTH = 150 // model, tokens and cost under a session node
const ROOT_CAPTION_BOTTOM = 46
const SUB_LABEL_BOTTOM = 30
const ROOT_SPACING = 170 // extra room between sessions, for the subagents they'll spawn
const CHILD_DISTANCE = 80 // from the parent's edge to the first ring
const RING_GAP = 90

// The node plus the text under it.
export function footprint(a: Placed): Rect {
  if (a.depth === 0) {
    return {
      x0: a.x - Math.max(a.r, ROOT_CAPTION_HALF_WIDTH),
      x1: a.x + Math.max(a.r, ROOT_CAPTION_HALF_WIDTH),
      y0: a.y - a.r,
      y1: a.y + a.r + ROOT_CAPTION_BOTTOM,
    }
  }
  // Labels are cut to 22 characters at 13px.
  const half = Math.max(a.r, (Math.min(a.name.length, 22) * 7) / 2)
  return { x0: a.x - half, x1: a.x + half, y0: a.y - a.r, y1: a.y + a.r + SUB_LABEL_BOTTOM }
}

const collides = (a: Rect, b: Rect, gap: number) =>
  a.x0 - gap < b.x1 && b.x0 - gap < a.x1 && a.y0 - gap < b.y1 && b.y0 - gap < a.y1

// What counts as on the dashboard. The app replaces this so nodes you removed or brought
// back are planned around correctly.
export type StageRule = (a: Agent, byId: Map<string, Agent>) => boolean
let stageRule: StageRule = (a, byId) => !isRetired(rootOf(a, byId), Date.now())
export const setStageRule = (rule: StageRule) => {
  stageRule = rule
}

function onStage(all: Agent[]) {
  const byId = new Map(all.map((a) => [a.id, a]))
  return all.filter((a) => stageRule(a, byId))
}

// New positions for an agent and everything under it, around what's on the dashboard now.
// Used when something comes back: its old spot may have been taken meanwhile.
export function relocate(list: Agent[], id: string): Agent[] {
  const ids = new Set([id])
  for (const a of list) if (a.parentId && ids.has(a.parentId)) ids.add(a.id) // list is parent-first
  let base = list.filter((a) => !ids.has(a.id))
  const placed = new Map<string, Agent>()
  for (const a of list) {
    if (!ids.has(a.id)) continue
    const parent = a.parentId ? (placed.get(a.parentId) ?? base.find((b) => b.id === a.parentId)) : undefined
    const pos = parent ? placeChild(base, parent, a.r, a.name) : placeRoot(base, a.r, a.name)
    const moved = { ...a, ...pos, fresh: true }
    placed.set(a.id, moved)
    base = [...base, moved]
  }
  return list.map((a) => placed.get(a.id) ?? a)
}

// How close a node comes to the straight line between two points.
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

// Past everything on stage: only used if no ring has room.
function beyondEverything(rects: Rect[], self: Placed) {
  const right = Math.max(...rects.map((r) => r.x1))
  const half = (footprint({ ...self, x: 0, y: 0 }).x1 - footprint({ ...self, x: 0, y: 0 }).x0) / 2
  return { x: right + GAP + half, y: self.y }
}

// Fills rings around the parent, spreading siblings evenly, nearest ring first.
export function placeChild(all: Agent[], parent: Agent, r: number, name: string) {
  const stage = onStage(all)
  const rects = stage.map(footprint)
  const depth = parent.depth + 1
  const siblings = stage.filter((a) => a.parentId === parent.id)
  const grandparent = stage.find((a) => a.id === parent.parentId)
  const outward = grandparent ? Math.atan2(parent.y - grandparent.y, parent.x - grandparent.x) : -Math.PI / 2

  const search = (keepLinksClear: boolean, maxRings: number) => {
    for (let ring = 0; ring < maxRings; ring++) {
      const R = parent.r + r + CHILD_DISTANCE + ring * (2 * r + RING_GAP)
      const slots = Math.max(8, Math.floor((2 * Math.PI * R) / (2 * r + 60)))
      let best: { x: number; y: number } | undefined
      let bestScore = -Infinity
      for (let i = 0; i < slots; i++) {
        // Outer rings sit between the slots of inner ones, so links pass through the gaps.
        const angle = outward + ((i + (ring % 2 ? 0.5 : 0)) / slots) * Math.PI * 2
        const x = parent.x + Math.cos(angle) * R
        const y = parent.y + Math.sin(angle) * R
        const box = footprint({ x, y, r, depth, name })
        if (rects.some((b) => collides(box, b, GAP))) continue
        if (
          keepLinksClear &&
          stage.some((a) => a.id !== parent.id && distanceToSegment(a.x, a.y, parent.x, parent.y, x, y) < a.r + 10)
        )
          continue
        const nearest = siblings.length ? Math.min(...siblings.map((s) => Math.hypot(s.x - x, s.y - y))) : 0
        // Evenly spread among siblings; grandchildren also lean away from the grandparent.
        const score = nearest + (grandparent ? Math.cos(angle - outward) * R * 0.5 : -i * 1e-3)
        if (score > bestScore) {
          bestScore = score
          best = { x, y }
        }
      }
      if (best) return best
    }
  }

  return (
    search(true, 6) ??
    search(false, 24) ??
    beyondEverything(rects, { x: 0, y: parent.y, r, depth, name })
  )
}

// New sessions take the free spot nearest the centre, on wide ellipses to suit a wide screen.
export function placeRoot(all: Agent[], r: number, name: string) {
  const stage = onStage(all)
  if (!stage.length) return { x: 0, y: 0 }
  const rects = stage.map(footprint)
  const roots = stage.filter((a) => a.depth === 0)
  for (let ring = 1; ring < 24; ring++) {
    let best: { x: number; y: number } | undefined
    let bestScore = -Infinity
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2 + (ring % 2 ? 0 : Math.PI / 16)
      const x = Math.cos(angle) * ring * 620
      const y = Math.sin(angle) * ring * 420
      const box = footprint({ x, y, r, depth: 0, name })
      if (rects.some((b) => collides(box, b, ROOT_SPACING))) continue
      const nearest = Math.min(...roots.map((a) => Math.hypot(a.x - x, a.y - y)))
      if (nearest > bestScore) {
        bestScore = nearest
        best = { x, y }
      }
    }
    if (best) return best
  }
  return beyondEverything(rects, { x: 0, y: 0, r, depth: 0, name })
}
