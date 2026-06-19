import { createContext, useContext, useState, useEffect } from 'react'

const SettingsContext = createContext({})

const DEFAULTS = {
  org_name: 'OSFPM',
  accent_color: '#e8a100',
  currency: 'USD',
  timezone: 'UTC',
}

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULTS)

  const load = () =>
    fetch('/api/settings/public')
      .then(r => r.json())
      .then(data => {
        setSettings(s => ({ ...s, ...data }))
        applyTheme(data)
      })
      .catch(() => {})

  useEffect(() => { load() }, [])

  const refreshSettings = () => load()

  return (
    <SettingsContext.Provider value={{ settings, refreshSettings }}>
      {children}
    </SettingsContext.Provider>
  )
}

function applyTheme({ accent_color }) {
  if (!accent_color) return
  const root = document.documentElement
  root.style.setProperty('--accent', accent_color)
  root.style.setProperty('--accent-hover', lighten(accent_color, 0.08))
  root.style.setProperty('--accent-muted', hexToRgba(accent_color, 0.12))
}

function lighten(hex, amount) {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = Math.min(255, ((n >> 16) & 0xff) + Math.round(255 * amount))
  const g = Math.min(255, ((n >> 8) & 0xff) + Math.round(255 * amount))
  const b = Math.min(255, (n & 0xff) + Math.round(255 * amount))
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`
}

export function useSettings() {
  return useContext(SettingsContext)
}
