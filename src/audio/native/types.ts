// ─── Resultados de procesamiento ──────────────────────────────────────────────

export interface BlockResult {
  peakL:         number
  peakR:         number
  rmsL:          number
  rmsR:          number
  /** Tiempo real de procesamiento en nanosegundos (excluye overhead JS/IPC). */
  processingNs:  number
}

// ─── Capacidades del engine nativo ────────────────────────────────────────────

export interface NativeCapabilities {
  gain:            boolean
  pan:             boolean
  peakMeter:       boolean
  rmsMeter:        boolean
  blockProcessing: boolean
  sharedMemory:    boolean
  simd:            boolean
}

// ─── Módulo nativo (interfaz del .node compilado) ─────────────────────────────

export interface NativeDSPModule {
  engineVersion():    string
  getCapabilities():  NativeCapabilities
  benchmarkProcessing(
    blockSize:   number,
    numBlocks:   number,
    sampleRate:  number,
  ): BenchmarkResult

  NativeChannelProcessor: new(
    channelId:  number,
    sampleRate: number,
    blockSize:  number,
  ) => NativeProcessorInstance
}

export interface NativeProcessorInstance {
  channelId():                   number
  setGainDb(db: number):         void
  setGainLinear(gain: number):   void
  setPan(pan: number):           void
  setBypass(bypass: boolean):    void
  resetMeters():                 void
  processBlock(
    samples: Float32Array,
  ): BlockResult
  processShared(
    buffer:       Uint8Array,
    sampleOffset: number,
    sampleCount:  number,
  ): BlockResult
}

// ─── Benchmark ────────────────────────────────────────────────────────────────

export interface BenchmarkResult {
  blockSize:      number
  numBlocks:      number
  avgNs:          number
  minNs:          number
  maxNs:          number
  totalMs:        number
  /** Ratio audio_duration / wall_clock. >1 = más rápido que realtime. */
  realtimeFactor: number
}

// ─── API unificada (Rust native o WebAudio fallback) ─────────────────────────

export interface IDSPChannel {
  setGainDb(db: number):       void
  setGainLinear(gain: number): void
  setPan(pan: number):         void
  setBypass(bypass: boolean):  void
  processBlock(
    samples: Float32Array,
  ): BlockResult
  resetMeters(): void
}

// ─── Estado del bridge ────────────────────────────────────────────────────────

export type DSPBackend = 'native-rust' | 'webaudio-fallback'

export interface DSPBridgeStatus {
  backend:       DSPBackend
  available:     boolean
  version?:      string
  capabilities?: NativeCapabilities
  error?:        string
}

// ─── Threading model (Paso 6 — diseño futuro) ─────────────────────────────────

/**
 * Separación de threads objetivo (Paso 7+):
 *   DSP_THREAD       — Rust audio callback, lock-free
 *   UI_THREAD        — React / Electron renderer
 *   NETWORK_THREAD   — Socket.IO sync
 *   PERSIST_THREAD   — autosave / localStorage
 *
 * En Paso 6: validamos DSP_THREAD con bloque síncrono en preload.
 * En Paso 7: migrar a Worker Thread con SAB bidireccional.
 */
export type OnaThread = 'DSP_THREAD' | 'UI_THREAD' | 'NETWORK_THREAD' | 'PERSIST_THREAD'
