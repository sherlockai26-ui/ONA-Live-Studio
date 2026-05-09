import React, { useState } from 'react'

export default function Recorder() {
  const [recording, setRecording] = useState(false)
  const [mode, setMode]           = useState('crudo')

  return (
    <div className="border-b border-[#2a2a2a] p-3">
      <p className="text-[10px] text-[#f97316] font-bold mb-3 tracking-widest">
        GRABACIÓN
      </p>
      <div className="flex gap-1 mb-3">
        {['crudo', 'procesado'].map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 text-[9px] py-1 rounded capitalize transition-colors ${
              mode === m ? 'bg-[#f97316] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373]'
            }`}
          >
            {m}
          </button>
        ))}
      </div>
      <button
        onClick={() => setRecording(!recording)}
        className={`w-full py-2 rounded text-xs font-bold transition-colors ${
          recording ? 'bg-[#ef4444] text-white animate-pulse' : 'bg-[#2a2a2a] text-[#737373]'
        }`}
      >
        {recording ? '⏹ DETENER' : '⏺ GRABAR'}
      </button>
      {recording && (
        <p className="text-[10px] text-[#ef4444] text-center mt-2 animate-pulse">
          ● REC — modo {mode}
        </p>
      )}
    </div>
  )
}
