/**
 * UILayerManager.ts — Layer registry for ordered UI render/interaction passes.
 *
 * Layers (bottom to top):
 *   metering   (0): canvas meter redraws — registered with renderScheduler CRITICAL
 *   control    (1): fader + knob state polling — HIGH
 *   panels     (2): EQ/comp/gate panel redraws — MEDIUM
 *   overlay    (3): modals, tooltips — LOW
 *
 * Each layer owns a Set of callbacks. UILayerManager wires them into
 * renderScheduler under the appropriate priority and keeps the unsubscribe
 * handles so layers can be torn down atomically.
 */

import { renderScheduler, RENDER_PRIORITY, type SchedulePriority } from './RenderScheduler'

export type LayerName = 'metering' | 'control' | 'panels' | 'overlay'

type LayerCallback = (now: number, delta: number) => void

const LAYER_PRIORITY: Record<LayerName, SchedulePriority> = {
  metering: RENDER_PRIORITY.CRITICAL,
  control:  RENDER_PRIORITY.HIGH,
  panels:   RENDER_PRIORITY.MEDIUM,
  overlay:  RENDER_PRIORITY.LOW,
}

interface LayerEntry {
  id:          string
  layer:       LayerName
  fn:          LayerCallback
  unsubscribe: () => void
}

class UILayerManager {
  private _entries = new Map<string, LayerEntry>()
  private _seq     = 0

  /**
   * Register a callback on a named layer.
   * @returns unsubscribe function
   */
  register(layer: LayerName, fn: LayerCallback, idHint?: string): () => void {
    const id  = idHint ?? `${layer}_${++this._seq}`
    const pri = LAYER_PRIORITY[layer]
    const unsub = renderScheduler.register(id, pri, fn)
    this._entries.set(id, { id, layer, fn, unsubscribe: unsub })
    return () => this._remove(id)
  }

  private _remove(id: string): void {
    const entry = this._entries.get(id)
    if (!entry) return
    entry.unsubscribe()
    this._entries.delete(id)
  }

  /** Remove all callbacks registered on a layer */
  clearLayer(layer: LayerName): void {
    for (const [id, entry] of this._entries) {
      if (entry.layer === layer) this._remove(id)
    }
  }

  /** Remove all registrations */
  clear(): void {
    for (const id of this._entries.keys()) this._remove(id)
  }

  getStats() {
    const counts: Record<LayerName, number> = { metering: 0, control: 0, panels: 0, overlay: 0 }
    for (const entry of this._entries.values()) counts[entry.layer]++
    return {
      total: this._entries.size,
      byLayer: counts,
      scheduler: renderScheduler.getMetrics(),
    }
  }
}

export const uiLayerManager = new UILayerManager()
