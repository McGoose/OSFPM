import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'

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

export default function Setup() {
  const { register, user } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({
    name: '', email: '', password: '',
    orgName: '', currency: 'USD', timezone: 'UTC',
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (user) { navigate('/', { replace: true }); return }
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(d => { if (d.hasUsers) navigate('/login', { replace: true }) })
  }, [user])

  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }))

  const submit = async e => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await register(form.name, form.email, form.password, form.orgName, form.currency, form.timezone)
      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card auth-card--wide">
        <div className="auth-logo">
          <div className="header-logo-mark">F</div>
          <span className="header-logo-text">OS<span>FPM</span></span>
        </div>
        <h1>Welcome to OSFPM</h1>
        <p className="auth-subtitle">Set up your workspace to get started.</p>
        <form onSubmit={submit}>
          <div className="setup-section-label">Admin account</div>
          <div className="field">
            <label>Your name</label>
            <input type="text" value={form.name} onChange={set('name')} autoFocus required />
          </div>
          <div className="field">
            <label>Email</label>
            <input type="email" value={form.email} onChange={set('email')} required />
          </div>
          <div className="field">
            <label>
              Password{' '}
              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(min. 8 characters)</span>
            </label>
            <input type="password" value={form.password} onChange={set('password')} minLength={8} required />
          </div>

          <div className="setup-section-label" style={{ marginTop: 20 }}>Workspace</div>
          <div className="field">
            <label>Organization / Production company name</label>
            <input
              type="text"
              value={form.orgName}
              onChange={set('orgName')}
              placeholder="e.g. Sunrise Films"
              required
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Currency</label>
              <select value={form.currency} onChange={set('currency')}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Timezone</label>
              <select value={form.timezone} onChange={set('timezone')}>
                {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            </div>
          </div>

          {error && <p className="auth-error">{error}</p>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Setting up...' : 'Create workspace'}
          </button>
        </form>
      </div>
    </div>
  )
}
