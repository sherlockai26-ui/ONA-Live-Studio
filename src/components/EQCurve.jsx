/**
 * EQCurve.jsx — Visualización canvas de la curva de respuesta en frecuencia.
 *
 * Dibuja en tiempo real la curva EQ combinada de todas las bandas
 * usando la respuesta de filtro biquad calculada en audioUtils.js.
 */

import React, { useRef, useEffect, useMemo } from 'react'
import { computeEqCurve, logFrequencies } from '../utils/audioUtils.js'
import { EQ_BAND_DEFS } from '../store/mixerStore.js'

const FREQS      = logFrequencies(20, 20000, 512)
const DB_MAX     = 12
const DB_MIN     = -12
const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const GRID_DB    = [-12, -6, 0, 6, 12]

function freqLabel(f) {
  return f >= 1000 ? `${f / 1000}k` : `${f}`
}

function freqToX(f, width) {
  const logMin = Math.log10(20)
  const logMax = Math.log10(20000)
  return ((Math.log10(f) - logMin) / (logMax - logMin)) * width
}

function dbToY(db, height) {
  return ((DB_MAX - db) / (DB_MAX - DB_MIN)) * height
}

export default function EQCurve({ eqBands, width = 470, height = 110 }) {
  const canvasRef = useRef(null)

  const curve = useMemo(
    () => computeEqCurve(eqBands, EQ_BAND_DEFS, FREQS),
    [eqBands]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, width, height)

    // ── Fondo ────────────────────────────────────────────────────────────────
    ctx.fillStyle = '#0f0f0f'
    ctx.fillRect(0, 0, width, height)

    // ── Grid vertical (frecuencias) ──────────────────────────────────────────
    ctx.strokeStyle = '#2a2a2a'
    ctx.lineWidth = 1
    GRID_FREQS.forEach(f => {
      const x = freqToX(f, width)
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()

      ctx.fillStyle = '#444'
      ctx.font = '8px monospace'
      ctx.fillText(freqLabel(f), x + 2, height - 3)
    })

    // ── Grid horizontal (dB) ────────────────────────────────────────────────
    GRID_DB.forEach(db => {
      const y = dbToY(db, height)
      ctx.strokeStyle = db === 0 ? '#3a3a3a' : '#222'
      ctx.lineWidth = db === 0 ? 1.5 : 1
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()

      if (db !== 0) {
        ctx.fillStyle = '#444'
        ctx.font = '8px monospace'
        ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 2, y - 2)
      }
    })

    // ── Línea 0 dB (referencia) ─────────────────────────────────────────────
    const zeroY = dbToY(0, height)
    ctx.strokeStyle = '#3a3a3a'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(0, zeroY)
    ctx.lineTo(width, zeroY)
    ctx.stroke()
    ctx.setLineDash([])

    // ── Curva EQ (fill + stroke) ─────────────────────────────────────────────
    const gradient = ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, 'rgba(249,115,22,0.35)')
    gradient.addColorStop(1, 'rgba(249,115,22,0.0)')

    ctx.beginPath()
    ctx.moveTo(0, zeroY)
    FREQS.forEach((f, i) => {
      const x  = freqToX(f, width)
      const db = Math.max(DB_MIN, Math.min(DB_MAX, curve[i] ?? 0))
      const y  = dbToY(db, height)
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    })
    ctx.lineTo(width, zeroY)
    ctx.lineTo(0, zeroY)
    ctx.closePath()
    ctx.fillStyle = gradient
    ctx.fill()

    // Línea de curva
    ctx.beginPath()
    FREQS.forEach((f, i) => {
      const x  = freqToX(f, width)
      const db = Math.max(DB_MIN, Math.min(DB_MAX, curve[i] ?? 0))
      const y  = dbToY(db, height)
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    })
    ctx.strokeStyle = '#f97316'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }, [curve, width, height])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="rounded block"
      style={{ background: '#0f0f0f' }}
    />
  )
}
