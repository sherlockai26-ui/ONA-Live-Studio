/**
 * mixerStore.js — Estado global de ONA Live Studio (Zustand v5)
 *
 * Flujo de estado:
 *   UI Component → store action → audioEngine.method() → Tone.js nodes
 *
 * Cadena DSP completa por canal (post-Etapa 7):
 *   Input → HPF → Gate → Compressor → EQ(7) → FX Sends → Pan → Fader → Routing
 */

import { create } from 'zustand'

// ─── Definición de bandas EQ semiparamétrico ─────────────────────────────────
export const EQ_BAND_DEFS = [
  { id: 'low',      label: 'Low',      type: 'lowshelf',  freqDefault: 80,    freqMin: 20,   freqMax: 400,   qDefault: 0.7, hasQ: false },
  { id: 'lowMid',   label: 'Low Mid',  type: 'peaking',   freqDefault: 250,   freqMin: 80,   freqMax: 2000,  qDefault: 1.0, hasQ: true  },
  { id: 'mid',      label: 'Mid',      type: 'peaking',   freqDefault: 1000,  freqMin: 200,  freqMax: 8000,  qDefault: 1.0, hasQ: true  },
  { id: 'highMid',  label: 'High Mid', type: 'peaking',   freqDefault: 3000,  freqMin: 500,  freqMax: 12000, qDefault: 1.0, hasQ: true  },
  { id: 'presence', label: 'Presence', type: 'peaking',   freqDefault: 5000,  freqMin: 1000, freqMax: 16000, qDefault: 1.2, hasQ: true  },
  { id: 'high',     label: 'High',     type: 'peaking',   freqDefault: 10000, freqMin: 2000, freqMax: 20000, qDefault: 1.0, hasQ: true  },
  { id: 'air',      label: 'Air',      type: 'highshelf', freqDefault: 16000, freqMin: 8000, freqMax: 20000, qDefault: 0.7, hasQ: false },
]

const makeEqBands = () =>
  EQ_BAND_DEFS.map(b => ({ id: b.id, gain: 0, freq: b.freqDefault, q: b.qDefault }))

// ─── Canal default ───────────────────────────────────────────────────────────
const makeChannel = (index) => ({
  id:    index + 1,
  name:  `Canal ${index + 1}`,
  color: '#f97316',
  // Routing
  inputSource: null,
  toMain: true,
  toSub:  false,
  // Fader / Pan
  volume: 75,
  pan:    0,       // -1 (L) ... 0 (C) ... 1 (R)
  muted:  false,
  soloed: false,
  // HPF
  hpf: { active: false, freq: 80 },
  // Gate
  gate: { bypass: true, threshold: -50, attack: 0.002, release: 0.15, range: -80 },
  // Compressor
  compressor: { bypass: false, threshold: -24, ratio: 4, attack: 0.003, release: 0.25, knee: 6, makeupGain: 0 },
  // EQ semiparamétrico 7 bandas
  eqBands: makeEqBands(),
  // FX Sends (0-100 → porcentaje de señal enviada al FX global)
  reverbSend: 0,
  delaySend:  0,
})

// ─── Store ───────────────────────────────────────────────────────────────────
const useMixerStore = create((set, get) => ({
  channels:   Array.from({ length: 6 }, (_, i) => makeChannel(i)),
  mainVolume: 80,
  subVolume:  80,

  // FX Send/Return global (Etapa 6)
  fx: {
    reverb:   { active: false, decay: 2.5, preDelay: 0 },
    delay:    { active: false, time: 300, feedback: 30 },
    fxReturn: { volume: 80, muted: false },
  },

  // Grabador
  recorder: { recording: false, mode: 'crudo', elapsed: 0 },

  // ─── Acciones canales ─────────────────────────────────────────────────────
  updateChannel: (id, updates) =>
    set(s => ({ channels: s.channels.map(c => c.id === id ? { ...c, ...updates } : c) })),

  updateChannelEqBand: (channelId, bandId, updates) =>
    set(s => ({
      channels: s.channels.map(c =>
        c.id === channelId
          ? { ...c, eqBands: c.eqBands.map(b => b.id === bandId ? { ...b, ...updates } : b) }
          : c
      ),
    })),

  updateChannelComp: (id, updates) =>
    set(s => ({
      channels: s.channels.map(c =>
        c.id === id ? { ...c, compressor: { ...c.compressor, ...updates } } : c
      ),
    })),

  updateChannelGate: (id, updates) =>
    set(s => ({
      channels: s.channels.map(c =>
        c.id === id ? { ...c, gate: { ...c.gate, ...updates } } : c
      ),
    })),

  updateChannelHpf: (id, updates) =>
    set(s => ({
      channels: s.channels.map(c =>
        c.id === id ? { ...c, hpf: { ...c.hpf, ...updates } } : c
      ),
    })),

  // ─── Acciones master ──────────────────────────────────────────────────────
  setMainVolume: (v) => set({ mainVolume: v }),
  setSubVolume:  (v) => set({ subVolume: v }),

  updateFx: (section, updates) =>
    set(s => ({ fx: { ...s.fx, [section]: { ...s.fx[section], ...updates } } })),

  // ─── Grabador ─────────────────────────────────────────────────────────────
  setRecorder: (updates) =>
    set(s => ({ recorder: { ...s.recorder, ...updates } })),

  // ─── Carga completa de estado (escenas / sync) ────────────────────────────
  loadFullState: (snapshot) => set({
    channels:   snapshot.channels   ?? get().channels,
    mainVolume: snapshot.mainVolume ?? get().mainVolume,
    subVolume:  snapshot.subVolume  ?? get().subVolume,
    fx:         snapshot.fx         ?? get().fx,
  }),

  // Helper
  getChannel: (id) => get().channels.find(c => c.id === id),
}))

export default useMixerStore
