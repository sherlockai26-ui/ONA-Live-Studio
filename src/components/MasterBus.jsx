import React from 'react'

export default function MasterBus({ volume, onChange }) {
  return (
    <div className="border-t border-[#2a2a2a] p-3">
      <p className="text-[10px] text-[#f97316] font-bold mb-3 tracking-widest">
        MASTER
      </p>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={e => onChange(Number(e.target.value))}
          style={{
            writingMode: 'vertical-lr',
            direction: 'rtl',
            width: '24px',
            height: '80px'
          }}
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs text-[#e5e5e5] font-bold">{volume}</span>
          <span className="text-[10px] text-[#737373]">Vol</span>
        </div>
      </div>
    </div>
  )
}
