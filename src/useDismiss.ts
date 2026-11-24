import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

// Closes a popup on a press outside it, or on Escape. `ref` covers the popup and whatever
// opens it (so its own toggle button doesn't count as outside). `ignore` lets a caller leave
// some areas to their own handling.
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active: boolean,
  ignore?: (target: Element) => boolean,
) {
  const close = useRef(onClose)
  close.current = onClose
  const skip = useRef(ignore)
  skip.current = ignore

  useEffect(() => {
    if (!active) return
    const down = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Element) || !t.isConnected) return
      if (ref.current?.contains(t) || skip.current?.(t)) return
      close.current()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current()
    }
    // Capture: runs even when something inside stops the event from bubbling.
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key)
    }
  }, [active, ref])
}
