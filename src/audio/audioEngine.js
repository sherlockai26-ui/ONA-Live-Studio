/**
 * audioEngine.js — Facade de compatibilidad.
 *
 * Re-exporta audioBridge como 'audioEngine' para que todos los componentes
 * existentes sigan funcionando sin cambios.
 *
 * La lógica DSP real vive en:
 *   src/audio/core/AudioEngineSingleton.ts  (motor, Tone.js, lifecycle)
 *   src/audio/AudioBridge.ts               (capa de comandos, debounce)
 */
export { audioBridge as audioEngine } from './AudioBridge.ts'
