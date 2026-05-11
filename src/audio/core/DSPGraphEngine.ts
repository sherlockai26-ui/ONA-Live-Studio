/**
 * DSPGraphEngine.ts — Router central de conexiones entre nodos DSP.
 *
 * Responsabilidades:
 *   - Registrar nodos DSP por ID de string
 *   - connect(fromId, toId) — maneja native AudioNode → Tone wrapper (extrae .input)
 *   - Mantener un mapa de aristas para auditar el grafo en runtime
 *   - clear() al teardown — no dispone nodos (eso lo hace quien los creó)
 *
 * Paso 5 — Phase 2 fix:
 *   connect() usa _c() helper para manejar native AudioNode → Tone wrapper:
 *   si src instanceof AudioNode y dst no es AudioNode, extrae (dst as any).input.
 */

class DSPGraphEngine {
  private _nodes = new Map<string, any>()
  private _edges = new Map<string, Set<string>>()

  // Handles native AudioNode → Tone wrapper connections (extracts .input)
  private static _unwrap(node: any): any {
    // Tone wrapper → usar input si existe
    const n = node?.input ?? node

    // Si sigue siendo wrapper Tone, extraer nodo nativo real
    return n?._nativeAudioNode ?? n
  }

  private static _c(src: any, dst: any): void {
    const from = DSPGraphEngine._unwrap(src)
    const to   = DSPGraphEngine._unwrap(dst)

    from.connect(to)
  }

  register(id: string, node: any): void {
    this._nodes.set(id, node)
  }

  unregister(id: string): void {
    this.disconnectAll(id)
    this._nodes.delete(id)
  }

  connect(fromId: string, toId: string): boolean {
    const from = this._nodes.get(fromId)
    const to   = this._nodes.get(toId)
    if (!from || !to) {
      console.warn(`[GRAPH] connect: nodo no encontrado — ${!from ? fromId : toId}`)
      return false
    }
    try {
      DSPGraphEngine._c(from, to)
      if (!this._edges.has(fromId)) this._edges.set(fromId, new Set())
      this._edges.get(fromId)!.add(toId)
      return true
    } catch (err) {
      console.warn(`[GRAPH] connect ${fromId}→${toId} falló:`)

      console.log('FROM =', from)
      console.log('TO =', to)

      console.log('FROM.INPUT =', (from as any)?.input)
      console.log('TO.INPUT =', (to as any)?.input)

      console.error(err)
      return false
    }
  }

  disconnect(fromId: string, toId: string): boolean {
    const from = this._nodes.get(fromId)
    const to   = this._nodes.get(toId)
    if (!from || !to) return false
    try {
      from.disconnect(to)
      this._edges.get(fromId)?.delete(toId)
      return true
    } catch (_) { return false }
  }

  disconnectAll(fromId: string): void {
    const edges = this._edges.get(fromId)
    if (!edges) return
    for (const toId of Array.from(edges)) this.disconnect(fromId, toId)
    this._edges.delete(fromId)
  }

  getMatrix(): Record<string, string[]> {
    const m: Record<string, string[]> = {}
    for (const [from, tos] of this._edges) m[from] = Array.from(tos)
    return m
  }

  getStats(): { nodes: number; edges: number } {
    let edges = 0
    for (const s of this._edges.values()) edges += s.size
    return { nodes: this._nodes.size, edges }
  }

  clear(): void {
    this._nodes.clear()
    this._edges.clear()
  }
}

export const dspGraph = new DSPGraphEngine()
export default dspGraph
