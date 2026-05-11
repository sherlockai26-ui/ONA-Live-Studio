import React, { memo, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import useMixerStore from '../store/mixerStore.js'
import { audioEngine } from '../audio/audioEngine.js'

// Lightweight per-channel row — memo prevents re-renders from sibling channel changes
const ChannelSendRow = memo(function ChannelSendRow({ ch, onReverb, onDelay }) {
  return (
    <div className="flex flex-col gap-0.5 mb-2">
      <span className="text-[8px] text-[#f97316] font-bold truncate">{ch.name}</span>
      <div className="flex items-center gap-1">
        <span className="text-[8px] text-[#737373] w-5 shrink-0">R</span>
        <input
          type="range" min={0} max={100} step={1} value={ch.reverbSend}
          onChange={e => onReverb(ch.id, Number(e.target.value))}
          className="flex-1 h-1"
        />
        <span className="text-[8px] text-[#f97316] w-5 text-right shrink-0">{ch.reverbSend}</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[8px] text-[#737373] w-5 shrink-0">D</span>
        <input
          type="range" min={0} max={100} step={1} value={ch.delaySend}
          onChange={e => onDelay(ch.id, Number(e.target.value))}
          className="flex-1 h-1"
        />
        <span className="text-[8px] text-[#f97316] w-5 text-right shrink-0">{ch.delaySend}</span>
      </div>
    </div>
  )
})

function FXRack() {
  const reverb   = useMixerStore(useShallow(s => s.fx.reverb))
  const delay    = useMixerStore(useShallow(s => s.fx.delay))
  const fxReturn = useMixerStore(useShallow(s => s.fx.fxReturn))
  const updateFx = useMixerStore(s => s.updateFx)

  // Only subscribe to the fields needed for per-channel send rows
  const channelSends = useMixerStore(
    useShallow(s => s.channels.map(c => ({ id: c.id, name: c.name, reverbSend: c.reverbSend, delaySend: c.delaySend }))),
  )
  const updateChannel = useMixerStore(s => s.updateChannel)

  const setReverb = useCallback((updates) => {
    updateFx('reverb', updates)
    if (audioEngine.initialized) audioEngine.setGlobalReverb({ ...reverb, ...updates })
  }, [reverb, updateFx])

  const setDelay = useCallback((updates) => {
    updateFx('delay', updates)
    if (audioEngine.initialized) audioEngine.setGlobalDelay({ ...delay, ...updates })
  }, [delay, updateFx])

  const setReturn = useCallback((updates) => {
    updateFx('fxReturn', updates)
    if (audioEngine.initialized) audioEngine.setFxReturn({ ...fxReturn, ...updates })
  }, [fxReturn, updateFx])

  const handleReverbSend = useCallback((id, v) => {
    updateChannel(id, { reverbSend: v })
    if (audioEngine.initialized) audioEngine.setChannelReverbSend(id, v)
  }, [updateChannel])

  const handleDelaySend = useCallback((id, v) => {
    updateChannel(id, { delaySend: v })
    if (audioEngine.initialized) audioEngine.setChannelDelaySend(id, v)
  }, [updateChannel])

  return (
    <div className="border-b border-[#2a2a2a] p-3">
      <p className="text-[10px] text-[#f97316] font-bold mb-3 tracking-widest">FX RACK</p>

      {/* REVERB */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-[#e5e5e5]">REVERB</span>
          <button
            onClick={() => setReverb({ active: !reverb.active })}
            className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
              reverb.active ? 'bg-[#22c55e] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373]'
            }`}
          >
            {reverb.active ? 'ON' : 'OFF'}
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#737373] w-14">DECAY</span>
            <input
              type="range" min={0.1} max={8} step={0.1}
              value={reverb.decay}
              onChange={e => setReverb({ decay: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[9px] text-[#f97316] w-8 text-right">{reverb.decay.toFixed(1)}s</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#737373] w-14">PRE-DLY</span>
            <input
              type="range" min={0} max={100} step={1}
              value={reverb.preDelay}
              onChange={e => setReverb({ preDelay: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[9px] text-[#f97316] w-8 text-right">{reverb.preDelay}ms</span>
          </div>
        </div>
      </div>

      {/* DELAY */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-[#e5e5e5]">DELAY</span>
          <button
            onClick={() => setDelay({ active: !delay.active })}
            className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
              delay.active ? 'bg-[#22c55e] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373]'
            }`}
          >
            {delay.active ? 'ON' : 'OFF'}
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#737373] w-14">TIME</span>
            <input
              type="range" min={50} max={1000} step={1}
              value={delay.time}
              onChange={e => setDelay({ time: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[9px] text-[#f97316] w-12 text-right">{delay.time}ms</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#737373] w-14">FBACK</span>
            <input
              type="range" min={0} max={90} step={1}
              value={delay.feedback}
              onChange={e => setDelay({ feedback: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[9px] text-[#f97316] w-8 text-right">{delay.feedback}%</span>
          </div>
        </div>
      </div>

      {/* FX RETURN */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-[#e5e5e5]">FX RETURN</span>
          <button
            onClick={() => setReturn({ muted: !fxReturn.muted })}
            className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
              fxReturn.muted ? 'bg-[#ef4444] text-white font-bold' : 'bg-[#2a2a2a] text-[#737373]'
            }`}
          >
            {fxReturn.muted ? 'MUTE' : 'LIVE'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-[#737373] w-14">LEVEL</span>
          <input
            type="range" min={0} max={100} step={1}
            value={fxReturn.volume}
            onChange={e => setReturn({ volume: Number(e.target.value) })}
            className="flex-1"
          />
          <span className="text-[9px] text-[#f97316] w-8 text-right">{fxReturn.volume}</span>
        </div>
      </div>

      {/* CHANNEL SENDS — per-channel reverb + delay send levels */}
      <div>
        <p className="text-[9px] text-[#737373] font-bold mb-2 tracking-widest">SENDS</p>
        {channelSends.map(ch => (
          <ChannelSendRow
            key={ch.id}
            ch={ch}
            onReverb={handleReverbSend}
            onDelay={handleDelaySend}
          />
        ))}
      </div>
    </div>
  )
}

export default memo(FXRack)
