import { useState, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'

const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL',
  'MXN', 'KRW', 'SGD', 'HKD', 'NOK', 'SEK', 'DKK', 'PLN', 'ZAR', 'AED',
]

const TIMEZONES = [
  'UTC',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Amsterdam', 'Europe/Zurich', 'Europe/Warsaw', 'Europe/Moscow',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Singapore',
  'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'Pacific/Auckland',
]

export default function Settings() {
  const { user } = useAuth()
  const { refreshSettings } = useSettings()
  const [form, setForm] = useState(null)
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/settings', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setForm(data))
  }, [])

  if (user?.role !== 'admin') {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🔒</div>
        <p>Only admins can access settings.</p>
      </div>
    )
  }

  if (!form) return <div className="loading" style={{ minHeight: 200 }}>Loading settings…</div>

  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }))

  const save = async e => {
    e.preventDefault()
    setSaving(true)
    setStatus('')
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(form),
      })
      refreshSettings()
      setStatus('Saved.')
      setTimeout(() => setStatus(''), 2500)
    } catch {
      setStatus('Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Settings</h1>
        <p>Configure your workspace appearance and defaults.</p>
      </div>

      <form onSubmit={save} className="settings-form">
        <section className="settings-section">
          <h2 className="settings-section-title">Branding</h2>
          <div className="field">
            <label>Organization name</label>
            <input type="text" value={form.org_name} onChange={set('org_name')} required />
            <span className="field-hint">Displayed in the sidebar and page titles.</span>
          </div>
          <div className="field">
            <label>Accent color</label>
            <div className="color-field">
              <input
                type="color"
                value={form.accent_color}
                onChange={set('accent_color')}
                className="color-swatch"
              />
              <input
                type="text"
                value={form.accent_color}
                onChange={e => {
                  if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) set('accent_color')(e)
                }}
                maxLength={7}
                style={{ width: 96 }}
              />
            </div>
            <span className="field-hint">Used for active states, buttons, and highlights.</span>
          </div>
        </section>

        <section className="settings-section">
          <h2 className="settings-section-title">Localization</h2>
          <div className="field-row">
            <div className="field">
              <label>Currency</label>
              <select value={form.currency} onChange={set('currency')}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <span className="field-hint">Used in budget and cost fields.</span>
            </div>
            <div className="field">
              <label>Timezone</label>
              <select value={form.timezone} onChange={set('timezone')}>
                {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
              </select>
              <span className="field-hint">Used for scheduling and calendar display.</span>
            </div>
          </div>
        </section>

        <div className="settings-actions">
          <button type="submit" className="btn-primary" style={{ width: 'auto', padding: '9px 24px' }} disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          {status && <span className="settings-status">{status}</span>}
        </div>
      </form>
    </>
  )
}
