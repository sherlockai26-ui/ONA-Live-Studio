/**
 * EQPanel.jsx — Panel de EQ semiparmétrico profesional (modal overlay)
 *
 * 7 bandas: Low (shelving) | Low Mid | Mid | High Mid | Presence | High | Air (shelving)
 * Cada banda peaking tiene: Gain, Frequency, Q
 * Bandas shelving tienen: Gain, Frequency
 *
 * Inspiración visual: API 550 / SSL / Behringer X32 EQ page
 */

import React from 'react'
import EQCurve from './EQCurve.jsx'
import { EQ_BAND_DEFS } from '../store/mixerStore.js'
import useMixerStore from '../store/mixerStore.js'
import { audioEngine } from '../audio/audioEngine.js'

function formatFreq(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : `${hz}`
}

function BandControl({ band, def, channelId, bandIndex }) {
  const updateBand = useMixerStore(s => s.updateChannelEqBand)

  const set = (updates) => {
    updateBand(channelId, band.id, updates)
    audioEngine.setChannelEqBand(channelId, bandIndex, updates)
  }

  const gainColor = band.gain > 0 ? '#f97316' : band.gain < 0 ? '#60a5fa' : '#737373'

  return (
    <div className="flex flex-col items-center gap-1 w-[62px]">
      {/* Nombre de banda */}
      <span className="text-[8px] text-[#737373] tracking-wider uppercase">{def.label}</span>

      {/* Gain dB display */}
      <span className="text-[9px] font-bold tabular-nums" style={{ color: gainColor }}>
        {band.gain > 0 ? '+' : ''}{band.gain.toFixed(1)}
      </span>

      {/* Fader de Gain vertical */}
      <input
        type="range"
        min={-12} max={12} step={0.5}
        value={band.gain}
        onChange={e => set({ gain: Number(e.target.value) })}
        style={{ writingMode: 'vertical-lr', direction: 'rtl', width: '18px', height: '72px' }}
        title={`Gain: ${band.gain} dB`}
      />

      {/* Frecuencia display */}
      <span className="text-[8px] text-[#f97316] tabular-nums">{formatFreq(band.freq)}</span>

      {/* Slider de Frecuencia */}
      <input
        type="range"
        min={def.freqMin} max={def.freqMax}
        step={def.freqMax > 5000 ? 100 : 10}
        value={band.freq}
        onChange={e => set({ freq: Number(e.target.value) })}
        className="w-[58px]"
        title={`Freq: ${band.freq} Hz`}
      />

      {/* Q (solo bandas peaking) */}
      {def.hasQ && (
        <>
          <span className="text-[8px] text-[#737373]">Q {band.q.toFixed(1)}</span>
          <input
            type="range"
            min={0.3} max={4} step={0.1}
            value={band.q}
            onChange={e => set({ q: Number(e.target.value) })}
            className="w-[58px]"
            title={`Q: ${band.q}`}
          />
        </>
      )}
    </div>
  )
}

export default function EQPanel({ channelId, channelName, onClose }) {
  const eqBands = useMixerStore(s => s.channels.find(c => c.id === channelId)?.eqBands ?? [])

  const updateBand = useMixerStore(s => s.updateChannelEqBand)

  const resetAll = () => {
    EQ_BAND_DEFS.forEach((def, i) => {
      updateBand(channelId, def.id, { gain: 0, freq: def.freqDefault, q: def.qDefault })
      audioEngine.setChannelEqBand(channelId, i, { gain: 0, freq: def.freqDefault, q: def.qDefault })
    })
  }

  return (
    // Overlay centrado en pantalla
// DESPUÉS:
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="bg-[#141414] border border-[#2a2a2a] rounded-xl shadow-2xl p-4"
        style={{ minWidth: 510 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#f97316] font-bold tracking-widest">EQ</span>
            <span className="text-[10px] text-[#737373]">—</span>
            <span className="text-[10px] text-[#e5e5e5]">{channelName}</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={resetAll}
              className="text-[9px] px-2 py-0.5 rounded bg-[#2a2a2a] text-[#737373] hover:text-[#e5e5e5] transition-colors"
            >
              RESET
            </button>
            <button
              onClick={onClose}
              className="text-[9px] px-2 py-0.5 rounded bg-[#2a2a2a] text-[#737373] hover:text-[#ef4444] transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Curva EQ canvas */}
        <div className="mb-3 rounded overflow-hidden border border-[#2a2a2a]">
          <EQCurve eqBands={eqBands} width={478} height={110} />
        </div>

        {/* Controles de bandas */}
        <div className="flex gap-1 justify-between">
          {EQ_BAND_DEFS.map((def, i) => {
            const band = eqBands.find(b => b.id === def.id)
            if (!band) return null
            return (
              <BandControl
                key={def.id}
                band={band}
                def={def}
                channelId={channelId}
                bandIndex={i}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
