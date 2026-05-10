/**
 * ToneJsAudit.ts — Reporte de dependencias de Tone.js y plan de reducción
 *
 * Objetivo: documentar qué usa Tone.js, qué puede reemplazarse con WebAudio puro,
 * en qué orden, y cuál es el beneficio esperado.
 *
 * Este archivo se importa por AudioEngineSingleton en init para loguear el estado
 * actual. No afecta rutas de producción.
 *
 * Expuesto en consola como: window.__ONA_TONE_AUDIT
 */

export interface AuditEntry {
  toneApi:      string
  usage:        string
  webAudioEquiv: string
  migrationEffort: 'low' | 'medium' | 'high'
  notes?:       string
}

export interface ToneJsAuditReport {
  canMigrateNow:  AuditEntry[]
  requiresWork:   AuditEntry[]
  keepForNow:     AuditEntry[]
  estimatedBundleSaving: string
  migrationOrder: string[]
  notes:          string
}

export const TONE_AUDIT: ToneJsAuditReport = {
  canMigrateNow: [
    {
      toneApi:          'Tone.Gain',
      usage:            'inputGain, makeupGain, toMain, toSub, gateNode, returnGain, buses',
      webAudioEquiv:    'AudioContext.createGain()',
      migrationEffort:  'low',
    },
    {
      toneApi:          'Tone.Volume',
      usage:            'fader, bus fader, returnFader',
      webAudioEquiv:    'GainNode + dB→linear conversion helper',
      migrationEffort:  'low',
      notes:            'rampTo() → AudioParam.exponentialRampToValueAtTime()',
    },
    {
      toneApi:          'Tone.Filter (BiquadFilter)',
      usage:            'HPF por canal, EQ bands (7×)',
      webAudioEquiv:    'AudioContext.createBiquadFilter()',
      migrationEffort:  'low',
      notes:            'API casi idéntica, directa',
    },
    {
      toneApi:          'Tone.Compressor',
      usage:            'Compresor por canal',
      webAudioEquiv:    'AudioContext.createDynamicsCompressor()',
      migrationEffort:  'low',
      notes:            'API idéntica, sólo wrap',
    },
    {
      toneApi:          'Tone.Panner',
      usage:            'Pan estéreo por canal',
      webAudioEquiv:    'AudioContext.createStereoPanner()',
      migrationEffort:  'low',
    },
    {
      toneApi:          'Tone.Meter',
      usage:            'inputMeter, outputMeter por canal, returnMeter',
      webAudioEquiv:    'AnalyserNode (getFloatTimeDomainData → RMS en dBFS)',
      migrationEffort:  'low',
      notes:            'Requiere helper de cálculo RMS, ~15 líneas',
    },
    {
      toneApi:          'Tone.start()',
      usage:            'Activar AudioContext tras gesto de usuario',
      webAudioEquiv:    'audioCtx.resume() + crear AudioContext en el click handler',
      migrationEffort:  'low',
    },
    {
      toneApi:          'Tone.getDestination()',
      usage:            'AudioDestinationNode para routing de buses',
      webAudioEquiv:    'audioCtx.destination',
      migrationEffort:  'low',
    },
    {
      toneApi:          'Tone.context',
      usage:            'Acceso al AudioContext subyacente',
      webAudioEquiv:    'Instancia directa de AudioContext',
      migrationEffort:  'low',
    },
  ],

  requiresWork: [
    {
      toneApi:          'Tone.Reverb',
      usage:            'FX global de reverberación',
      webAudioEquiv:    'ConvolverNode + OfflineAudioContext para generar IR',
      migrationEffort:  'high',
      notes:            'Tone.Reverb ya usa OfflineAudioContext internamente. ' +
                        'Migrar requiere reimplementar generate() del IR. ' +
                        'Prioridad baja — funciona bien actualmente.',
    },
    {
      toneApi:          'Tone.FeedbackDelay',
      usage:            'FX global de delay con feedback',
      webAudioEquiv:    'DelayNode + feedback GainNode con Wet/Dry mix',
      migrationEffort:  'medium',
      notes:            '~30 líneas, directo pero requiere testing de feedback stability',
    },
    {
      toneApi:          'Tone.Recorder',
      usage:            'Grabación de main mix y canales raw',
      webAudioEquiv:    'MediaRecorder + MediaStreamDestinationNode',
      migrationEffort:  'medium',
      notes:            'API diferente, requiere refactor de Recorder.jsx',
    },
    {
      toneApi:          'Tone.Player',
      usage:            'Virtual Soundcheck — reproducción de archivos de audio',
      webAudioEquiv:    'AudioBufferSourceNode + fetch/decodeAudioData',
      migrationEffort:  'medium',
      notes:            'Loop + sync con Transport complica la migración',
    },
  ],

  keepForNow: [
    {
      toneApi:          'Tone.Transport',
      usage:            'Sincronización de reproducción en Virtual Soundcheck',
      webAudioEquiv:    'AudioContext.currentTime + programmed scheduling',
      migrationEffort:  'high',
      notes:            'Tone.Transport gestiona sync entre múltiples Players. ' +
                        'Migrar requiere un scheduler propio. Prioridad muy baja.',
    },
    {
      toneApi:          'Tone.loaded()',
      usage:            'Await de carga de buffers de audio (VS)',
      webAudioEquiv:    'Promise personalizada que trackea fetch + decodeAudioData',
      migrationEffort:  'medium',
      notes:            'Necesario junto con migración de Tone.Player',
    },
  ],

  estimatedBundleSaving: '~180kB gzip (Tone.js completo → ~12kB con helpers propios)',

  migrationOrder: [
    '1. ChannelStrip: Gain, Volume, Filter, Compressor, Panner, Meter → WebAudio puro',
    '2. BusEngine: Gain, Volume, Meter → WebAudio puro',
    '3. Global FX: FeedbackDelay → WebAudio puro',
    '4. Recorder: Tone.Recorder → MediaRecorder',
    '5. Virtual Soundcheck: Tone.Player + Transport → AudioBufferSourceNode + scheduler propio',
    '6. Reverb: Tone.Reverb → ConvolverNode + IR generator (último paso)',
  ],

  notes: 'Tone.js contribuye ~450kB al bundle (126kB gzip). ' +
         'La migración puede hacerse por fases sin riesgo. ' +
         'Fase 1 (ChannelStrip + buses) reduce ~70% del bundle sin cambiar ningún comportamiento visible.',
}

// Loguear al importar en debug
if (process.env.NODE_ENV !== 'production') {
  const migratable = TONE_AUDIT.canMigrateNow.length
  const total = migratable + TONE_AUDIT.requiresWork.length + TONE_AUDIT.keepForNow.length
  console.log(`[TONE AUDIT] ${migratable}/${total} APIs migrables ahora. ` +
    `Ahorro estimado: ${TONE_AUDIT.estimatedBundleSaving}`)
}

// Exponer en consola
;(window as any).__ONA_TONE_AUDIT = {
  report:         () => TONE_AUDIT,
  migrationOrder: () => TONE_AUDIT.migrationOrder.forEach(s => console.log(s)),
  summary: () => {
    console.group('[TONE AUDIT] Resumen Tone.js → WebAudio')
    console.log(`Migrables ahora:  ${TONE_AUDIT.canMigrateNow.map(e => e.toneApi).join(', ')}`)
    console.log(`Requieren trabajo: ${TONE_AUDIT.requiresWork.map(e => e.toneApi).join(', ')}`)
    console.log(`Mantener por ahora: ${TONE_AUDIT.keepForNow.map(e => e.toneApi).join(', ')}`)
    console.log(`Ahorro bundle: ${TONE_AUDIT.estimatedBundleSaving}`)
    console.groupEnd()
  },
}
