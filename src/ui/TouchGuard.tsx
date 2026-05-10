/**
 * TouchGuard.tsx — Accidental touch prevention for live console use.
 *
 * Problems solved:
 *   - Pinch-to-zoom on the console changes fader layout unexpectedly
 *   - Palm resting on screen triggers fader moves
 *   - Two-finger swipe scrolls the mix view when a fader is active
 *   - Rapid accidental taps reset fader positions
 *
 * Approach:
 *   - Prevents pinch-zoom (touchmove with 2+ points)
 *   - Locks scroll on axis that has an active fader drag
 *   - Minimum touch area: 8×8px (ignores single-pixel touches)
 *   - Gesture lock: while any ProFader is captured, swipe gestures are blocked
 *   - Provides useGestureLock() hook for ProFader to call on capture
 */

import React, { useRef, useCallback, createContext, useContext, useEffect } from 'react'

interface GestureLockContextValue {
  lock:   () => void
  unlock: () => void
  locked: () => boolean
}

const GestureLockContext = createContext<GestureLockContextValue>({
  lock:   () => {},
  unlock: () => {},
  locked: () => false,
})

export function useGestureLock(): GestureLockContextValue {
  return useContext(GestureLockContext)
}

export interface TouchGuardProps {
  children:          React.ReactNode
  /** Minimum touch area dimension in px. Touches smaller are ignored. Default 8 */
  minTouchArea?:     number
  /** Block pinch-zoom. Default true */
  blockPinch?:       boolean
  /** Block browser double-tap zoom. Default true */
  blockDoubleTap?:   boolean
  className?:        string
  style?:            React.CSSProperties
}

export function TouchGuard({
  children,
  minTouchArea   = 8,
  blockPinch     = true,
  blockDoubleTap = true,
  className = '',
  style,
}: TouchGuardProps): React.ReactElement {
  const lockCount  = useRef(0)
  const lastTap    = useRef<{ x: number; y: number; ts: number } | null>(null)
  const rootRef    = useRef<HTMLDivElement>(null)

  const lock   = useCallback(() => { lockCount.current++ }, [])
  const unlock = useCallback(() => { lockCount.current = Math.max(0, lockCount.current - 1) }, [])
  const locked = useCallback(() => lockCount.current > 0, [])

  // Block pinch on the root element
  useEffect(() => {
    const el = rootRef.current
    if (!el || !blockPinch) return

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        e.preventDefault()
        return
      }
      // If gesture is locked (fader captured), block scroll
      if (lockCount.current > 0) e.preventDefault()
    }

    el.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => el.removeEventListener('touchmove', onTouchMove)
  }, [blockPinch])

  const onTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    // Filter micro-touches (palm edge, stylus hover)
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i]
      // radiusX/Y are supported on Chrome/Android — fall back if absent
      const rx = (t as any).radiusX ?? minTouchArea
      const ry = (t as any).radiusY ?? minTouchArea
      if (rx < minTouchArea / 2 && ry < minTouchArea / 2) {
        e.preventDefault()
        return
      }
    }

    // Block double-tap zoom
    if (blockDoubleTap) {
      const now = Date.now()
      const touch = e.touches[0]
      const prev  = lastTap.current
      if (prev && now - prev.ts < 300 &&
          Math.abs(touch.clientX - prev.x) < 20 &&
          Math.abs(touch.clientY - prev.y) < 20) {
        e.preventDefault()
      }
      lastTap.current = { x: touch.clientX, y: touch.clientY, ts: now }
    }
  }, [blockDoubleTap, minTouchArea])

  const ctx: GestureLockContextValue = { lock, unlock, locked }

  return (
    <GestureLockContext.Provider value={ctx}>
      <div
        ref={rootRef}
        className={`touch-guard ${className}`}
        style={{ touchAction: 'pan-x', ...style }}
        onTouchStart={onTouchStart}
      >
        {children}
      </div>
    </GestureLockContext.Provider>
  )
}

export default TouchGuard
