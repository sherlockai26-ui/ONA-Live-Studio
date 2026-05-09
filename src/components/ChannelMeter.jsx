import React, { useRef, useEffect } from 'react'
import { audioEngine } from '../audio/audioEngine.js'

const DB_MIN = -60
const DB_MAX = 0
const PEAK_HOLD_FRAMES = 90  // ~1.5 s a 60 fps

export default function ChannelMeter({ channelId, width = 10, height = 80 }) {
  const canvasRef = useRef(null)
  const stRef     = useRef({ level: -Infinity, peak: -Infinity, peakAge: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W   = canvas.width
    const H   = canvas.height

    const toY = (db) => {
      const clamped = Math.max(DB_MIN, Math.min(DB_MAX, db))
      return H - ((clamped - DB_MIN) / (DB_MAX - DB_MIN)) * H
    }

    const draw = () => {
      const { level, peak } = stRef.current
      ctx.clearRect(0, 0, W, H)

      ctx.fillStyle = '#111'
      ctx.fillRect(0, 0, W, H)

      if (level > DB_MIN) {
        const y    = toY(level)
        const barH = H - y
        const grad = ctx.createLinearGradient(0, H, 0, 0)
        grad.addColorStop(0,    '#22c55e')
        grad.addColorStop(0.65, '#22c55e')
        grad.addColorStop(0.75, '#eab308')
        grad.addColorStop(0.90, '#ef4444')
        grad.addColorStop(1,    '#ef4444')
        ctx.fillStyle = grad
        ctx.fillRect(0, y, W, barH)
      }

      if (peak > DB_MIN) {
        const py = toY(peak)
        ctx.fillStyle = peak > -6 ? '#ef4444' : '#e5e5e5'
        ctx.fillRect(0, py, W, 2)
      }
    }

    const unsub = audioEngine.onMeterUpdate((data) => {
      const db = data[channelId] ?? -Infinity
      const st = stRef.current
      st.level = db
      if (db >= st.peak) {
        st.peak    = db
        st.peakAge = 0
      } else {
        st.peakAge++
        if (st.peakAge > PEAK_HOLD_FRAMES) st.peak = db
      }
      draw()
    })

    draw()
    return unsub
  }, [channelId])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ width, height }}
      className="rounded-sm"
    />
  )
}
