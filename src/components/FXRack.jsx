import React, { useState } from 'react'

export default function FXRack() {
  const [reverb, setReverb] = useState({ active: false, mix: 30, size: 50 })
  const [delay, setDelay]   = useState({ active: false, time: 300, feedback: 30 })

  return (
    <div className="border-b border-[#2a2a2a] p-3">
      <p className="text-[10px] text-[#f97316] font-bold mb-3 tracking-widest">
        FX RACK
      </p>
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-[#e5e5e5]">REVERB</span>
          <button
            onClick={() => setReverb(p => ({ ...p, active: !p.active }))}
            className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
              reverb.active ? 'bg-[#22c55e] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373]'
            }`}
          >
            {reverb.active ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className="flex gap-3">
          <div className="flex flex-col items-center gap-1">
            <span className="text-[9px] text-[#737373]">MIX</span>
            <input
              type="range" min={0} max={100}
              value={reverb.mix}
              onChange={e => setReverb(p => ({ ...p, mix: Number(e.target.value) }))}
              className="w-24"
            />
            <span className="text-[9px] text-[#f97316]">{reverb.mix}%</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-[9px] text-[#737373]">SIZE</span>
            <input
              type="range" min={0} max={100}
              value={reverb.size}
              onChange={e => setReverb(p => ({ ...p, size: Number(e.target.value) }))}
              className="w-24"
            />
            <span className="text-[9px] text-[#f97316]">{reverb.size}%</span>
          </div>
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-[#e5e5e5]">DELAY</span>
          <button
            onClick={() => setDelay(p => ({ ...p, active: !p.active }))}
            className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
              delay.active ? 'bg-[#22c55e] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373]'
            }`}
          >
            {delay.active ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className="flex gap-3">
          <div className="flex flex-col items-center gap-1">
            <span className="text-[9px] text-[#737373]">TIME</span>
            <input
              type="range" min={50} max={1000}
              value={delay.time}
              onChange={e => setDelay(p => ({ ...p, time: Number(e.target.value) }))}
              className="w-24"
            />
            <span className="text-[9px] text-[#f97316]">{delay.time}ms</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-[9px] text-[#737373]">FEEDBACK</span>
            <input
              type="range" min={0} max={90}
              value={delay.feedback}
              onChange={e => setDelay(p => ({ ...p, feedback: Number(e.target.value) }))}
              className="w-24"
            />
            <span className="text-[9px] text-[#f97316]">{delay.feedback}%</span>
          </div>
        </div>
      </div>
    </div>
  )
}
