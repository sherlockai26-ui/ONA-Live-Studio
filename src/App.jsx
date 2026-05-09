import React, { useEffect, useRef, useState } from 'react'
import Channel           from './components/Channel.jsx'
import MasterBus         from './components/MasterBus.jsx'
import FXRack            from './components/FXRack.jsx'
import Recorder          from './components/Recorder.jsx'
import SceneManager      from './components/SceneManager.jsx'
import VirtualSoundcheck from './components/VirtualSoundcheck.jsx'
import useMixerStore     from './store/mixerStore.js'
import { audioEngine }   from './audio/audioEngine.js'
import { useDevices }    from './hooks/useDevices.js'

export default function App() {
  const channels      = useMixerStore(s => s.channels)
  const loadFullState = useMixerStore(s => s.loadFullState)

  const { primaryInterface, inputList, status } = useDevices()
  const [engineReady, setEngineReady] = useState(false)
  const [initError,   setInitError]   = useState(null)

  // Inicializar AudioEngine en la primera interacción del usuario.
  // La Web Audio API exige un gesto del usuario para resumir el AudioContext.
  useEffect(() => {
    const init = async () => {
      if (engineReady) return
      try {
        await audioEngine.initialize(channels.length, useMixerStore.getState())
        setEngineReady(true)
        setInitError(null)
      } catch (err) {
        console.error('[ONA] AudioEngine init failed:', err)
        setInitError(err.message ?? String(err))
      }
    }
    window.addEventListener('click', init, { once: true })
    return () => window.removeEventListener('click', init)
  }, [])

  // ── Sync multi-dispositivo ─────────────────────────────────────────────────
  // La conexión Socket.IO se hace de forma lazy (solo cuando el engine esté listo
  // y haya un servidor corriendo). Esto evita que Socket.IO tire errores de red
  // no manejados en el renderer de Electron mientras se desarrolla localmente.
  const syncRef = useRef(false)
  useEffect(() => {
    if (!engineReady) return   // no conectar hasta que el engine esté listo

    let syncService
    let unsub       = () => {}
    let unsubStore  = () => {}

    const connectSync = async () => {
      try {
        const mod = await import('./services/syncService.js')
        syncService = mod.syncService
        syncService.connect()

        unsub = syncService.onState((remoteState) => {
          if (syncRef.current) return
          loadFullState(remoteState)
        })

        unsubStore = useMixerStore.subscribe((state) => {
          if (!syncService.connected) return
          syncRef.current = true
          syncService.emit({
            channels:   state.channels,
            mainVolume: state.mainVolume,
            subVolume:  state.subVolume,
            fx:         state.fx,
          })
          requestAnimationFrame(() => { syncRef.current = false })
        })
      } catch (_) {
        // Servidor de sync no disponible — modo standalone, no es fatal
      }
    }

    connectSync()
    return () => { unsub(); unsubStore() }
  }, [engineReady, loadFullState])

  // ── Header info ───────────────────────────────────────────────────────────
  const deviceLabel = primaryInterface
    ? primaryInterface.info.name
    : status === 'detectando' ? 'Detectando...' : 'Sin interfaz'

  const dotColor =
    status === 'conectado'  ? '#22c55e' :
    status === 'detectando' ? '#eab308' :
    '#ef4444'

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 bg-[#141414] border-b border-[#2a2a2a]">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-[#22c55e] animate-pulse" />
          <span className="text-[#f97316] font-bold tracking-widest text-sm">ONA LIVE STUDIO</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-[#737373]">{deviceLabel}</span>
          <span style={{ color: dotColor }}>
            ● {status === 'conectado' ? 'CONECTADO' : status === 'detectando' ? 'BUSCANDO' : 'SIN INTERFAZ'}
          </span>
          {!engineReady && !initError && (
            <span className="text-[9px] text-[#737373] italic">Clic para activar audio</span>
          )}
          {initError && (
            <span className="text-[9px] text-[#ef4444]" title={initError}>⚠ Error de audio</span>
          )}
        </div>
      </header>

      {/* Layout principal */}
      <div className="flex flex-1 overflow-hidden">
        {/* Canales */}
        <div className="flex flex-1 overflow-x-auto overflow-y-hidden border-r border-[#2a2a2a]">
          {channels.map(ch => (
            <Channel key={ch.id} channelId={ch.id} inputList={inputList} />
          ))}
        </div>

        {/* Panel derecho */}
        <div className="flex flex-col w-64 overflow-y-auto">
          <SceneManager />
          <VirtualSoundcheck />
          <FXRack />
          <Recorder />
          <MasterBus />
        </div>
      </div>
    </div>
  )
}
