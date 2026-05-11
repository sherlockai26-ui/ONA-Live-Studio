/**
 * Recorder.jsx — Grabación multipista en tiempo real
 *
 * Flujo:
 *   GRABAR → audioEngine.startMultitrackRec(channelIds) → sesión WAV 24-bit en disco
 *   DETENER → audioEngine.stopMultitrackRec() → finaliza headers WAV
 *
 * Los niveles por canal se actualizan vía onMeterUpdate sin re-renders de React
 * (escritura directa a canvas refs en el hot path).
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import useMixerStore from '../store/mixerStore.js'
import { audioEngine } from '../audio/audioEngine.js'

const NUM_CHANNELS = 6
const DB_MIN       = -60

function timestamp() {
  return new Date().toTimeString().slice(0, 8).replace(/:/g, '-')
}

function dbToFraction(db) {
  return Math.max(0, Math.min(1, (db - DB_MIN) / (0 - DB_MIN)))
}

// Mini level bar — canvas-based, updated imperatively from parent ref
function MiniMeter({ canvasRef, channelId, name }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <canvas
        ref={el => { if (canvasRef.current) canvasRef.current[channelId - 1] = el }}
        width={8}
        height={28}
        style={{ width: 8, height: 28, display: 'block' }}
        className="rounded-sm"
      />
      <span className="text-[7px] text-[#737373] truncate w-8 text-center">{name}</span>
    </div>
  )
}

export default function Recorder() {
  const { recording, mode } = useMixerStore(useShallow(s => s.recorder))
  const setRecorder         = useMixerStore(s => s.setRecorder)
  const channelNames        = useMixerStore(useShallow(s => s.channels.map(c => c.name)))

  const [elapsed, setElapsed] = useState(0)
  const [saving, setSaving]   = useState(false)
  const [status, setStatus]   = useState(null)   // null | 'ok' | 'error'
  const [statusMsg, setStatusMsg] = useState('')

  const intervalRef  = useRef(null)
  const canvasesRef  = useRef(new Array(NUM_CHANNELS).fill(null))
  const gradsRef     = useRef(new Array(NUM_CHANNELS).fill(null))
  const unsubRef     = useRef(null)

  // Elapsed timer
  useEffect(() => {
    if (recording) {
      setElapsed(0)
      intervalRef.current = setInterval(() => setElapsed(s => s + 1), 1000)
    } else {
      clearInterval(intervalRef.current)
    }
    return () => clearInterval(intervalRef.current)
  }, [recording])

  // Per-channel meters — imperative canvas writes, zero React re-renders
  useEffect(() => {
    if (!recording) {
      // Clear all canvases when not recording
      canvasesRef.current.forEach(canvas => {
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (ctx) { ctx.clearRect(0, 0, canvas.width, canvas.height) }
      })
      if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
      return
    }

    if (typeof audioEngine.onMeterUpdate !== 'function') return

    unsubRef.current = audioEngine.onMeterUpdate((data) => {
      for (let i = 0; i < NUM_CHANNELS; i++) {
        const canvas = canvasesRef.current[i]
        if (!canvas) continue
        const ctx = canvas.getContext('2d')
        if (!ctx) continue

        const W = canvas.width
        const H = canvas.height

        // Build gradient once per canvas per mount
        if (!gradsRef.current[i]) {
          const g = ctx.createLinearGradient(0, H, 0, 0)
          g.addColorStop(0,    '#22c55e')
          g.addColorStop(0.7,  '#22c55e')
          g.addColorStop(0.85, '#eab308')
          g.addColorStop(1,    '#ef4444')
          gradsRef.current[i] = g
        }

        const db   = data[i + 1] ?? -Infinity
        const frac = isFinite(db) ? dbToFraction(db) : 0
        const barH = Math.round(frac * H)

        ctx.clearRect(0, 0, W, H)
        ctx.fillStyle = '#1a1a1a'
        ctx.fillRect(0, 0, W, H)
        if (barH > 0) {
          ctx.fillStyle = gradsRef.current[i]
          ctx.fillRect(0, H - barH, W, barH)
        }
      }
    })

    return () => {
      if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
    }
  }, [recording])

  const formatElapsed = useCallback((s) => {
    const m   = Math.floor(s / 60).toString().padStart(2, '0')
    const sec = (s % 60).toString().padStart(2, '0')
    return `${m}:${sec}`
  }, [])

  const handleToggle = useCallback(async () => {
    if (!recording) {
      if (!audioEngine.initialized) await audioEngine.initialize(NUM_CHANNELS)
      try {
        const channelIds = Array.from({ length: NUM_CHANNELS }, (_, i) => i + 1)
        await audioEngine.startMultitrackRec(channelIds)
        setRecorder({ recording: true })
        setStatus(null)
      } catch (err) {
        console.error('[Recorder] startMultitrackRec error:', err)
        setStatus('error')
        setStatusMsg('Error al iniciar grabación')
      }
    } else {
      setSaving(true)
      setRecorder({ recording: false })
      try {
        await audioEngine.stopMultitrackRec()
        setStatus('ok')
        setStatusMsg(`Sesión ${timestamp()} guardada`)
      } catch (err) {
        console.error('[Recorder] stopMultitrackRec error:', err)
        setStatus('error')
        setStatusMsg('Error al finalizar sesión')
      } finally {
        setSaving(false)
      }
    }
  }, [recording, setRecorder])

  return (
    <div className="border-b border-[#2a2a2a] p-3">
      <p className="text-[10px] text-[#f97316] font-bold mb-3 tracking-widest">
        GRABACIÓN
      </p>

      {/* Selector de modo */}
      <div className="flex gap-1 mb-3">
        {['crudo', 'procesado', 'ambos'].map(m => (
          <button
            key={m}
            onClick={() => !recording && setRecorder({ mode: m })}
            disabled={recording}
            className={`flex-1 text-[8px] py-1 rounded capitalize transition-colors ${
              mode === m
                ? 'bg-[#f97316] text-black font-bold'
                : 'bg-[#2a2a2a] text-[#737373]'
            } disabled:opacity-50`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Botón GRABAR / DETENER */}
      <button
        onClick={handleToggle}
        disabled={saving}
        className={`w-full py-2 rounded text-xs font-bold transition-colors ${
          recording
            ? 'bg-[#ef4444] text-white animate-pulse'
            : saving
            ? 'bg-[#2a2a2a] text-[#737373]'
            : 'bg-[#2a2a2a] text-[#737373] hover:bg-[#3a3a3a]'
        }`}
      >
        {saving ? 'Guardando...' : recording ? '⏹ DETENER' : '⏺ GRABAR'}
      </button>

      {/* Indicadores de estado + mini-metros por canal */}
      {recording && (
        <>
          <div className="flex items-center justify-between mt-2">
            <p className="text-[9px] text-[#ef4444] animate-pulse">● REC</p>
            <p className="text-[9px] text-[#737373] font-mono">{formatElapsed(elapsed)}</p>
            <p className="text-[9px] text-[#737373]">{mode}</p>
          </div>
          <div className="flex justify-between mt-2 px-1">
            {Array.from({ length: NUM_CHANNELS }, (_, i) => (
              <MiniMeter
                key={i + 1}
                canvasRef={canvasesRef}
                channelId={i + 1}
                name={channelNames[i] ?? `Ch${i + 1}`}
              />
            ))}
          </div>
        </>
      )}

      {/* Estado de la última sesión */}
      {status === 'ok' && !recording && (
        <p className="text-[8px] text-[#22c55e] mt-2 truncate" title={statusMsg}>
          ✓ {statusMsg}
        </p>
      )}
      {status === 'error' && !recording && (
        <p className="text-[8px] text-[#ef4444] mt-2 truncate" title={statusMsg}>
          ✗ {statusMsg}
        </p>
      )}
    </div>
  )
}
