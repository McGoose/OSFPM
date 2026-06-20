import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'

function fmt(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}

export default function ActorAvailability() {
  const { token } = useParams()

  const [state, setState]   = useState('loading')
  const [errorMsg, setError] = useState('')
  const [actor, setActor]   = useState(null)
  const [events, setEvents] = useState([])
  const [avail, setAvail]   = useState({}) // { eventId: true | false | null }
  const [name, setName]     = useState('')
  const [phone, setPhone]   = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetch(`/api/casting-availability/${token}`)
      .then(async r => {
        const data = await r.json()
        if (!r.ok) { setError(data.error); setState('error'); return }
        setActor(data.actor)
        setEvents(data.castingEvents)
        setName(data.actor.name ?? '')
        setPhone(data.actor.phone ?? '')
        const map = {}
        for (const ev of data.castingEvents) {
          map[ev.id] = ev.available // true | false | null
        }
        setAvail(map)
        setState('form')
      })
      .catch(() => { setError('Could not connect to the server.'); setState('error') })
  }, [token])

  const toggle = (id, val) => setAvail(p => ({ ...p, [id]: p[id] === val ? null : val }))

  const submit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    const res = await fetch(`/api/casting-availability/${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, availability: avail }),
    })
    setSubmitting(false)
    if (res.ok) setState('success')
    else { const d = await res.json(); setError(d.error ?? 'Something went wrong.') }
  }

  if (state === 'loading') {
    return (
      <div className="ob-page">
        <div className="ob-card"><p className="ob-loading">Loading…</p></div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="ob-page">
        <div className="ob-card">
          <div className="ob-wordmark">OSFPM</div>
          <h1 className="ob-title" style={{ color: '#e05a5a' }}>Link invalid</h1>
          <p className="ob-subtitle">{errorMsg}</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>
            Contact your production coordinator and ask them to resend the availability link.
          </p>
        </div>
      </div>
    )
  }

  if (state === 'success') {
    return (
      <div className="ob-page">
        <div className="ob-card">
          <div className="ob-wordmark">OSFPM</div>
          <div className="ob-success-icon">✓</div>
          <h1 className="ob-title">Availability submitted!</h1>
          <p className="ob-subtitle">
            The production team will be in touch to confirm your casting time.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="ob-page">
      <div className="ob-card">
        <div className="ob-wordmark">OSFPM</div>
        <h1 className="ob-title">Casting availability</h1>
        {actor?.role && (
          <p className="ob-subtitle">You're being considered for: <strong>{actor.role}</strong></p>
        )}
        <p className="ob-intro">
          Please tell us when you're available for casting. Mark each session as available or unavailable.
        </p>

        <form onSubmit={submit}>
          <div className="ob-section">
            <div className="ob-section-title">Your details</div>
            <div className="ob-row">
              <div className="ob-field">
                <label>Name</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Your full name" />
              </div>
              <div className="ob-field">
                <label>Phone</label>
                <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+44 7700 000000" type="tel" />
              </div>
            </div>
          </div>

          <div className="ob-section">
            <div className="ob-section-title">Casting sessions</div>
            {events.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No casting sessions have been scheduled yet.</p>
            )}
            {events.map(ev => (
              <div key={ev.id} className="avail-session">
                <div className="avail-session-info">
                  <div className="avail-session-date">{fmt(ev.date)}</div>
                  <div className="avail-session-time">{ev.startTime}–{ev.endTime}</div>
                  {ev.location && <div className="avail-session-loc">📍 {ev.location}</div>}
                  {ev.title && <div className="avail-session-title">{ev.title}</div>}
                </div>
                <div className="avail-btns">
                  <button type="button"
                    className={`avail-btn avail-yes${avail[ev.id] === true ? ' active' : ''}`}
                    onClick={() => toggle(ev.id, true)}
                  >
                    ✓ Available
                  </button>
                  <button type="button"
                    className={`avail-btn avail-no${avail[ev.id] === false ? ' active' : ''}`}
                    onClick={() => toggle(ev.id, false)}
                  >
                    ✗ Unavailable
                  </button>
                </div>
              </div>
            ))}
          </div>

          {errorMsg && <p style={{ color: '#e05a5a', fontSize: 13, marginBottom: 12 }}>{errorMsg}</p>}

          <div className="ob-actions">
            <button type="submit" className="ob-submit" disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit availability'}
            </button>
            <p className="ob-note">
              You can use this link again to update your availability before casting begins.
            </p>
          </div>
        </form>
      </div>
    </div>
  )
}
