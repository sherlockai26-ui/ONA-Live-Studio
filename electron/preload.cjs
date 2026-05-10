const { contextBridge, ipcRenderer } = require('electron')

// Safe Mode: detectado en main.cjs y pasado como additionalArgument
const SAFE_MODE = process.argv.includes('--safe-mode')

contextBridge.exposeInMainWorld('electronAPI', {
  // Grabación
  saveRecording:    (buf, file) => ipcRenderer.invoke('save-recording', buf, file),
  getRecordingsDir: ()          => ipcRenderer.invoke('get-recordings-dir'),

  // Escenas
  saveScene:   (name, json) => ipcRenderer.invoke('scenes-save', name, json),
  listScenes:  ()           => ipcRenderer.invoke('scenes-list'),
  loadScene:   (name)       => ipcRenderer.invoke('scenes-load', name),
  deleteScene: (name)       => ipcRenderer.invoke('scenes-delete', name),

  // Virtual Soundcheck
  showOpenDialog: (opts) => ipcRenderer.invoke('show-open-dialog', opts),

  // Crash logging persistente — el renderer envía al main para escribir en disco
  crashLog: (msg) => {
    try { ipcRenderer.send('crash-log', String(msg)) } catch (_) {}
  },

  // Native audio probe (Paso 3) — detecta ASIO/WASAPI/CoreAudio vía naudiodon en main
  // Retorna: { available: boolean, devices: NativeAudioDevice[] }
  probeNativeAudio: () => ipcRenderer.invoke('native-audio-probe'),
})

contextBridge.exposeInMainWorld('ona', {
  version:  '0.2.0',
  platform: process.platform,
  safeMode: SAFE_MODE,  // true si se inició con: electron . --safe-mode
})

// ─── Paso 10: Multitrack Streaming Recording API ──────────────────────────────
//
// window.onaRecording — punto de acceso desde el renderer al sistema de
// grabación multipista. Implementa el protocolo de 3 fases:
//   createSession   → recording:create-session  (abre fds en main process)
//   writeChunk      → recording:write-chunk     (append PCM 24-bit por canal)
//   finalizeSession → recording:finalize-session (parcha header WAV, cierra fds)
//
// loadFile devuelve el WAV como ArrayBuffer para decodificarlo en el renderer
// (MultitrackPlayer.loadSessionTrack → AudioContext.decodeAudioData).

contextBridge.exposeInMainWorld('onaRecording', {
  createSession:   (channels, sampleRate) =>
    ipcRenderer.invoke('recording:create-session', channels, sampleRate),
  writeChunk:      (sessionId, channelId, arrayBuffer) =>
    ipcRenderer.invoke('recording:write-chunk', sessionId, channelId, arrayBuffer),
  finalizeSession: (sessionId, latencyInfo) =>
    ipcRenderer.invoke('recording:finalize-session', sessionId, latencyInfo),
  listSessions:    () =>
    ipcRenderer.invoke('recording:list-sessions'),
  loadFile:        (filePath) =>
    ipcRenderer.invoke('recording:load-file', filePath),
})

// ─── Paso 6: Native DSP Engine (Rust) ────────────────────────────────────────
//
// El módulo .node se carga aquí porque preload tiene acceso a Node.js
// (contextIsolation: true, nodeIntegration: false en renderer).
//
// Estrategia de handles:
//   - Las instancias NativeChannelProcessor viven en este closure del preload
//   - El renderer las identifica por handle string (channelId como key)
//   - Evita serializar objetos nativos a través del contextBridge
//   - Float32Array pasa por structured clone (mismo proceso, bajo costo)
//   - SharedArrayBuffer pasa por referencia (zero-copy real)

;(function loadNativeDSP() {
  if (SAFE_MODE) return  // No cargar módulo nativo en safe mode

  // __dirname no está disponible en preloads sandboxed (Electron v20+ sandbox por defecto).
  // Envolvemos todo en try-catch para que un fallo no interrumpa el script.
  let nativeMod
  try {
    const platform = process.platform   // 'win32' | 'darwin' | 'linux'
    const arch     = process.arch       // 'x64' | 'arm64'
    const abi      = process.platform === 'win32' ? 'msvc' : 'gnu'
    const nodeName = `ona-dsp-engine.${platform}-${arch}-${abi}.node`
    // __dirname puede no existir en sandbox — si lanza ReferenceError lo atrapa el catch externo.
    const nodePath = `${__dirname}/../native/${nodeName}`
    nativeMod = require(nodePath)
  } catch (_) {
    // Módulo no compilado o __dirname no disponible — NativeDSPBridge usa WebAudio fallback
    return
  }

  // Mapa de procesadores activos: channelId → instancia Rust
  const processors = new Map()

  contextBridge.exposeInMainWorld('onaNative', {
    engineVersion:   () => nativeMod.engineVersion(),
    getCapabilities: () => nativeMod.getCapabilities(),

    // Factory: crea instancia en el preload, retorna handle string
    createProcessor: (channelId, sampleRate, blockSize) => {
      const handle = String(channelId)
      if (!processors.has(handle)) {
        processors.set(handle, new nativeMod.NativeChannelProcessor(channelId, sampleRate, blockSize))
      }
      return handle
    },

    destroyProcessor: (handle) => {
      processors.delete(handle)
    },

    // Setters — llamados raramente (automación, UI)
    setGainDb:     (handle, db)     => processors.get(handle)?.setGainDb(db),
    setGainLinear: (handle, gain)   => processors.get(handle)?.setGainLinear(gain),
    setPan:        (handle, pan)    => processors.get(handle)?.setPan(pan),
    setBypass:     (handle, bypass) => processors.get(handle)?.setBypass(bypass),
    resetMeters:   (handle)         => processors.get(handle)?.resetMeters(),

    // Hot path: Float32Array → structured clone (mismo proceso, ~microsegundos)
    processBlock: (handle, samples) => {
      const proc = processors.get(handle)
      return proc ? proc.processBlock(samples) : null
    },

    // Hot path zero-copy: SharedArrayBuffer view — no serialización
    processShared: (handle, buffer, offset, count) => {
      const proc = processors.get(handle)
      return proc ? proc.processShared(buffer, offset, count) : null
    },

    // Benchmark interno Rust (excluye overhead JS)
    benchmarkProcessing: (blockSize, numBlocks, sampleRate) =>
      nativeMod.benchmarkProcessing(blockSize, numBlocks, sampleRate),
  })
})();
