/**
 * Recorder.jsx — Sistema de grabación real
 *
 * Flujo:
 *   GRABAR → audioEngine.startRecording(mode)
 *   DETENER → audioEngine.stopRecording() → blobs → blobToWav → electronAPI.saveRecording
 *
 * Estructura de archivos generada:
 *   ~/Documents/ONA Live Studio/Session_YYYY-MM-DD/
 *     MainMix_HH-MM-SS.wav      (modo procesado o ambos)
 *     Canal_1_RAW_HH-MM-SS.wav  (modo crudo o ambos)
 *     ...
 */

import React, { useState, useEffect, useRef } from 'react'
import useMixerStore from '../store/mixerStore.js'
import { audioEngine } from '../audio/audioEngine.js'
import { blobToWav }   from '../utils/wavEncoder.js'

function timestamp() {
  return new Date().toTimeString().slice(0, 8).replace(/:/g, '-')
}

export default function Recorder() {
  const { recording, mode } = useMixerStore(s => s.recorder)
  const setRecorder         = useMixerStore(s => s.setRecorder)

  const [elapsed, setElapsed]   = useState(0)
  const [saving, setSaving]     = useState(false)
  const [lastPath, setLastPath] = useState(null)
  const intervalRef             = useRef(null)

  useEffect(() => {
    if (recording) {
      setElapsed(0)
      intervalRef.current = setInterval(() => setElapsed(s => s + 1), 1000)
    } else {
      clearInterval(intervalRef.current)
    }
    return () => clearInterval(intervalRef.current)
  }, [recording])

  const formatElapsed = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0')
    const sec = (s % 60).toString().padStart(2, '0')
    return `${m}:${sec}`
  }

  const handleToggle = async () => {
    if (!recording) {
      // Iniciar
      if (!audioEngine.initialized) await audioEngine.initialize(6)
      audioEngine.startRecording(mode)
      setRecorder({ recording: true })
    } else {
      // Detener y guardar
      setSaving(true)
      setRecorder({ recording: false })
      try {
        const blobs = await audioEngine.stopRecording()
        const ts    = timestamp()

        for (const [key, blob] of Object.entries(blobs)) {
          if (!blob) continue
          let filename
          if (key === 'main') {
            filename = `MainMix_${ts}.wav`
          } else {
            const id = key.replace('raw_', '')
            filename = `Canal_${id}_RAW_${ts}.wav`
          }
          const wavBuffer = await blobToWav(blob, 24)
          if (window.electronAPI) {
            const path = await window.electronAPI.saveRecording(wavBuffer, filename)
            setLastPath(path)
          }
        }
      } catch (err) {
        console.error('Error al guardar grabación:', err)
      } finally {
        setSaving(false)
      }
    }
  }

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

      {/* Indicadores de estado */}
      {recording && (
        <div className="flex items-center justify-between mt-2">
          <p className="text-[9px] text-[#ef4444] animate-pulse">● REC</p>
          <p className="text-[9px] text-[#737373] font-mono">{formatElapsed(elapsed)}</p>
          <p className="text-[9px] text-[#737373]">{mode}</p>
        </div>
      )}

      {/* Última grabación guardada */}
      {lastPath && !recording && (
        <p className="text-[8px] text-[#22c55e] mt-2 truncate" title={lastPath}>
          ✓ {lastPath.split(/[\\/]/).pop()}
        </p>
      )}
    </div>
  )
}
