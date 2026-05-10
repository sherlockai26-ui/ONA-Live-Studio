/**
 * AudioBridge.ts — Capa de comandos entre UI y AudioEngineSingleton.
 *
 * Responsabilidades:
 *   - Punto de entrada único desde componentes React hacia el DSP
 *   - Debounce para operaciones costosas (reverb decay: 300ms, EQ: 50ms)
 *   - Misma API surface que el engine anterior → compatibilidad total
 *   - connectChannel(channelId, deviceId) → HAL (hot swap, Paso 3)
 *
 * React llama AudioBridge. AudioBridge llama engineSingleton o HAL.
 * Ningún componente llama al engine/HAL directamente.
 */

import { engineSingleton } from './core/AudioEngineSingleton'
import { hal }             from './hardware/HardwareAbstractionLayer'

type Timer = ReturnType<typeof setTimeout>

class AudioBridge {
  private _timers = new Map<string, Timer>()

  private _debounce(key: string, ms: number, fn: () => void): void {
    const prev = this._timers.get(key)
    if (prev !== undefined) clearTimeout(prev)
    this._timers.set(key, setTimeout(() => {
      this._timers.delete(key)
      fn()
    }, ms))
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  async initialize(numChannels?: number, initialState?: any): Promise<void> {
    return engineSingleton.initialize(numChannels, initialState)
  }

  get initialized(): boolean { return engineSingleton.initialized }
  get state() { return engineSingleton.state }

  suspend(): void  { engineSingleton.suspend() }
  resume(): void   { engineSingleton.resume() }
  destroy(): void  { engineSingleton.destroy() }

  // ── Canal ─────────────────────────────────────────────────────────────────────

  setChannelVolume(id: number, vol: number, muted = false): void {
    engineSingleton.setChannelVolume(id, vol, muted)
  }

  setChannelPan(id: number, pan: number): void {
    engineSingleton.setChannelPan(id, pan)
  }

  setChannelRouting(id: number, toMain: boolean, toSub: boolean): void {
    engineSingleton.setChannelRouting(id, toMain, toSub)
  }

  setChannelHpf(id: number, params: { active?: boolean; freq?: number }): void {
    engineSingleton.setChannelHpf(id, params)
  }

  setChannelLpf(id: number, params: { active?: boolean; freq?: number }): void {
    engineSingleton.setChannelLpf(id, params)
  }

  // ── AUX sends (Paso 9) ────────────────────────────────────────────────────────

  setChannelAuxSend(id: number, auxId: number, params: { level?: number; preFader?: boolean; muted?: boolean }): void {
    engineSingleton.setChannelAuxSend(id, auxId, params)
  }

  setAuxBusLevel(id: number, level: number): void  { engineSingleton.setAuxBusLevel(id, level) }
  setAuxBusMuted(id: number, muted: boolean): void  { engineSingleton.setAuxBusMuted(id, muted) }

  // ── Subgroups (Paso 9) ────────────────────────────────────────────────────────

  setChannelGroupSend(id: number, groupId: number, active: boolean): void {
    engineSingleton.setChannelGroupSend(id, groupId, active)
  }

  setSubgroupLevel(id: number, level: number): void                    { engineSingleton.setSubgroupLevel(id, level) }
  setSubgroupMuted(id: number, muted: boolean): void                   { engineSingleton.setSubgroupMuted(id, muted) }
  setSubgroupRouting(id: number, toMain: boolean, toSub: boolean): void { engineSingleton.setSubgroupRouting(id, toMain, toSub) }

  // ── Solo / Cue (Paso 9) ───────────────────────────────────────────────────────

  setChannelSolo(id: number, soloed: boolean, mode: 'pfl' | 'afl' = 'pfl'): void {
    engineSingleton.setChannelSolo(id, soloed, mode)
  }

  setCueLevel(level: number): void        { engineSingleton.setCueLevel(level) }
  setCueMode(mode: 'pfl' | 'afl'): void  { engineSingleton.setCueMode(mode) }
  clearAllSolo(): void                    { engineSingleton.clearAllSolo() }

  // ── Matrix routing (Paso 9) ───────────────────────────────────────────────────

  setMatrixConnect(source: string, dest: string, level?: number): void {
    engineSingleton.setMatrixConnect(source, dest, level)
  }
  setMatrixDisconnect(source: string, dest: string): void {
    engineSingleton.setMatrixDisconnect(source, dest)
  }
  getMatrixConnections() { return engineSingleton.getMatrixConnections() }
  validateRouting()      { return engineSingleton.validateRouting() }

  // ── Multitrack Recording (Paso 10) ───────────────────────────────────────────

  // ── Control Surface / MIDI (Paso 13) ─────────────────────────────────────────

  getMidiDevices()             { return engineSingleton.getMidiDevices() }
  getMidiMappings()            { return engineSingleton.getMidiMappings() }
  addMidiMapping(rule: any)    { engineSingleton.addMidiMapping(rule) }
  removeMidiMapping(id: string) { engineSingleton.removeMidiMapping(id) }
  loadMidiTemplate(numCh: number) { engineSingleton.loadMidiTemplate(numCh) }
  saveMidiProfile(name: string)   { engineSingleton.saveMidiProfile(name) }
  loadMidiProfile(name: string)   { return engineSingleton.loadMidiProfile(name) }
  listMidiProfiles()           { return engineSingleton.listMidiProfiles() }
  getControlMetrics()          { return engineSingleton.getControlMetrics() }
  syncControlFeedback()        { engineSingleton.syncControlFeedback() }
  getMotorFaderStates()        { return engineSingleton.getMotorFaderStates() }
  isMidiAvailable(): boolean   { return engineSingleton.isMidiAvailable() }

  // ── Scalability + Performance (Paso 15) ──────────────────────────────────────

  setPerformanceMode(mode: 'studio' | 'live' | 'eco'): void { engineSingleton.setPerformanceMode(mode) }
  getPerformanceMode(): string  { return engineSingleton.getPerformanceMode() }
  getModeConfig()               { return engineSingleton.getModeConfig() }
  enableAutoPerformance(on: boolean): void { engineSingleton.enableAutoPerformance(on) }

  getLoadBalancerMetrics()      { return engineSingleton.getLoadBalancerMetrics() }
  forceLoadBalancerStage(s: 'full'|'reduced'|'minimal'|'emergency'): void {
    engineSingleton.forceLoadBalancerStage(s)
  }

  getResourceStats()            { return engineSingleton.getResourceStats() }
  touchMeter(id: string): void  { engineSingleton.touchMeter(id) }

  getSleepStatus()              { return engineSingleton.getSleepStatus() }
  getSleepingCount(): number    { return engineSingleton.getSleepingCount() }
  wakeAllChannels(): void       { engineSingleton.wakeAllChannels() }

  getLazyDSPStats()             { return engineSingleton.getLazyDSPStats() }
  getMulticoreProfile()         { return engineSingleton.getMulticoreProfile() }
  getCacheStats()               { return engineSingleton.getCacheStats() }

  getScalabilityReport()        { return engineSingleton.getScalabilityReport() }

  // ── Mix Engine / Gain Staging (Paso 14) ──────────────────────────────────────

  setChannelTrim(id: number, db: number): void       { engineSingleton.setChannelTrim(id, db) }
  getChannelTrim(id: number): number                 { return engineSingleton.getChannelTrim(id) }
  autoTrimChannel(id: number): void                  { engineSingleton.autoTrimChannel(id) }

  setGainStagingProfile(profile: 'broadcast' | 'live' | 'recording'): void {
    engineSingleton.setGainStagingProfile(profile)
  }
  getGainStagingReport() { return engineSingleton.getGainStagingReport() }

  setMixBusProtection(params: { softSat?: boolean; limiter?: boolean; clipGuard?: boolean }): void {
    engineSingleton.setMixBusProtection(params)
  }
  getMixBusProtectionConfig()       { return engineSingleton.getMixBusProtectionConfig() }
  getPostProtectionPeakDb(): number { return engineSingleton.getPostProtectionPeakDb() }
  getLimiterReduction(): number     { return engineSingleton.getLimiterReduction() }
  getMixBusClipCount(): number      { return engineSingleton.getMixBusClipCount() }

  getLoudness(id: string)  { return engineSingleton.getLoudness(id) }
  getAllLoudness()          { return engineSingleton.getAllLoudness() }

  setPanLaw(mode: 'equal_power' | 'linear_6db' | 'linear_0db'): void { engineSingleton.setPanLaw(mode) }
  getPanLaw(): string      { return engineSingleton.getPanLaw() }
  getPanLawInfo()          { return engineSingleton.getPanLawInfo() }
  getPanGains(userPan: number) { return engineSingleton.getPanGains(userPan) }

  getMixEngineReport()     { return engineSingleton.getMixEngineReport() }
  runMixBenchmark()        { return engineSingleton.runMixBenchmark() }

  // ── FX Buses (Paso 12) ───────────────────────────────────────────────────────

  setChannelFxBusSend(channelId: number, busId: number, params: { level?: number; preFader?: boolean; muted?: boolean }): void {
    engineSingleton.setChannelFxBusSend(channelId, busId, params)
  }

  setFxBusActive(busId: number, active: boolean): void   { engineSingleton.setFxBusActive(busId, active) }
  setFxBusWetLevel(busId: number, level: number): void   { engineSingleton.setFxBusWetLevel(busId, level) }
  attachFxProcessor(busId: number, type: 'delay' | 'reverb'): void { engineSingleton.attachFxProcessor(busId, type) }
  detachFxProcessor(busId: number): void                 { engineSingleton.detachFxProcessor(busId) }
  setFxProcessorParams(busId: number, params: Record<string, number>): void {
    engineSingleton.setFxProcessorParams(busId, params)
  }
  getFxBusMeter(busId: number): number   { return engineSingleton.getFxBusMeter(busId) }
  getFxBusState(busId: number)           { return engineSingleton.getFxBusState(busId) }
  getAllFxBusStates()                    { return engineSingleton.getAllFxBusStates() }

  // ── Production Stability (Paso 11) ───────────────────────────────────────────

  setCpuMode(mode: 'normal' | 'low_cpu' | 'safe'): void { engineSingleton.setCpuMode(mode) }
  getCpuMode(): string { return engineSingleton.getCpuMode() }
  getProductionReport() { return engineSingleton.getProductionReport() }
  getRecoveryHistory()  { return engineSingleton.getRecoveryHistory() }
  getNodeReport()       { return engineSingleton.getNodeReport() }
  runStressTest(hours: 4 | 8 | 12 = 4) { return engineSingleton.runStressTest(hours) }

  startMultitrackRec(channelIds?: number[]): Promise<string> {
    return engineSingleton.startMultitrackRec(channelIds)
  }

  stopMultitrackRec() { return engineSingleton.stopMultitrackRec() }
  getMultitrackStats() { return engineSingleton.getMultitrackStats() }
  listRecordingSessions() { return engineSingleton.listRecordingSessions() }

  // ── Multitrack Playback (Paso 10) ─────────────────────────────────────────────

  loadPlaybackTrack(channelId: number, filePath: string): Promise<boolean> {
    return engineSingleton.loadPlaybackTrack(channelId, filePath)
  }

  startPlayback(offsetSeconds?: number): void { engineSingleton.startPlayback(offsetSeconds) }
  stopPlayback():                         void { engineSingleton.stopPlayback() }
  pausePlayback():                        void { engineSingleton.pausePlayback() }
  seekPlayback(seconds: number):          void { engineSingleton.seekPlayback(seconds) }
  getPlaybackState() { return engineSingleton.getPlaybackState() }
  getMeasuredLatency() { return engineSingleton.getMeasuredLatency() }

  setChannelGate(id: number, params: any): void {
    engineSingleton.setChannelGate(id, params)
  }

  setChannelCompressor(id: number, params: any): void {
    engineSingleton.setChannelCompressor(id, params)
  }

  setChannelReverbSend(id: number, v: number): void {
    engineSingleton.setChannelReverbSend(id, v)
  }

  setChannelDelaySend(id: number, v: number): void {
    engineSingleton.setChannelDelaySend(id, v)
  }

  /** EQ: debounce 50ms — evita llamadas redundantes durante arrastre de slider */
  setChannelEqBand(id: number, bandIndex: number, params: { gain?: number; freq?: number; q?: number }): void {
    this._debounce(`eq_${id}_${bandIndex}`, 50, () =>
      engineSingleton.setChannelEqBand(id, bandIndex, params)
    )
  }

  // ── Master ────────────────────────────────────────────────────────────────────

  setMainVolume(v: number): void { engineSingleton.setMainVolume(v) }
  setSubVolume(v: number): void  { engineSingleton.setSubVolume(v) }

  /**
   * setGlobalReverb — decay con debounce crítico (300ms).
   * Evita múltiples OfflineAudioContext simultáneos al arrastrar el slider de decay.
   * active y preDelay se aplican inmediatamente.
   */
  setGlobalReverb(params: { active?: boolean; decay?: number; preDelay?: number }): void {
    const { decay, ...rest } = params
    if (Object.keys(rest).length > 0) engineSingleton.setGlobalReverb(rest)
    if (decay !== undefined) {
      this._debounce('reverb_decay', 300, () =>
        engineSingleton.setGlobalReverb({ decay })
      )
    }
  }

  setGlobalDelay(params: { active?: boolean; time?: number; feedback?: number }): void {
    engineSingleton.setGlobalDelay(params)
  }

  setFxReturn(params: { volume?: number; muted?: boolean }): void {
    engineSingleton.setFxReturn(params)
  }

  // ── Meter ─────────────────────────────────────────────────────────────────────

  onMeterUpdate(cb: (data: Record<string, number>) => void): () => void {
    return engineSingleton.onMeterUpdate(cb)
  }

  getMeterBuffer(): Float32Array { return engineSingleton.getMeterBuffer() }
  getCompReduction(id: number): number { return engineSingleton.getCompReduction(id) }
  getGateLevel(id: number): number     { return engineSingleton.getGateLevel(id) }

  // ── Grabación ─────────────────────────────────────────────────────────────────

  startRecording(mode?: string): void    { engineSingleton.startRecording(mode) }
  stopRecording(): Promise<Record<string, Blob>> { return engineSingleton.stopRecording() }

  // ── Virtual Soundcheck ────────────────────────────────────────────────────────

  loadVSTrack(channelId: number, fileUrl: string): Promise<boolean> {
    return engineSingleton.loadVSTrack(channelId, fileUrl)
  }

  startVS(): void   { engineSingleton.startVS() }
  stopVS(): void    { engineSingleton.stopVS() }
  pauseVS(): void   { engineSingleton.pauseVS() }
  getVSPlayerIds(): number[] { return engineSingleton.getVSPlayerIds() }

  // ── MediaStream ───────────────────────────────────────────────────────────────

  /** Legacy: conectar un MediaStream ya obtenido directamente al canal */
  connectMediaStream(channelId: number, mediaStream: MediaStream): void {
    engineSingleton.connectMediaStream(channelId, mediaStream)
  }

  /**
   * connectChannel — API preferida (Paso 3).
   * HAL obtiene el MediaStream con constraints profesionales y lo conecta al canal.
   * Registra la conexión para hot swap automático en devicechange.
   */
  async connectChannel(channelId: number, deviceId: string): Promise<boolean> {
    const stream = await hal.connectChannel(channelId, deviceId)
    return stream !== null
  }

  disconnectChannel(channelId: number): void {
    hal.disconnectChannel(channelId)
  }

  // ── Hardware info ─────────────────────────────────────────────────────────────

  getHalLatency() { return hal.getLatency() }
  getHalSampleRate(): number { return hal.getSampleRate() }
  isChannelConnected(channelId: number): boolean { return hal.isChannelConnected(channelId) }
}

export const audioBridge = new AudioBridge()
export default audioBridge
