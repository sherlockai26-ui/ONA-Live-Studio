import React, { useState } from 'react'
import useMixerStore from '../store/mixerStore.js'
import { audioEngine } from '../audio/audioEngine.js'

export default function VirtualSoundcheck() {
  const channels  = useMixerStore(s => s.channels)
  const [vsMode,  setVsMode]  = useState(false)
  const [playing, setPlaying] = useState(false)
  const [tracks,  setTracks]  = useState({})   // { channelId: filename }
  const [loading, setLoading] = useState(null)

  const pickFile = async (channelId) => {
    if (!window.electronAPI) return
    const paths = await window.electronAPI.showOpenDialog({ multiSelections: false })
    if (!paths.length) return
    const filePath = paths[0]
    const filename = filePath.split(/[\\/]/).pop()

    setLoading(channelId)
    try {
      await audioEngine.loadVSTrack(channelId, filePath)
      setTracks(prev => ({ ...prev, [channelId]: filename }))
    } catch (err) {
      console.error('[VS] Error cargando track:', err)
    } finally {
      setLoading(null)
    }
  }

  const handlePlayPause = () => {
    if (!playing) {
      audioEngine.startVS()
      setPlaying(true)
    } else {
      audioEngine.pauseVS()
      setPlaying(false)
    }
  }

  const handleStop = () => {
    audioEngine.stopVS()
    setPlaying(false)
  }

  return (
    <div className="border-b border-[#2a2a2a] p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] text-[#f97316] font-bold tracking-widest">VIRTUAL SOUNDCHECK</p>
        <button
          onClick={() => { setVsMode(v => !v); if (playing) handleStop() }}
          className={`text-[9px] px-2 py-0.5 rounded font-bold transition-colors ${
            vsMode ? 'bg-[#f97316] text-black' : 'bg-[#2a2a2a] text-[#737373]'
          }`}
        >
          {vsMode ? 'ON' : 'OFF'}
        </button>
      </div>

      {vsMode && (
        <>
          {/* Transport controls */}
          <div className="flex gap-1 mb-3">
            <button
              onClick={handlePlayPause}
              disabled={!Object.keys(tracks).length}
              className={`flex-1 py-1.5 rounded text-[9px] font-bold transition-colors disabled:opacity-40 ${
                playing ? 'bg-[#eab308] text-black' : 'bg-[#22c55e] text-black'
              }`}
            >
              {playing ? '⏸ PAUSA' : '▶ PLAY'}
            </button>
            <button
              onClick={handleStop}
              className="flex-1 py-1.5 rounded text-[9px] font-bold bg-[#2a2a2a] text-[#737373] hover:bg-[#ef4444] hover:text-white transition-colors"
            >
              ⏹ STOP
            </button>
          </div>

          {/* Per-channel file selection */}
          <div className="flex flex-col gap-1 max-h-36 overflow-y-auto">
            {channels.map(ch => (
              <div key={ch.id} className="flex items-center gap-1">
                <span
                  className="text-[8px] font-bold w-4 shrink-0"
                  style={{ color: ch.color }}
                >
                  {ch.id}
                </span>
                <span className="flex-1 text-[8px] text-[#737373] truncate">
                  {loading === ch.id
                    ? 'Cargando...'
                    : tracks[ch.id] ?? 'Sin archivo'}
                </span>
                <button
                  onClick={() => pickFile(ch.id)}
                  disabled={loading !== null}
                  className="text-[8px] px-1.5 py-0.5 rounded bg-[#2a2a2a] text-[#737373] hover:bg-[#3b82f6] hover:text-white transition-colors disabled:opacity-40 shrink-0"
                >
                  …
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
