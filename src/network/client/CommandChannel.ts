/**
 * CommandChannel.ts — Priority command queue with offline buffer and reconnect recovery.
 *
 * Sends commands to the correct Socket.IO namespace based on priority:
 *   CRITICAL + HIGH → /ctrl  (faders, mute, solo — lowest latency)
 *   MEDIUM + LOW    → /sync  (EQ, routing, scenes — can be deferred)
 *
 * Offline buffer:
 *   If not connected, commands are queued locally (max OFFLINE_QUEUE_MAX).
 *   On reconnect, queued commands are flushed in FIFO order.
 *   CRITICAL/HIGH bypass the queue and are retried immediately on reconnect.
 *
 * Metrics:
 *   sent, queued, dropped, ackd, avgAckMs
 */

const OFFLINE_QUEUE_MAX = 200
const ACK_WINDOW_MS     = 100  // rolling window for avg ack time

export const CMD_PRIORITY: Record<string, number> = {
  SET_MAIN_VOL:         0,
  SET_SUB_VOL:          0,
  SET_GAIN:             1,
  SET_MUTE:             1,
  SET_SOLO:             1,
  CLEAR_SOLO:           1,
  SET_PAN:              1,
  SET_CUE_LEVEL:        1,
  SET_CUE_MODE:         1,
  SET_TRIM:             1,
  SET_EQ:               2,
  SET_GATE:             2,
  SET_COMPRESSOR:       2,
  SET_HPF:              2,
  SET_LPF:              2,
  SET_AUX_SEND:         2,
  SET_AUX_LEVEL:        2,
  SET_AUX_MUTE:         2,
  SET_GROUP_SEND:       2,
  SET_GROUP_LEVEL:      2,
  SET_SUBGROUP_ROUTING: 2,
  SET_FX_BUS_SEND:      2,
  SET_FX_ACTIVE:        2,
  SET_FX_WET:           2,
  SET_ROUTING:          2,
  SET_REVERB_SEND:      2,
  SET_DELAY_SEND:       2,
  SET_FX:               2,
  SET_MIX_PROTECTION:   2,
  LOAD_SCENE:           3,
  SAVE_SCENE:           3,
  SET_PAN_LAW:          3,
  SET_PERF_MODE:        3,
  RECALL_SCENE:         3,
}

interface QueuedCommand {
  type:      string
  channelId: number | null
  payload:   any
  ts:        number
  priority:  number
}

export class CommandChannel {
  private _ctrlSocket: any   = null
  private _syncSocket: any   = null
  private _connected         = false
  private _offlineQueue: QueuedCommand[] = []

  private _sent    = 0
  private _queued  = 0
  private _dropped = 0
  private _ackd    = 0
  private _ackTimes: number[] = []
  private _pendingAcks = new Map<number, number>()  // seq → sentAt

  attach(ctrlSocket: any, syncSocket: any): void {
    this._ctrlSocket = ctrlSocket
    this._syncSocket = syncSocket

    ctrlSocket.on('connect',    () => { this._connected = true;  this._flushQueue() })
    ctrlSocket.on('disconnect', () => { this._connected = false })
    syncSocket.on('connect',    () => this._flushQueue())

    ctrlSocket.on('command_ack', ({ seq }: { seq: number }) => {
      const sentAt = this._pendingAcks.get(seq)
      if (sentAt) {
        const rtt = Date.now() - sentAt
        this._ackTimes.push(rtt)
        if (this._ackTimes.length > ACK_WINDOW_MS) this._ackTimes.shift()
        this._pendingAcks.delete(seq)
        this._ackd++
      }
    })
  }

  /**
   * Send a command. Automatically routes to /ctrl or /sync by priority.
   * Queues locally if disconnected. Deduplicates: last write wins per (type, channelId).
   */
  send(type: string, channelId: number | null, payload: any): void {
    const priority = CMD_PRIORITY[type] ?? 2
    const cmd: QueuedCommand = { type, channelId, payload, ts: Date.now(), priority }

    if (!this._connected) {
      this._enqueue(cmd)
      return
    }

    this._dispatch(cmd)
  }

  private _dispatch(cmd: QueuedCommand): void {
    const socket = cmd.priority <= 1 ? this._ctrlSocket : this._syncSocket
    if (!socket?.connected) { this._enqueue(cmd); return }

    const envelope = { type: cmd.type, channelId: cmd.channelId, payload: cmd.payload, ts: cmd.ts }
    socket.emit('command', envelope)
    this._sent++
  }

  private _enqueue(cmd: QueuedCommand): void {
    // Dedup: replace existing same (type, channelId) entry
    const idx = this._offlineQueue.findIndex(
      q => q.type === cmd.type && q.channelId === cmd.channelId
    )
    if (idx >= 0) this._offlineQueue.splice(idx, 1)

    if (this._offlineQueue.length >= OFFLINE_QUEUE_MAX) {
      // Drop lowest priority entries first
      this._offlineQueue.sort((a, b) => a.priority - b.priority)
      this._offlineQueue.pop()
      this._dropped++
    }

    this._offlineQueue.push(cmd)
    this._queued++
  }

  private _flushQueue(): void {
    if (this._offlineQueue.length === 0) return
    // Sort by priority before flush
    this._offlineQueue.sort((a, b) => a.priority - b.priority)
    console.log(`[CmdChannel] flushing ${this._offlineQueue.length} queued commands`)
    const toFlush = [...this._offlineQueue]
    this._offlineQueue.length = 0
    for (const cmd of toFlush) this._dispatch(cmd)
  }

  get connected(): boolean { return this._connected }

  getMetrics() {
    const avgAck = this._ackTimes.length > 0
      ? +(this._ackTimes.reduce((a, b) => a + b, 0) / this._ackTimes.length).toFixed(1)
      : -1
    return {
      connected:    this._connected,
      sent:         this._sent,
      queued:       this._offlineQueue.length,
      totalQueued:  this._queued,
      dropped:      this._dropped,
      ackd:         this._ackd,
      avgAckMs:     avgAck,
    }
  }
}
