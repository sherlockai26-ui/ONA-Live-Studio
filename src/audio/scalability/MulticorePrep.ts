/**
 * MulticorePrep.ts — Architecture preparation for multicore DSP.
 *
 * What this module DOES (today):
 *   - Assigns channels to logical core groups (8-16 per group)
 *   - Benchmarks SharedArrayBuffer IPC cost (µs per operation)
 *   - Checks WASM threads / SharedArrayBuffer availability
 *   - Generates the thread contract interface for future Rust DSP
 *   - Reports system concurrency capacity
 *
 * What this module does NOT do:
 *   - Spawn Workers
 *   - Implement Rust threading
 *   - Change current DSP execution model
 *
 * When Rust threads are ready, each CoreGroup maps to one Rust thread.
 * Commands flow via commandSAB (ring buffer), meters via meterSAB (float array).
 */

export interface CoreGroup {
  id:             number
  channels:       number[]
  preferredCore:  number | null
}

export interface ThreadedDSPContract {
  groupId:     number
  channels:    number[]
  commandSAB:  SharedArrayBuffer | null   // ring buffer: main → worker commands
  meterSAB:    SharedArrayBuffer | null   // float array: worker → main peak data
}

export interface MulticoreProfile {
  logicalCores:          number
  recommendedWorkers:    number
  channelGroups:         CoreGroup[]
  ipcCostMicros:         number
  sabAvailable:          boolean
  rustReadiness:         'ready' | 'no_shared_memory' | 'no_atomics'
  notes:                 string[]
}

class MulticorePrep {
  private _groups:           CoreGroup[] = []
  private _channelsPerGroup  = 16

  assignGroups(channelIds: number[], channelsPerGroup = 16): void {
    this._channelsPerGroup = channelsPerGroup
    this._groups           = []
    let groupId            = 0
    const cores            = navigator.hardwareConcurrency ?? 4

    for (let i = 0; i < channelIds.length; i += channelsPerGroup) {
      this._groups.push({
        id:            groupId,
        channels:      channelIds.slice(i, i + channelsPerGroup),
        preferredCore: groupId < cores - 1 ? groupId + 1 : null,
      })
      groupId++
    }
  }

  /** Benchmark atomic SAB writes — returns µs per operation */
  private _benchmarkIPC(): number {
    if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') return -1

    try {
      const sab  = new SharedArrayBuffer(64)
      const iArr = new Int32Array(sab)
      const fArr = new Float32Array(sab)
      const ITER = 5000
      const t0   = performance.now()

      for (let i = 0; i < ITER; i++) {
        Atomics.store(iArr, 0, i & 0x7fffffff)
        fArr[1] = 0.5
      }

      return +((performance.now() - t0) / ITER * 1000).toFixed(3)
    } catch (_) {
      return -1
    }
  }

  private _checkReadiness(): 'ready' | 'no_shared_memory' | 'no_atomics' {
    if (typeof SharedArrayBuffer === 'undefined') return 'no_shared_memory'
    if (typeof Atomics === 'undefined')           return 'no_atomics'
    return 'ready'
  }

  generateProfile(channelIds: number[]): MulticoreProfile {
    if (this._groups.length === 0) this.assignGroups(channelIds)

    const cores      = navigator.hardwareConcurrency ?? 4
    const ipcCost    = this._benchmarkIPC()
    const readiness  = this._checkReadiness()
    const sabOk      = readiness === 'ready'
    const notes: string[] = []

    if (cores < 4)
      notes.push(`WARNING: only ${cores} logical cores — limit workers to 1`)
    if (cores >= 8)
      notes.push(`GOOD: ${cores} cores — can run ${Math.min(cores - 2, this._groups.length)} DSP workers`)
    if (ipcCost > 5)
      notes.push(`WARNING: SAB IPC cost ${ipcCost}µs/op — batch commands to reduce overhead`)
    if (ipcCost > 0 && ipcCost <= 5)
      notes.push(`SAB IPC cost: ${ipcCost}µs/op — acceptable for 16ms frame budget`)
    if (readiness === 'ready')
      notes.push('SharedArrayBuffer + Atomics available — Rust thread workers are feasible')
    if (readiness === 'no_shared_memory')
      notes.push('SharedArrayBuffer unavailable — add COOP/COEP headers to Electron main for Rust threads')

    const recommendedWorkers = Math.max(
      1,
      Math.min(cores - 2, Math.ceil(channelIds.length / this._channelsPerGroup))
    )

    return {
      logicalCores:       cores,
      recommendedWorkers,
      channelGroups:      this._groups,
      ipcCostMicros:      ipcCost,
      sabAvailable:       sabOk,
      rustReadiness:      readiness,
      notes,
    }
  }

  /** Build thread contracts for future use — SAB pre-allocated but not yet connected */
  buildContracts(): ThreadedDSPContract[] {
    const readiness = this._checkReadiness()
    return this._groups.map(g => ({
      groupId:    g.id,
      channels:   g.channels,
      commandSAB: readiness === 'ready' ? new SharedArrayBuffer(g.channels.length * 64) : null,
      meterSAB:   readiness === 'ready' ? new SharedArrayBuffer(g.channels.length * 4)  : null,
    }))
  }

  getGroups(): CoreGroup[] { return this._groups }
  clear():     void        { this._groups = [] }
}

export const multicorePrep = new MulticorePrep()
