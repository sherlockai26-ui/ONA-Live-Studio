import React, { memo, useCallback } from 'react'
import useMixerStore from '../store/mixerStore.js'
import { audioEngine } from '../audio/audioEngine.js'

const Fader = memo(function Fader({ label, volume, colorClass, onChangeVolume }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[9px] text-[#737373] tracking-wider">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0} max={100}
          value={volume}
          onChange={e => onChangeVolume(Number(e.target.value))}
          style={{ writingMode: 'vertical-lr', direction: 'rtl', width: '24px', height: '80px' }}
        />
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-[#e5e5e5] font-bold">{volume}</span>
          <span className={`text-[10px] ${colorClass}`}>Vol</span>
        </div>
      </div>
    </div>
  )
})

function MasterBus() {
  const mainVolume  = useMixerStore(s => s.mainVolume)
  const subVolume   = useMixerStore(s => s.subVolume)
  const setMain     = useMixerStore(s => s.setMainVolume)
  const setSub      = useMixerStore(s => s.setSubVolume)

  const handleMain = useCallback((v) => {
    setMain(v)
    if (audioEngine.initialized) audioEngine.setMainVolume(v)
  }, [setMain])

  const handleSub = useCallback((v) => {
    setSub(v)
    if (audioEngine.initialized) audioEngine.setSubVolume(v)
  }, [setSub])

  return (
    <div className="border-t border-[#2a2a2a] p-3">
      <p className="text-[10px] text-[#f97316] font-bold mb-3 tracking-widest">
        MASTER
      </p>
      <div className="flex gap-5">
        <Fader
          label="MAIN"
          volume={mainVolume}
          colorClass="text-[#f97316]"
          onChangeVolume={handleMain}
        />
        <Fader
          label="SUB 1-2"
          volume={subVolume}
          colorClass="text-[#3b82f6]"
          onChangeVolume={handleSub}
        />
      </div>
    </div>
  )
}

export default memo(MasterBus)
