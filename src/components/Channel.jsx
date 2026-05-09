import React, { useState } from 'react'
import EQBand from './EQBand'

const EQ_BANDS = [
  { id: 'b1', label: '60',  freq: 60,    defaultGain: 0 },
  { id: 'b2', label: '125', freq: 125,   defaultGain: 0 },
  { id: 'b3', label: '250', freq: 250,   defaultGain: 0 },
  { id: 'b4', label: '500', freq: 500,   defaultGain: 0 },
  { id: 'b5', label: '1k',  freq: 1000,  defaultGain: 0 },
  { id: 'b6', label: '4k',  freq: 4000,  defaultGain: 0 },
  { id: 'b7', label: '12k', freq: 12000, defaultGain: 0 },
]

export default function Channel({ channel, onChange }) {
  const [volume, setVolume] = useState(75)
  const [muted, setMuted]   = useState(false)
  const [soloed, setSoloed] = useState(false)
  const [eqOpen, setEqOpen] = useState(false)
  const [gains, setGains]   = useState(
    Object.fromEntries(EQ_BANDS.map(b => [b.id, b.defaultGain]))
  )

  const handleVolume = (val) => {
    setVolume(val)
    onChange({ volume: val })
  }

  const handleGain = (bandId, val) => {
    setGains(prev => ({ ...prev, [bandId]: val }))
  }

  return (
    <div
      className="flex flex-col items-center w-20 min-w-[80px] border-r border-[#2a2a2a] bg-[#141414] py-2 gap-2"
      style={{ borderTop: `2px solid ${channel.color}` }}
    >
      <span className="text-[10px] text-[#e5e5e5] text-center leading-tight px-1 truncate w-full text-center">
        {channel.name}
      </span>
      <div className="w-3 h-24 bg-[#2a2a2a] rounded-full overflow-hidden flex flex-col-reverse">
        <div
          className="w-full rounded-full transition-all duration-100"
          style={{
            height: `${muted ? 0 : volume}%`,
            background: volume > 85 ? '#ef4444' : volume > 65 ? '#eab308' : '#22c55e'
          }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={volume}
        onChange={e => handleVolume(Number(e.target.value))}
        className="h-24"
        style={{ writingMode: 'vertical-lr', direction: 'rtl', width: '24px' }}
      />
      <span className="text-[10px] text-[#737373]">{volume}</span>
      <button
        onClick={() => setEqOpen(!eqOpen)}
        className={`text-[9px] px-2 py-1 rounded w-14 transition-colors ${
          eqOpen ? 'bg-[#f97316] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373]'
        }`}
      >
        EQ
      </button>
      <button
        onClick={() => setMuted(!muted)}
        className={`text-[9px] px-2 py-1 rounded w-14 transition-colors ${
          muted ? 'bg-[#ef4444] text-white font-bold' : 'bg-[#2a2a2a] text-[#737373]'
        }`}
      >
        MUTE
      </button>
      <button
        onClick={() => setSoloed(!soloed)}
        className={`text-[9px] px-2 py-1 rounded w-14 transition-colors ${
          soloed ? 'bg-[#eab308] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373]'
        }`}
      >
        SOLO
      </button>
      {eqOpen && (
        <div className="absolute z-10 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 mt-2 shadow-xl">
          <p className="text-[10px] text-[#f97316] font-bold mb-2 text-center">
            EQ — {channel.name}
          </p>
          <div className="flex gap-2">
            {EQ_BANDS.map(band => (
              <EQBand
                key={band.id}
                band={band}
                gain={gains[band.id]}
                onChange={val => handleGain(band.id, val)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
