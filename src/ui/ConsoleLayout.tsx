/**
 * ConsoleLayout.tsx — Responsive layout system for ONA Live Studio.
 *
 * Breakpoints (based on viewport width × height):
 *   foh       (≥1400px wide): full FOH view — channels + buses + master visible
 *   laptop    (≥960px):       channels + collapsible right panel
 *   tablet-h  (≥600px):       channels + side panel as bottom sheet
 *   phone-v   (<600px):       single-column, bottom nav for panels
 *
 * Layout provides a context so child components can read the current mode
 * without prop drilling.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'

export type LayoutMode = 'foh' | 'laptop' | 'tablet-h' | 'phone-v'

export interface LayoutContextValue {
  mode:          LayoutMode
  channelWidth:  number       // px — varies by mode and channel count
  showSidePanel: boolean
  setShowSidePanel: (v: boolean) => void
}

const LayoutContext = createContext<LayoutContextValue>({
  mode:             'laptop',
  channelWidth:     72,
  showSidePanel:    true,
  setShowSidePanel: () => {},
})

export function useLayout(): LayoutContextValue {
  return useContext(LayoutContext)
}

function detectMode(w: number): LayoutMode {
  if (w >= 1400) return 'foh'
  if (w >= 960)  return 'laptop'
  if (w >= 600)  return 'tablet-h'
  return 'phone-v'
}

function channelWidthForMode(mode: LayoutMode, channelCount: number): number {
  if (mode === 'foh')      return 80
  if (mode === 'laptop')   return 72
  if (mode === 'tablet-h') return channelCount > 16 ? 56 : 64
  return 56
}

export interface ConsoleLayoutProps {
  channelCount: number
  children:     React.ReactNode
  /** Slot rendered in the right/bottom panel area */
  panel?:       React.ReactNode
  /** Slot rendered in the master bus area (FOH mode only) */
  master?:      React.ReactNode
  className?:   string
}

export function ConsoleLayout({
  channelCount,
  children,
  panel,
  master,
  className = '',
}: ConsoleLayoutProps): React.ReactElement {
  const [mode, setMode] = useState<LayoutMode>(() => detectMode(window.innerWidth))
  const [showSidePanel, setShowSidePanel] = useState(true)

  const onResize = useCallback(() => {
    setMode(detectMode(window.innerWidth))
  }, [])

  useEffect(() => {
    window.addEventListener('resize', onResize, { passive: true })
    return () => window.removeEventListener('resize', onResize)
  }, [onResize])

  const chWidth = channelWidthForMode(mode, channelCount)

  const ctx: LayoutContextValue = { mode, channelWidth: chWidth, showSidePanel, setShowSidePanel }

  if (mode === 'phone-v') {
    return (
      <LayoutContext.Provider value={ctx}>
        <div className={`console-layout console-layout--phone ${className}`}>
          <div className="console-layout__channels">{children}</div>
          {showSidePanel && panel && (
            <div className="console-layout__panel console-layout__panel--bottom">{panel}</div>
          )}
          <nav className="console-layout__bottom-nav">
            <button onClick={() => setShowSidePanel(false)}>Faders</button>
            <button onClick={() => setShowSidePanel(true)}>Panel</button>
          </nav>
        </div>
      </LayoutContext.Provider>
    )
  }

  if (mode === 'tablet-h') {
    return (
      <LayoutContext.Provider value={ctx}>
        <div className={`console-layout console-layout--tablet ${className}`}>
          <div className="console-layout__channels">{children}</div>
          {panel && (
            <div className="console-layout__panel console-layout__panel--right"
                 style={{ width: showSidePanel ? 280 : 0, overflow: 'hidden', transition: 'width 200ms' }}>
              {panel}
            </div>
          )}
        </div>
      </LayoutContext.Provider>
    )
  }

  if (mode === 'foh') {
    return (
      <LayoutContext.Provider value={ctx}>
        <div className={`console-layout console-layout--foh ${className}`}>
          <div className="console-layout__channels">{children}</div>
          {panel && <div className="console-layout__panel">{panel}</div>}
          {master && <div className="console-layout__master">{master}</div>}
        </div>
      </LayoutContext.Provider>
    )
  }

  // laptop (default)
  return (
    <LayoutContext.Provider value={ctx}>
      <div className={`console-layout console-layout--laptop ${className}`}>
        <div className="console-layout__channels">{children}</div>
        {panel && (
          <div className="console-layout__panel"
               style={{ width: showSidePanel ? 320 : 0, overflow: 'hidden', transition: 'width 200ms' }}>
            {panel}
          </div>
        )}
      </div>
    </LayoutContext.Provider>
  )
}

export default ConsoleLayout
