/**
 * ProFader.tsx — Hardware-feel fader using Pointer Events API.
 *
 * Features:
 *   - Mouse, touch, and stylus unified via setPointerCapture
 *   - Shift + drag → fine mode (10× precision)
 *   - Double-click → reset to default value
 *   - Vertical drag maps to dB range (configurable min/max)
 *   - No React state during drag — reads/writes DOM directly for 0-GC hot path
 *   - Calls onChange only on pointer up (or on every move if liveUpdate=true)
 */

import React, { useRef, useCallback, useEffect } from 'react'

export interface ProFaderProps {
  value:        number          // 0–100 (linear fader position)
  defaultValue?: number         // reset target on double-click (default 80)
  min?:          number         // default 0
  max?:          number         // default 100
  height?:       number         // px, default 180
  width?:        number         // px, default 32
  label?:        string
  disabled?:     boolean
  liveUpdate?:   boolean        // call onChange on every pointermove (default false)
  onChange:      (value: number) => void
  className?:    string
  'data-ch'?:   string | number // for test targeting
}

const FINE_DIVISOR  = 10
const DBL_CLICK_MS  = 300

export function ProFader({
  value,
  defaultValue = 80,
  min = 0,
  max = 100,
  height = 180,
  width  = 32,
  label,
  disabled = false,
  liveUpdate = false,
  onChange,
  className = '',
  ...rest
}: ProFaderProps): React.ReactElement {
  const trackRef   = useRef<HTMLDivElement>(null)
  const thumbRef   = useRef<HTMLDivElement>(null)
  const dragState  = useRef<{ active: boolean; startY: number; startVal: number; fine: boolean } | null>(null)
  const lastClick  = useRef<number>(0)
  const valueRef   = useRef<number>(value)

  // Keep valueRef in sync with controlled prop
  valueRef.current = value

  const clamp = (v: number) => Math.min(max, Math.max(min, v))

  const posFromValue = (v: number): number => {
    const ratio = (v - min) / (max - min)
    const thumbH = 20
    return (1 - ratio) * (height - thumbH)
  }

  // Direct DOM update during drag — no React re-render
  const applyThumbPos = useCallback((v: number) => {
    if (!thumbRef.current) return
    thumbRef.current.style.top = `${posFromValue(v)}px`
    if (thumbRef.current.nextElementSibling) {
      ;(thumbRef.current.nextElementSibling as HTMLElement).textContent =
        v >= 100 ? '0dB' : v <= 0 ? '-∞' : `${(v - 80).toFixed(0)}dB`
    }
  }, [height, min, max]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync thumb when controlled value changes from outside
  useEffect(() => { applyThumbPos(value) }, [value, applyThumbPos])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    e.preventDefault()

    const now = Date.now()
    if (now - lastClick.current < DBL_CLICK_MS) {
      // Double-click reset
      lastClick.current = 0
      const reset = clamp(defaultValue)
      applyThumbPos(reset)
      onChange(reset)
      return
    }
    lastClick.current = now

    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragState.current = {
      active:   true,
      startY:   e.clientY,
      startVal: valueRef.current,
      fine:     e.shiftKey,
    }
  }, [disabled, defaultValue, onChange, applyThumbPos]) // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragState.current
    if (!ds?.active) return
    e.preventDefault()

    const divisor  = (e.shiftKey || ds.fine) ? FINE_DIVISOR : 1
    const range    = max - min
    const pixRange = height - 20
    const delta    = -((e.clientY - ds.startY) / pixRange) * range / divisor
    const next     = clamp(ds.startVal + delta)

    applyThumbPos(next)
    valueRef.current = next
    if (liveUpdate) onChange(next)
  }, [height, min, max, liveUpdate, onChange, applyThumbPos]) // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerUp = useCallback((_e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragState.current
    if (!ds?.active) return
    dragState.current = null
    if (!liveUpdate) onChange(clamp(valueRef.current))
  }, [liveUpdate, onChange]) // eslint-disable-line react-hooks/exhaustive-deps

  const thumbTop = posFromValue(value)
  const label_db = value >= 100 ? '0dB' : value <= 0 ? '-∞' : `${(value - 80).toFixed(0)}dB`

  return (
    <div
      className={`pro-fader ${disabled ? 'pro-fader--disabled' : ''} ${className}`}
      style={{ width, userSelect: 'none', touchAction: 'none' }}
      {...rest}
    >
      {label && <div className="pro-fader__label">{label}</div>}
      <div
        ref={trackRef}
        className="pro-fader__track"
        style={{ height, position: 'relative' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Track fill */}
        <div
          className="pro-fader__fill"
          style={{
            position:      'absolute',
            bottom:        0,
            left:          '50%',
            transform:     'translateX(-50%)',
            width:         4,
            height:        `${((value - min) / (max - min)) * 100}%`,
            background:    'var(--fader-fill, #4ade80)',
            borderRadius:  2,
            pointerEvents: 'none',
          }}
        />
        {/* 0dB mark */}
        <div
          className="pro-fader__mark"
          style={{
            position:      'absolute',
            top:           posFromValue(80),
            left:          0,
            right:         0,
            height:        1,
            background:    'var(--fader-mark, rgba(255,255,255,0.25))',
            pointerEvents: 'none',
          }}
        />
        {/* Thumb */}
        <div
          ref={thumbRef}
          className="pro-fader__thumb"
          style={{
            position:     'absolute',
            top:          thumbTop,
            left:         0,
            right:        0,
            height:       20,
            background:   disabled
              ? 'var(--fader-thumb-disabled, #555)'
              : 'var(--fader-thumb, #e5e7eb)',
            borderRadius: 3,
            cursor:       disabled ? 'not-allowed' : 'ns-resize',
            boxShadow:    '0 1px 4px rgba(0,0,0,0.6)',
          }}
        />
        {/* dB readout */}
        <div
          className="pro-fader__db"
          style={{
            position:  'absolute',
            top:       thumbTop + 22,
            left:      0,
            right:     0,
            textAlign: 'center',
            fontSize:  10,
            color:     'var(--fader-db-color, rgba(255,255,255,0.5))',
            pointerEvents: 'none',
          }}
        >
          {label_db}
        </div>
      </div>
    </div>
  )
}

export default ProFader
