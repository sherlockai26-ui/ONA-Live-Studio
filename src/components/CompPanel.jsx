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

function GRMeter({ channelId }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height

    const unsub = audioEngine.onMeterUpdate((data) => {
      const gr = Math.abs(data[`gr_${channelId}`] ?? 0)
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#111'
      ctx.fillRect(0, 0, W, H)
      const frac  = Math.min(gr / 30, 1)
      const barW  = frac * W
      ctx.fillStyle = gr > 15 ? '#ef4444' : gr > 8 ? '#eab308' : '#22c55e'
      ctx.fillRect(0, 0, barW, H)
    })
    return unsub
  }, [channelId])

  return <canvas ref={canvasRef} width={200} height={8} style={{ width: '100%', height: 8 }} className="rounded-sm" />
}

export default function CompPanel({ channelId, channelName, onClose }) {
  const comp       = useMixerStore(s => s.channels.find(c => c.id === channelId)?.compressor)
  const updateComp = useMixerStore(s => s.updateChannelComp)

  if (!comp) return null

  const set = (updates) => {
    updateComp(channelId, updates)
    if (audioEngine.initialized) audioEngine.setChannelCompressor(channelId, updates)
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
            <p className="text-[9px] text-[#737373] tracking-widest">COMPRESOR</p>
            <p className="text-sm text-[#e5e5e5] font-bold mt-0.5">{channelName}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => set({ bypass: !comp.bypass })}
              className={`text-[9px] px-2 py-1 rounded font-bold transition-colors ${
                comp.bypass
                  ? 'bg-[#2a2a2a] text-[#737373]'
                  : 'bg-[#f97316] text-black'
              }`}
            >
              {comp.bypass ? 'BYPASS' : 'ACTIVO'}
            </button>
            <button onClick={onClose} className="text-[#737373] hover:text-white px-2 text-sm">✕</button>
          </div>
        </div>

        {/* GR meter */}
        <div className="mb-4">
          <p className="text-[8px] text-[#737373] mb-1 tracking-widest">GAIN REDUCTION</p>
          <GRMeter channelId={channelId} />
        </div>

        <div className="flex flex-col gap-2.5">
          <Slider label="Threshold" min={-60} max={0}   step={0.5} value={comp.threshold}
            onChange={v => set({ threshold: v })}  format={v => `${v} dB`} />
          <Slider label="Ratio"     min={1}   max={20}  step={0.5} value={comp.ratio}
            onChange={v => set({ ratio: v })}      format={v => `${v}:1`} />
          <Slider label="Attack"    min={0.001} max={0.3} step={0.001} value={comp.attack}
            onChange={v => set({ attack: v })}     format={v => `${(v*1000).toFixed(1)} ms`} />
          <Slider label="Release"   min={0.01} max={1.0} step={0.01} value={comp.release}
            onChange={v => set({ release: v })}    format={v => `${(v*1000).toFixed(0)} ms`} />
          <Slider label="Knee"      min={0}   max={12}  step={0.5} value={comp.knee}
            onChange={v => set({ knee: v })}       format={v => `${v} dB`} />
          <Slider label="Makeup"    min={0}   max={20}  step={0.5} value={comp.makeupGain}
            onChange={v => set({ makeupGain: v })} format={v => `+${v} dB`} />
        </div>
      </div>
    </div>
  )
}
