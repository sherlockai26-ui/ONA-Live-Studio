import React from 'react'
import useMixerStore from '../store/mixerStore.js'
import { audioEngine } from '../audio/audioEngine.js'

export default function FXRack() {
  const fx       = useMixerStore(s => s.fx)
  const updateFx = useMixerStore(s => s.updateFx)

  const setReverb = (updates) => {
    updateFx('reverb', updates)
    if (audioEngine.initialized) audioEngine.setGlobalReverb({ ...fx.reverb, ...updates })
  }

  const setDelay = (updates) => {
    updateFx('delay', updates)
    if (audioEngine.initialized) audioEngine.setGlobalDelay({ ...fx.delay, ...updates })
  }

  const setReturn = (updates) => {
    updateFx('fxReturn', updates)
    if (audioEngine.initialized) audioEngine.setFxReturn({ ...fx.fxReturn, ...updates })
  }

  return (
    <div className="border-b border-[#2a2a2a] p-3">
      <p className="text-[10px] text-[#f97316] font-bold mb-3 tracking-widest">FX RACK</p>

      {/* REVERB */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-[#e5e5e5]">REVERB</span>
          <button
            onClick={() => setReverb({ active: !fx.reverb.active })}
            className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
              fx.reverb.active ? 'bg-[#22c55e] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373]'
            }`}
          >
            {fx.reverb.active ? 'ON' : 'OFF'}
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#737373] w-14">DECAY</span>
            <input
              type="range" min={0.1} max={8} step={0.1}
              value={fx.reverb.decay}
              onChange={e => setReverb({ decay: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[9px] text-[#f97316] w-8 text-right">{fx.reverb.decay.toFixed(1)}s</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#737373] w-14">PRE-DLY</span>
            <input
              type="range" min={0} max={100} step={1}
              value={fx.reverb.preDelay}
              onChange={e => setReverb({ preDelay: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[9px] text-[#f97316] w-8 text-right">{fx.reverb.preDelay}ms</span>
          </div>
        </div>
      </div>

      {/* DELAY */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-[#e5e5e5]">DELAY</span>
          <button
            onClick={() => setDelay({ active: !fx.delay.active })}
            className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
              fx.delay.active ? 'bg-[#22c55e] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373]'
            }`}
          >
            {fx.delay.active ? 'ON' : 'OFF'}
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#737373] w-14">TIME</span>
            <input
              type="range" min={50} max={1000} step={1}
              value={fx.delay.time}
              onChange={e => setDelay({ time: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[9px] text-[#f97316] w-12 text-right">{fx.delay.time}ms</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#737373] w-14">FBACK</span>
            <input
              type="range" min={0} max={90} step={1}
              value={fx.delay.feedback}
              onChange={e => setDelay({ feedback: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[9px] text-[#f97316] w-8 text-right">{fx.delay.feedback}%</span>
          </div>
        </div>
      </div>

      {/* FX RETURN */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-[#e5e5e5]">FX RETURN</span>
          <button
            onClick={() => setReturn({ muted: !fx.fxReturn.muted })}
            className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
              fx.fxReturn.muted ? 'bg-[#ef4444] text-white font-bold' : 'bg-[#2a2a2a] text-[#737373]'
            }`}
          >
            {fx.fxReturn.muted ? 'MUTE' : 'LIVE'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-[#737373] w-14">LEVEL</span>
          <input
            type="range" min={0} max={100} step={1}
            value={fx.fxReturn.volume}
            onChange={e => setReturn({ volume: Number(e.target.value) })}
            className="flex-1"
          />
          <span className="text-[9px] text-[#f97316] w-8 text-right">{fx.fxReturn.volume}</span>
        </div>
      </div>
    </div>
  )
}
