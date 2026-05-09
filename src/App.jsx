import React, { useState } from 'react'
import Channel from './components/Channel'
import MasterBus from './components/MasterBus'
import FXRack from './components/FXRack'
import Recorder from './components/Recorder'

const INITIAL_CHANNELS = [
  { id: 1, name: 'Tololoche 1', color: '#f97316' },
  { id: 2, name: 'Tololoche 2', color: '#f97316' },
  { id: 3, name: 'Voz 1',       color: '#3b82f6' },
  { id: 4, name: 'Voz 2',       color: '#3b82f6' },
  { id: 5, name: 'Armonía',     color: '#22c55e' },
  { id: 6, name: 'Requinto',    color: '#a855f7' },
]

export default function App() {
  const [channels, setChannels] = useState(INITIAL_CHANNELS)
  const [masterVolume, setMasterVolume] = useState(80)

  const updateChannel = (id, updates) => {
    setChannels(prev =>
      prev.map(ch => ch.id === id ? { ...ch, ...updates } : ch)
    )
  }

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2 bg-[#141414] border-b border-[#2a2a2a]">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-[#22c55e] animate-pulse" />
          <span className="text-[#f97316] font-bold tracking-widest text-sm">
            ONA LIVE STUDIO
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-[#737373]">
          <span>Focusrite 18i20</span>
          <span className="text-[#22c55e]">● CONECTADO</span>
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 overflow-x-auto overflow-y-hidden border-r border-[#2a2a2a]">
          {channels.map(channel => (
            <Channel
              key={channel.id}
              channel={channel}
              onChange={updates => updateChannel(channel.id, updates)}
            />
          ))}
        </div>
        <div className="flex flex-col w-64 overflow-y-auto">
          <FXRack />
          <Recorder />
          <MasterBus
            volume={masterVolume}
            onChange={setMasterVolume}
          />
        </div>
      </div>
    </div>
  )
}
