import React, { useEffect, useRef, useState } from 'react'
import Channel           from './components/Channel.jsx'
import MasterBus         from './components/MasterBus.jsx'
import FXRack            from './components/FXRack.jsx'
import Recorder          from './components/Recorder.jsx'
import RemotePanel       from './components/RemotePanel.jsx'
import SceneManager      from './components/SceneManager.jsx'
import VirtualSoundcheck from './components/VirtualSoundcheck.jsx'
import useMixerStore     from './store/mixerStore.js'
import { audioEngine }   from './audio/audioEngine.js'
import { useDevices }    from './hooks/useDevices.js'
import networkClient     from './network/client/NetworkClient'
import { uiFailsafe }    from './ui/UIFailsafe'
import { sceneEngine }   from './live/SceneEngine'
import './ui/console.css'

// Safe Mode: detectado en main.jsx y propagado a window.__ONA_SAFE_MODE
const SAFE_MODE = window.__ONA_SAFE_MODE === true || window.ona?.safeMode === true

export default function App() {
  const channels      = useMixerStore(s => s.channels)
  const loadFullState = useMixerStore(s => s.loadFullState)

  const { primaryInterface, inputList, status, refreshDeviceLabels } = useDevices()
  const [engineReady,   setEngineReady]   = useState(false)
  const [engineLoading, setEngineLoading] = useState(false)
  const [initError,     setInitError]     = useState(null)
  const syncRef = useRef(false)

  // ── Inicializar AudioEngine en primer clic ────────────────────────────────
  useEffect(() => {
    if (SAFE_MODE) {
      console.log('[BOOT] AUDIO DISABLED — Safe Mode')
      return
    }

    const init = async () => {
      if (engineReady || engineLoading) return
      setEngineLoading(true)
      console.log('[BOOT] Iniciando AudioEngine...')
      try {
        await audioEngine.initialize(channels.length, useMixerStore.getState())
        setEngineReady(true)
        setInitError(null)
        console.log('[BOOT] AudioEngine listo')

        // Wire SceneEngine DSP callback — applies recalled scene to both DSP + store.
        // try/finally guarantees loadFullState always runs: DSP and UI store stay in sync
        // even if applyEngineSnapshot throws (e.g. partial node failure).
        sceneEngine.setApplyDSPCallback(async (snapshot) => {
          try {
            audioEngine.applyEngineSnapshot(snapshot)
          } catch (err) {
            console.error('[SCENE] applyEngineSnapshot falló — store se actualizará de todas formas:', err)
          } finally {
            useMixerStore.getState().loadFullState({
              channels:   snapshot.channels,
              mainVolume: snapshot.buses.mainVolume,
              subVolume:  snapshot.buses.subVolume,
              fx:         snapshot.fx,
            })
          }
        })

        // Start adaptive UI quality monitoring (Paso 17)
        uiFailsafe.start()

        // getUserMedia is safe after Tone.start() creates the AudioContext
        refreshDeviceLabels().catch(() => {})
      } catch (err) {
        console.error('[BOOT] AudioEngine FAILED:', err)
        setInitError(err.message ?? String(err))
      } finally {
        setEngineLoading(false)
      }
    }

    const handler = () => init()
    window.addEventListener('click', handler, { once: true })
    return () => window.removeEventListener('click', handler)
  }, [])

  // ── Networking multi-dispositivo (solo si engine listo y no safe mode) ────
  useEffect(() => {
    if (!engineReady || SAFE_MODE) return

    let unsubCmd  = () => {}
    let unsubSync = () => {}

    const connectNetwork = async () => {
      try {
        // Wire outgoing: AudioBridge → networkClient (sync suppresses echo)
        audioEngine.setSyncCallback((type, channelId, payload) => {
          if (syncRef.current) return
          networkClient.sendCommand(type, channelId, payload)
        })

        // Wire incoming: remote commands → store + engine
        unsubCmd = networkClient.onCommand((cmd) => {
          const { type, channelId: ch, payload } = cmd
          syncRef.current = true
          try {
            switch (type) {
              case 'SET_GAIN':
                useMixerStore.getState().updateChannel(ch, { volume: payload.volume, muted: payload.muted })
                if (audioEngine.initialized) audioEngine.setChannelVolume(ch, payload.volume, payload.muted)
                break
              case 'SET_PAN':
                useMixerStore.getState().updateChannel(ch, { pan: payload.pan })
                if (audioEngine.initialized) audioEngine.setChannelPan(ch, payload.pan)
                break
              case 'SET_ROUTING':
                useMixerStore.getState().updateChannel(ch, { toMain: payload.toMain, toSub: payload.toSub })
                if (audioEngine.initialized) audioEngine.setChannelRouting(ch, payload.toMain, payload.toSub)
                break
              case 'SET_HPF':
                useMixerStore.getState().updateChannelHpf(ch, payload)
                if (audioEngine.initialized) audioEngine.setChannelHpf(ch, payload)
                break
              case 'SET_MAIN_VOL':
                useMixerStore.getState().setMainVolume(payload.volume)
                if (audioEngine.initialized) audioEngine.setMainVolume(payload.volume)
                break
              case 'SET_SUB_VOL':
                useMixerStore.getState().setSubVolume(payload.volume)
                if (audioEngine.initialized) audioEngine.setSubVolume(payload.volume)
                break
              case 'SET_REVERB':
                useMixerStore.getState().updateFx('reverb', payload)
                if (audioEngine.initialized) audioEngine.setGlobalReverb(payload)
                break
              case 'SET_DELAY':
                useMixerStore.getState().updateFx('delay', payload)
                if (audioEngine.initialized) audioEngine.setGlobalDelay(payload)
                break
            }
          } finally {
            requestAnimationFrame(() => { syncRef.current = false })
          }
        })

        // Full state sync on reconnect
        unsubSync = networkClient.onStateSync((data) => {
          if (!syncRef.current) loadFullState(data.state)
        })

        // Auto-discover server; standalone mode if not found
        networkClient.connectAuto().catch(() => {})
        console.log('[BOOT] NetworkClient wired')
      } catch (err) {
        console.warn('[BOOT] Network setup failed — standalone mode:', err)
      }
    }

    connectNetwork()
    return () => {
      unsubCmd()
      unsubSync()
      audioEngine.setSyncCallback(null)
    }
  }, [engineReady, loadFullState])

  // ── Header info ───────────────────────────────────────────────────────────
  const deviceLabel = primaryInterface
    ? primaryInterface.info.name
    : status === 'detectando' ? 'Detectando...' : 'Sin interfaz'

  const dotColor =
    status === 'conectado'  ? '#22c55e' :
    status === 'detectando' ? '#eab308' : '#ef4444'

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] overflow-hidden">

      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 bg-[#141414] border-b border-[#2a2a2a]">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-[#22c55e] animate-pulse" />
          <span className="text-[#f97316] font-bold tracking-widest text-sm">ONA LIVE STUDIO</span>
          {SAFE_MODE && (
            <span className="text-[8px] bg-[#eab308] text-black px-1.5 py-0.5 rounded font-bold">SAFE</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-[#737373]">{deviceLabel}</span>
          <span style={{ color: dotColor }}>
            ● {status === 'conectado' ? 'CONECTADO' : status === 'detectando' ? 'BUSCANDO' : 'SIN INTERFAZ'}
          </span>
          {engineLoading && (
            <span className="text-[9px] text-[#eab308] animate-pulse">⏳ Iniciando audio...</span>
          )}
          {!SAFE_MODE && !engineReady && !engineLoading && !initError && (
            <span className="text-[9px] text-[#737373] italic">Clic para activar audio</span>
          )}
          {engineReady && (
            <span className="text-[9px] text-[#22c55e]">✓ Audio activo</span>
          )}
          {initError && (
            <span className="text-[9px] text-[#ef4444]" title={initError}>⚠ Error de audio</span>
          )}
        </div>
      </header>

      {/* Overlay de carga */}
      {engineLoading && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}>
          <div className="bg-[#141414] border border-[#2a2a2a] rounded-xl px-8 py-6 flex flex-col items-center gap-3">
            <div className="w-3 h-3 rounded-full bg-[#f97316] animate-ping" />
            <span className="text-[#e5e5e5] text-sm font-bold tracking-widest">ONA LIVE STUDIO</span>
            <span className="text-[#737373] text-xs">Iniciando motor de audio...</span>
          </div>
        </div>
      )}

      {/* Layout principal */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 overflow-x-auto overflow-y-hidden border-r border-[#2a2a2a]">
          {channels.map(ch => (
            <Channel key={ch.id} channelId={ch.id} inputList={inputList} />
          ))}
        </div>

        <div className="flex flex-col w-64 overflow-y-auto">
          <SceneManager />
          <VirtualSoundcheck />
          <FXRack />
          <Recorder />
          <RemotePanel />
          <MasterBus />
        </div>
      </div>
    </div>
  )
}
