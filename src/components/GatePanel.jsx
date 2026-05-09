import React, { useRef, useEffect } from 'react'
import useMixerStore from '../store/mixerStore.js'
import { audioEngine } from '../audio/audioEngine.js'

function Slider({ label, min, max, step = 0.01, value, onChange, format }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] text-[#737373] w-16 shrink-0 text-right">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1"
      />
      <span className="text-[9px] text-[#f97316] w-16 text-right">
        {format ? format(value) : value}
      </span>
    </div>
  )
}

function GateIndicator({ channelId }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height

    const unsub = audioEngine.onMeterUpdate((data) => {
      const level = data[`gate_${channelId}`] ?? 1
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#111'
      ctx.fillRect(0, 0, W, H)
      const barW = level * W
      ctx.fillStyle = level > 0.5 ? '#22c55e' : level > 0.1 ? '#eab308' : '#ef4444'
      ctx.fillRect(0, 0, barW, H)
    })
    return unsub
  }, [channelId])

  return <canvas ref={canvasRef} width={200} height={8} style={{ width: '100%', height: 8 }} className="rounded-sm" />
}

export default function GatePanel({ channelId, channelName, onClose }) {
  const gate       = useMixerStore(s => s.channels.find(c => c.id === channelId)?.gate)
  const updateGate = useMixerStore(s => s.updateChannelGate)

  if (!gate) return null

  const set = (updates) => {
    updateGate(channelId, updates)
    if (audioEngine.initialized) audioEngine.setChannelGate(channelId, updates)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.8)' }}
      onClick={onClose}
    >
      <div
        className="bg-[#141414] border border-[#2a2a2a] rounded-lg p-5 w-96 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-[9px] text-[#737373] tracking-widest">GATE</p>
            <p className="text-sm text-[#e5e5e5] font-bold mt-0.5">{channelName}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => set({ bypass: !gate.bypass })}
              className={`text-[9px] px-2 py-1 rounded font-bold transition-colors ${
                gate.bypass
                  ? 'bg-[#2a2a2a] text-[#737373]'
                  : 'bg-[#22c55e] text-black'
              }`}
            >
              {gate.bypass ? 'BYPASS' : 'ACTIVO'}
            </button>
            <button onClick={onClose} className="text-[#737373] hover:text-white px-2 text-sm">✕</button>
          </div>
        </div>

        {/* Gate open/closed indicator */}
        <div className="mb-4">
          <p className="text-[8px] text-[#737373] mb-1 tracking-widest">APERTURA DE GATE</p>
          <GateIndicator channelId={channelId} />
        </div>

        <div className="flex flex-col gap-2.5">
          <Slider label="Threshold" min={-80} max={0}   step={0.5} value={gate.threshold}
            onChange={v => set({ threshold: v })} format={v => `${v} dB`} />
          <Slider label="Attack"    min={0.001} max={0.1} step={0.001} value={gate.attack}
            onChange={v => set({ attack: v })}    format={v => `${(v*1000).toFixed(1)} ms`} />
          <Slider label="Release"   min={0.01} max={1.0} step={0.01} value={gate.release}
            onChange={v => set({ release: v })}   format={v => `${(v*1000).toFixed(0)} ms`} />
          <Slider label="Range"     min={-80} max={0}   step={0.5} value={gate.range}
            onChange={v => set({ range: v })}     format={v => `${v} dB`} />
        </div>
      </div>
    </div>
  )
}
