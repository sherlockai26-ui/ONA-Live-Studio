import React, { useState, useCallback, memo } from 'react'
import { shallow } from 'zustand/shallow'
import EQPanel      from './EQPanel.jsx'
import CompPanel    from './CompPanel.jsx'
import GatePanel    from './GatePanel.jsx'
import { ProFader }     from '../ui/ProFader'
import { ConsoleMeter } from '../ui/ConsoleMeter'
import useMixerStore from '../store/mixerStore.js'
import { audioEngine } from '../audio/audioEngine.js'

function Channel({ channelId, inputList }) {
  // shallow prevents re-renders when OTHER channels change in the array
  const channel          = useMixerStore(s => s.channels.find(c => c.id === channelId), shallow)
  const updateChannel    = useMixerStore(s => s.updateChannel)
  const updateChannelHpf = useMixerStore(s => s.updateChannelHpf)

  const [eqOpen,      setEqOpen]      = useState(false)
  const [compOpen,    setCompOpen]    = useState(false)
  const [gateOpen,    setGateOpen]    = useState(false)
  const [editingName, setEditingName] = useState(false)

  if (!channel) return null
  const { name, color, volume, pan, muted, soloed, inputSource, toMain, toSub, hpf, reverbSend, delaySend, compressor, gate } = channel

  // Store + AudioEngine en una sola llamada
  const set = (updates) => {
    updateChannel(channelId, updates)
    if (!audioEngine.initialized) return
    if ('volume' in updates || 'muted' in updates) {
      const v = 'volume' in updates ? updates.volume : volume
      const m = 'muted'  in updates ? updates.muted  : muted
      audioEngine.setChannelVolume(channelId, v, m)
    }
    if ('pan' in updates) audioEngine.setChannelPan(channelId, updates.pan)
    if ('toMain' in updates || 'toSub' in updates) {
      audioEngine.setChannelRouting(
        channelId,
        'toMain' in updates ? updates.toMain : toMain,
        'toSub'  in updates ? updates.toSub  : toSub,
      )
    }
  }

  const setHpf = (updates) => {
    updateChannelHpf(channelId, updates)
    if (audioEngine.initialized) audioEngine.setChannelHpf(channelId, updates)
  }

  const setReverbSend = (v) => {
    updateChannel(channelId, { reverbSend: v })
    if (audioEngine.initialized) audioEngine.setChannelReverbSend(channelId, v)
  }

  const setDelaySend = (v) => {
    updateChannel(channelId, { delaySend: v })
    if (audioEngine.initialized) audioEngine.setChannelDelaySend(channelId, v)
  }

  return (
    <>
      <div
        className="relative flex flex-col items-center w-28 min-w-[112px] border-r border-[#2a2a2a] bg-[#141414] py-2 gap-1"
        style={{ borderTop: `2px solid ${color}` }}
      >
        {/* Nombre editable (doble clic) */}
        {editingName ? (
          <input
            autoFocus
            className="text-[10px] text-[#e5e5e5] bg-[#2a2a2a] rounded px-1 w-24 text-center outline-none border border-[#f97316]"
            value={name}
            onChange={e => updateChannel(channelId, { name: e.target.value })}
            onBlur={() => setEditingName(false)}
            onKeyDown={e => e.key === 'Enter' && setEditingName(false)}
          />
        ) : (
          <span
            className="text-[10px] text-[#e5e5e5] text-center leading-tight px-1 truncate w-full cursor-pointer hover:text-[#f97316] transition-colors"
            onDoubleClick={() => setEditingName(true)}
            title="Doble clic para renombrar"
          >
            {name}
          </span>
        )}

        {/* Input source */}
        <select
          value={inputSource ?? '—'}
          onChange={e => set({ inputSource: e.target.value === '—' ? null : e.target.value })}
          className="text-[9px] bg-[#2a2a2a] text-[#737373] border border-[#3a3a3a] rounded px-1 py-0.5 w-24 cursor-pointer"
          style={{ outline: 'none' }}
        >
          {(inputList ?? ['—']).map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        {/* Meter + Fader lado a lado */}
        <div className="flex items-end gap-2 px-1">
          <ConsoleMeter
            channelId={channelId}
            getLevel={() => {
              if (!audioEngine.initialized) return 0
              try { return audioEngine.getMeterBuffer()[channelId - 1] ?? 0 } catch { return 0 }
            }}
            width={10}
            height={80}
          />
          <ProFader
            value={volume}
            onChange={v => set({ volume: Math.round(v) })}
            height={80}
            width={24}
            liveUpdate
            data-ch={channelId}
          />
        </div>

        {/* Valor del fader */}
        <span className="text-[10px] text-[#737373]">{volume}</span>

        {/* PAN */}
        <div className="flex flex-col items-center w-full px-2 gap-0.5">
          <div className="flex justify-between w-full">
            <span className="text-[8px] text-[#737373]">L</span>
            <span className="text-[8px] text-[#f97316]">
              {pan === 0 ? 'C' : pan > 0 ? `R${Math.round(pan * 100)}` : `L${Math.round(-pan * 100)}`}
            </span>
            <span className="text-[8px] text-[#737373]">R</span>
          </div>
          <input
            type="range" min={-1} max={1} step={0.01} value={pan}
            onChange={e => set({ pan: Number(e.target.value) })}
            onDoubleClick={() => set({ pan: 0 })}
            className="w-full"
            title="Doble clic para centrar"
          />
        </div>

        {/* HPF */}
        <div className="flex items-center gap-1 w-full px-2">
          <button
            onClick={() => setHpf({ active: !hpf.active })}
            className={`text-[8px] px-1.5 py-0.5 rounded font-bold transition-colors shrink-0 ${
              hpf.active ? 'bg-[#3b82f6] text-white' : 'bg-[#2a2a2a] text-[#737373]'
            }`}
          >
            HPF
          </button>
          <input
            type="range" min={20} max={400} step={5} value={hpf.freq}
            onChange={e => setHpf({ freq: Number(e.target.value) })}
            className="flex-1"
            title={`${hpf.freq} Hz`}
          />
          <span className="text-[8px] text-[#737373] w-8 text-right shrink-0">{hpf.freq}</span>
        </div>

        {/* COMP + GATE */}
        <div className="flex gap-1 w-full px-2">
          <button
            onClick={() => setCompOpen(true)}
            className={`text-[9px] py-1 rounded flex-1 transition-colors ${
              !compressor.bypass ? 'bg-[#f97316] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373] hover:bg-[#f97316] hover:text-black'
            }`}
          >
            COMP
          </button>
          <button
            onClick={() => setGateOpen(true)}
            className={`text-[9px] py-1 rounded flex-1 transition-colors ${
              !gate.bypass ? 'bg-[#22c55e] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373] hover:bg-[#22c55e] hover:text-black'
            }`}
          >
            GATE
          </button>
        </div>

        {/* Reverb send */}
        <div className="flex items-center gap-1 w-full px-2">
          <span className="text-[8px] text-[#737373] w-7 shrink-0">REV</span>
          <input
            type="range" min={0} max={100} step={1} value={reverbSend}
            onChange={e => setReverbSend(Number(e.target.value))}
            className="flex-1"
          />
          <span className="text-[8px] text-[#737373] w-6 text-right shrink-0">{reverbSend}</span>
        </div>

        {/* Delay send */}
        <div className="flex items-center gap-1 w-full px-2">
          <span className="text-[8px] text-[#737373] w-7 shrink-0">DLY</span>
          <input
            type="range" min={0} max={100} step={1} value={delaySend}
            onChange={e => setDelaySend(Number(e.target.value))}
            className="flex-1"
          />
          <span className="text-[8px] text-[#737373] w-6 text-right shrink-0">{delaySend}</span>
        </div>

        {/* EQ */}
        <button
          onClick={() => setEqOpen(true)}
          className="text-[9px] px-2 py-1 rounded w-24 transition-colors bg-[#2a2a2a] text-[#737373] hover:bg-[#f97316] hover:text-black"
        >
          EQ
        </button>

        {/* MUTE */}
        <button
          onClick={() => set({ muted: !muted })}
          className={`text-[9px] px-2 py-1 rounded w-24 transition-colors ${
            muted ? 'bg-[#ef4444] text-white font-bold' : 'bg-[#2a2a2a] text-[#737373]'
          }`}
        >
          MUTE
        </button>

        {/* SOLO */}
        <button
          onClick={() => set({ soloed: !soloed })}
          className={`text-[9px] px-2 py-1 rounded w-24 transition-colors ${
            soloed ? 'bg-[#eab308] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373]'
          }`}
        >
          SOLO
        </button>

        {/* Routing MAIN / SUB */}
        <div className="flex gap-1 mt-0.5">
          <button
            onClick={() => set({ toMain: !toMain })}
            title="Enviar a Main Mix"
            className={`text-[8px] font-bold w-11 py-0.5 rounded transition-colors ${
              toMain ? 'bg-[#f97316] text-black' : 'bg-[#2a2a2a] text-[#737373]'
            }`}
          >
            MAIN
          </button>
          <button
            onClick={() => set({ toSub: !toSub })}
            title="Enviar a Sub 1-2"
            className={`text-[8px] font-bold w-11 py-0.5 rounded transition-colors ${
              toSub ? 'bg-[#3b82f6] text-white' : 'bg-[#2a2a2a] text-[#737373]'
            }`}
          >
            SUB
          </button>
        </div>
      </div>

      {eqOpen   && <EQPanel   channelId={channelId} channelName={name} onClose={() => setEqOpen(false)} />}
      {compOpen && <CompPanel channelId={channelId} channelName={name} onClose={() => setCompOpen(false)} />}
      {gateOpen && <GatePanel channelId={channelId} channelName={name} onClose={() => setGateOpen(false)} />}
    </>
  )
}

// memo: evita re-renders cuando el padre re-renderiza pero channelId/inputList no cambian.
// shallow en el selector de arriba: evita re-renders cuando OTROS canales cambian en el array.
export default memo(Channel)
