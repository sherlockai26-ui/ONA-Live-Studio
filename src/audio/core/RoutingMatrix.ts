/**
 * RoutingMatrix.ts — Matrix de routing flexible: any bus → any logical output.
 *
 * Fuentes: main, sub, cue, aux1-8, group1-4
 * Destinos: out1-8 (cada uno tiene un GainNode sumador → AudioContext.destination)
 *
 * En el contexto web, todos los destinos fluyen al mismo AudioContext.destination.
 * Cada celda de la matrix tiene un GainNode independiente con level controllable.
 *
 * Nota: el bus main/sub ya conecta directamente a Tone.destination vía BusEngine.
 * La matrix es SUPLEMENTARIA — usar para AUX monitoring, cue, recording splits.
 *
 * Uso típico:
 *   aux1  → out3  (monitor stage IEM)
 *   aux2  → out4  (monitor wedge)
 *   cue   → out5  (headphone mix)
 *   group1 → out6 (recording drums)
 */

export type MatrixSource =
  | 'main' | 'sub' | 'cue'
  | 'aux1' | 'aux2' | 'aux3' | 'aux4' | 'aux5' | 'aux6' | 'aux7' | 'aux8'
  | 'group1' | 'group2' | 'group3' | 'group4'

export type MatrixDest = 'out1' | 'out2' | 'out3' | 'out4' | 'out5' | 'out6' | 'out7' | 'out8'

export const ALL_MATRIX_DESTS: MatrixDest[] = ['out1','out2','out3','out4','out5','out6','out7','out8']

export interface MatrixConnection {
  source: MatrixSource
  dest:   MatrixDest
  level:  number   // 0-100
  active: boolean
}

interface MatrixCell {
  gain:   GainNode
  level:  number
  active: boolean
}

class RoutingMatrixImpl {
  private _cells    = new Map<string, MatrixCell>()
  private _outSums  = new Map<MatrixDest, GainNode>()
  private _sources  = new Map<MatrixSource, AudioNode>()
  private _ctx:     AudioContext | null = null

  private static _key(s: MatrixSource, d: MatrixDest): string { return `${s}→${d}` }

  initialize(ctx: AudioContext, destination: AudioNode): void {
    this._ctx = ctx
    for (const d of ALL_MATRIX_DESTS) {
      const sum = ctx.createGain()
      sum.gain.value = 1
      sum.connect(destination)
      this._outSums.set(d, sum)
    }
    console.log('[MATRIX] 8 outputs listos')
  }

  /** Register a source audio node — called by AudioEngineSingleton after buses init */
  registerSource(id: MatrixSource, node: AudioNode): void {
    this._sources.set(id, node)
  }

  connect(source: MatrixSource, dest: MatrixDest, level = 100): void {
    if (!this._ctx) return
    const key     = RoutingMatrixImpl._key(source, dest)
    const outSum  = this._outSums.get(dest)
    const srcNode = this._sources.get(source)
    if (!outSum || !srcNode) {
      console.warn(`[MATRIX] connect: source "${source}" o dest "${dest}" no registrado`)
      return
    }
    let cell = this._cells.get(key)
    if (!cell) {
      const gain = this._ctx.createGain()
      gain.gain.value = level / 100
      srcNode.connect(gain)
      gain.connect(outSum)
      cell = { gain, level, active: true }
      this._cells.set(key, cell)
    } else {
      cell.active = true
      cell.level  = level
      cell.gain.gain.setTargetAtTime(level / 100, this._ctx.currentTime, 0.007)
    }
  }

  disconnect(source: MatrixSource, dest: MatrixDest): void {
    const cell = this._cells.get(RoutingMatrixImpl._key(source, dest))
    if (!cell || !this._ctx) return
    cell.gain.gain.setTargetAtTime(0, this._ctx.currentTime, 0.007)
    cell.active = false
    cell.level  = 0
  }

  setLevel(source: MatrixSource, dest: MatrixDest, level: number): void {
    const cell = this._cells.get(RoutingMatrixImpl._key(source, dest))
    if (!cell || !this._ctx || !cell.active) return
    cell.level = level
    cell.gain.gain.setTargetAtTime(level / 100, this._ctx.currentTime, 0.007)
  }

  getConnections(): MatrixConnection[] {
    const result: MatrixConnection[] = []
    for (const [key, cell] of this._cells) {
      const [source, dest] = key.split('→') as [MatrixSource, MatrixDest]
      result.push({ source, dest, level: cell.level, active: cell.active })
    }
    return result
  }

  destroy(): void {
    for (const cell of this._cells.values()) {
      try { cell.gain.disconnect() } catch (_) {}
    }
    for (const sum of this._outSums.values()) {
      try { sum.disconnect() } catch (_) {}
    }
    this._cells.clear()
    this._outSums.clear()
    this._sources.clear()
    this._ctx = null
  }
}

export const routingMatrix = new RoutingMatrixImpl()
