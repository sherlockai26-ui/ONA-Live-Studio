/**
 * ConsoleMeter.tsx — Canvas-based level meter with zero React re-renders per frame.
 *
 * Architecture:
 *   - useEffect mounts a single canvas draw loop via uiLayerManager (CRITICAL)
 *   - All animation happens in the canvas callback — React never re-renders
 *   - Peak hold drawn as 1px line, decays after PEAK_HOLD_MS
 *   - Pre-computed gradient: green → yellow → red (no GC per frame)
 *   - Clipping indicator: top 4px turns red, holds for CLIP_HOLD_MS
 */

import React, { useRef, useEffect, useCallback } from 'react'
import { bl }              from '../util/bootlog'
import { uiLayerManager }  from './UILayerManager'
import { resourceManager } from '../audio/scalability/ResourceManager'
import { performanceModes } from '../audio/scalability/PerformanceModes'
import { audioEngine }     from '../audio/audioEngine'

export interface ConsoleMeterProps {
  channelId:   number | string
  getLevel:    () => number          // returns 0–1 (linear RMS)
  getPeak?:    () => number          // optional separate peak value 0–1
  width?:      number                // px, default 8
  height?:     number                // px, default 160
  showPeak?:   boolean               // default true
  orientation?: 'vertical' | 'horizontal'
  className?:  string
}

const PEAK_HOLD_MS = 2000
const CLIP_HOLD_MS = 3000

export function ConsoleMeter({
  channelId,
  getLevel,
  getPeak,
  width  = 8,
  height = 160,
  showPeak = true,
  orientation = 'vertical',
  className = '',
}: ConsoleMeterProps): React.ReactElement {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const gradRef      = useRef<CanvasGradient | null>(null)
  const peakRef      = useRef<{ val: number; ts: number }>({ val: 0, ts: 0 })
  const clipRef      = useRef<number>(0)           // timestamp of last clip
  const smoothRef    = useRef<number>(0)           // smoothed level
  const visibleRef   = useRef<boolean>(true)       // IntersectionObserver flag
  const frameRef     = useRef<number>(0)           // frame counter for eco skip
  const ecoScaleRef  = useRef<number>(1)           // last applied canvas scale

  const buildGradient = useCallback((ctx: CanvasRenderingContext2D): CanvasGradient => {
    const grad = orientation === 'vertical'
      ? ctx.createLinearGradient(0, 0, 0, height)
      : ctx.createLinearGradient(0, 0, width, 0)
    grad.addColorStop(0,    '#ef4444')  // red   (top / right = loud)
    grad.addColorStop(0.1,  '#f97316')  // orange
    grad.addColorStop(0.25, '#eab308')  // yellow
    grad.addColorStop(1,    '#22c55e')  // green  (bottom / left = quiet)
    return grad
  }, [orientation, width, height])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    gradRef.current = buildGradient(ctx)

    // Stop drawing when canvas scrolls out of view
    const observer = new IntersectionObserver(
      ([entry]) => { visibleRef.current = entry.isIntersecting },
      { threshold: 0 }
    )
    observer.observe(canvas)

    const meterId = typeof channelId === 'number' ? `ch${channelId}` : String(channelId)

    bl('ConsoleMeter.tsx', 'register', `${meterId} registrando callback RAF en uiLayerManager`)
    const id = `meter_${channelId}`
    const unsub = uiLayerManager.register('metering', (now) => {
      // No leer AnalyserNodes hasta que el primer tick de MeteringEngine haya completado
      if (!(audioEngine as any).isMeteringReady) return

      // Skip draw when scrolled off screen
      if (!visibleRef.current) return

      // Stop completely when ResourceManager suspends this channel's meter
      if (resourceManager.isMeterSuspended(meterId)) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        return
      }

      // Eco mode: half the draw rate and canvas resolution
      const eco = performanceModes.mode === 'eco'
      frameRef.current++
      if (eco && (frameRef.current & 1) !== 0) return  // skip odd frames → ~15fps

      // Resize canvas to half in eco mode; restore to full on exit
      const targetScale = eco ? 0.5 : 1
      if (ecoScaleRef.current !== targetScale) {
        ecoScaleRef.current = targetScale
        canvas.width  = Math.max(1, Math.round(width  * targetScale))
        canvas.height = Math.max(1, Math.round(height * targetScale))
        canvas.style.width  = eco ? `${width}px`  : ''
        canvas.style.height = eco ? `${height}px` : ''
        gradRef.current = buildGradient(ctx)  // gradient resets with canvas
      }

      const raw  = Math.max(0, Math.min(1, getLevel()))
      // Exponential smoothing: attack fast, release slower
      smoothRef.current = raw > smoothRef.current
        ? raw * 0.9 + smoothRef.current * 0.1
        : raw * 0.05 + smoothRef.current * 0.95

      const level = smoothRef.current
      const peak  = getPeak ? Math.max(0, Math.min(1, getPeak())) : level

      // Peak hold
      if (peak > peakRef.current.val) {
        peakRef.current = { val: peak, ts: now }
      } else if (now - peakRef.current.ts > PEAK_HOLD_MS) {
        peakRef.current.val *= 0.95   // decay
      }

      // Clip detection
      if (level >= 0.999) clipRef.current = now

      const cw = canvas.width
      const ch = canvas.height
      ctx.clearRect(0, 0, cw, ch)

      // Scale coordinate space to match logical (prop) dimensions
      ctx.save()
      if (ecoScaleRef.current !== 1) ctx.scale(ecoScaleRef.current, ecoScaleRef.current)

      // Fill meter
      ctx.fillStyle = gradRef.current ?? '#22c55e'
      if (orientation === 'vertical') {
        const fillH = level * height
        ctx.fillRect(0, height - fillH, width, fillH)
      } else {
        ctx.fillRect(0, 0, level * width, height)
      }

      // Peak hold line
      if (showPeak && peakRef.current.val > 0.01) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        if (orientation === 'vertical') {
          const py = height - peakRef.current.val * height
          ctx.fillRect(0, py, width, 1)
        } else {
          const px = peakRef.current.val * width
          ctx.fillRect(px - 1, 0, 1, height)
        }
      }

      // Clip indicator
      if (now - clipRef.current < CLIP_HOLD_MS) {
        ctx.fillStyle = '#ef4444'
        if (orientation === 'vertical') {
          ctx.fillRect(0, 0, width, 4)
        } else {
          ctx.fillRect(width - 4, 0, 4, height)
        }
      }

      ctx.restore()
    }, id)

    return () => {
      observer.disconnect()
      unsub()
      gradRef.current = null
    }
  }, [channelId, getLevel, getPeak, width, height, showPeak, orientation, buildGradient])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={`console-meter ${className}`}
      style={{ display: 'block', imageRendering: 'pixelated' }}
    />
  )
}

export default ConsoleMeter
