/**
 * VirtualChannelList.tsx — Horizontal virtualized channel strip list.
 *
 * Renders only the visible channels in a horizontally scrollable container.
 * Supports 8, 16, 32, 64, 96-channel sessions without DOM node explosion.
 *
 * How it works:
 *   - Outer container: full scroll width = channelCount × channelWidth
 *   - Inner viewport: only renders channels [firstVisible, lastVisible]
 *   - Translate inner container by firstVisible × channelWidth
 *   - Scroll events update visible range synchronously (no React batching delay)
 *   - Overscan: renders 2 extra channels left/right to prevent blank flash
 */

import React, { useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react'

export interface ChannelRenderProps {
  channelId:    number
  index:        number
  isVisible:    boolean
}

export interface VirtualChannelListProps {
  channelCount:  number
  channelWidth:  number                // px per channel strip, default 72
  height?:       number                // container height px, default '100%'
  overscan?:     number                // extra channels each side, default 2
  renderChannel: (props: ChannelRenderProps) => React.ReactNode
  className?:    string
  style?:        React.CSSProperties
  onVisibleRange?: (first: number, last: number) => void
}

export function VirtualChannelList({
  channelCount,
  channelWidth,
  height,
  overscan = 2,
  renderChannel,
  className = '',
  style,
  onVisibleRange,
}: VirtualChannelListProps): React.ReactElement {
  const viewportRef  = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState<[number, number]>([0, Math.min(channelCount - 1, 15)])

  const computeRange = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const scrollX = el.scrollLeft
    const vw      = el.clientWidth

    const first = Math.max(0, Math.floor(scrollX / channelWidth) - overscan)
    const last  = Math.min(channelCount - 1, Math.ceil((scrollX + vw) / channelWidth) + overscan)
    setRange(r => (r[0] === first && r[1] === last ? r : [first, last]))
    onVisibleRange?.(first, last)
  }, [channelCount, channelWidth, overscan, onVisibleRange])

  useLayoutEffect(() => { computeRange() }, [computeRange])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    el.addEventListener('scroll', computeRange, { passive: true })
    const ro = new ResizeObserver(computeRange)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', computeRange)
      ro.disconnect()
    }
  }, [computeRange])

  const [first, last] = range
  const totalWidth    = channelCount * channelWidth
  const offsetLeft    = first * channelWidth

  const channels: React.ReactNode[] = []
  for (let i = first; i <= last; i++) {
    channels.push(
      <div
        key={i}
        style={{ width: channelWidth, flexShrink: 0 }}
      >
        {renderChannel({ channelId: i + 1, index: i, isVisible: true })}
      </div>
    )
  }

  return (
    <div
      ref={viewportRef}
      className={`virtual-channel-list ${className}`}
      style={{
        overflowX:  'auto',
        overflowY:  'hidden',
        height:     height ?? '100%',
        position:   'relative',
        ...style,
      }}
    >
      {/* Spacer that creates full scroll width */}
      <div style={{ width: totalWidth, height: 1, position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }} />
      {/* Translated window of rendered channels */}
      <div
        style={{
          display:   'flex',
          transform: `translateX(${offsetLeft}px)`,
          height:    '100%',
          willChange: 'transform',
        }}
      >
        {channels}
      </div>
    </div>
  )
}

export default VirtualChannelList
