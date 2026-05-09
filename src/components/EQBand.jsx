import React from 'react'

export default function EQBand({ band, gain, onChange }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[9px] text-[#f97316] font-bold">
        {gain > 0 ? `+${gain}` : gain}
      </span>
      <input
        type="range"
        min={-12}
        max={12}
        value={gain}
        onChange={e => onChange(Number(e.target.value))}
        style={{
          writingMode: 'vertical-lr',
          direction: 'rtl',
          width: '20px',
          height: '80px'
        }}
      />
      <span className="text-[9px] text-[#737373]">{band.label}</span>
    </div>
  )
}
