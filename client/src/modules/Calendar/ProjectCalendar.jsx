import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'

// ── Constants ────────────────────────────────────────────────────────────────

const TYPE_CFG = {
  meeting:   { label: 'Meeting',   color: '#4a9eff', icon: '◎' },
  recce:     { label: 'Recce',     color: '#f59e0b', icon: '◉' },
  casting:   { label: 'Casting',   color: '#a855f7', icon: '✦' },
  rehearsal: { label: 'Rehearsal', color: '#14b8a6', icon: '◈' },
  shoot_day: { label: 'Shoot Day', color: '#ef4444', icon: '⬤' },
}

const LOCATION_TYPES = [
  { value: 'in_person', label: 'In person' },
  { value: 'online',    label: 'Online' },
  { value: 'hybrid',    label: 'Hybrid' },
]

const DAYS   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December']

// ── Helpers ──────────────────────────────────────────────────────────────────

function toIso(d) { return d.toISOString().slice(0, 10) }

function gridDays(year, month) {
  const first = new Date(year, month, 1)
  const last  = new Date(year, month + 1, 0)
  const startDow = (first.getDay() + 6) % 7 // Mon-based
  const days = []
  for (let i = startDow - 1; i >= 0; i--) days.push(new Date(year, month, -i))
  for (let d = 1; d <= last.getDate(); d++) days.push(new Date(year, month, d))
  const rem = days.length % 7
  if (rem) for (let d = 1; d <= 7 - rem; d++) days.push(new Date(year, month + 1, d))
  return days
}

function parseMins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m }
function fmtMins(m)   { return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}` }
function durH(s, e)   { return ((parseMins(e) - parseMins(s)) / 60).toFixed(1) }

function pageSum(scenes, ids) {
  return ids.reduce((s, id) => s + (scenes.find(sc => sc.id === id)?.pages ?? 0), 0)
}

function fmt(date) {
  return new Date(date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

// ── Attendee picker ──────────────────────────────────────────────────────────

function AttendeePicker({ departments, crew, value, onChange }) {
  const [tab, setTab] = useState('departments')
  const deptIds   = new Set(value.filter(a => a.type === 'department').map(a => a.departmentId))
  const memberIds = new Set(value.filter(a => a.type === 'member').map(a => a.memberId))

  const toggleDept = id => {
    deptIds.has(id)
      ? onChange(value.filter(a => !(a.type === 'department' && a.departmentId === id)))
      : onChange([...value, { type: 'department', departmentId: id }])
  }
  const toggleMember = id => {
    memberIds.has(id)
      ? onChange(value.filter(a => !(a.type === 'member' && a.memberId === id)))
      : onChange([...value, { type: 'member', memberId: id }])
  }

  return (
    <div className="attendee-picker">
      <div className="attendee-tabs">
        {['departments', 'individuals'].map(t => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {t === 'departments' && deptIds.size > 0 && <span className="cal-badge">{deptIds.size}</span>}
            {t === 'individuals' && memberIds.size > 0 && <span className="cal-badge">{memberIds.size}</span>}
          </button>
        ))}
      </div>
      <div className="attendee-list">
        {tab === 'departments' && (departments.length === 0
          ? <p className="cal-empty-hint">No departments yet</p>
          : departments.map(d => (
            <label key={d.id} className="attendee-item">
              <input type="checkbox" checked={deptIds.has(d.id)} onChange={() => toggleDept(d.id)} />
              <span>{d.icon} {d.name}</span>
            </label>
          )))}
        {tab === 'individuals' && (crew.length === 0
          ? <p className="cal-empty-hint">No crew yet</p>
          : crew.map(m => (
            <label key={m.id} className="attendee-item">
              <input type="checkbox" checked={memberIds.has(m.id)} onChange={() => toggleMember(m.id)} />
              <span>{m.name}{m.role ? <em> — {m.role}</em> : ''}</span>
            </label>
          )))}
      </div>
    </div>
  )
}

// ── Scene picker ─────────────────────────────────────────────────────────────

function ScenePicker({ scenes, value, onChange }) {
  const sel = new Set(value)
  const pages = pageSum(scenes, value)

  return (
    <div className="scene-picker">
      <div className="scene-picker-summary">
        {value.length} scene{value.length !== 1 ? 's' : ''} · {pages.toFixed(2)} pages · est. {pages.toFixed(1)}h
        {pages > 12 && <span className="scene-warn"> ⚠ exceeds 12h max</span>}
      </div>
      <div className="scene-picker-list">
        {scenes.length === 0
          ? <p className="cal-empty-hint">No scenes in breakdown yet</p>
          : scenes.map(s => (
            <label key={s.id} className={`scene-item${sel.has(s.id) ? ' sel' : ''}`}>
              <input type="checkbox" checked={sel.has(s.id)}
                onChange={() => sel.has(s.id) ? onChange(value.filter(id => id !== s.id)) : onChange([...value, s.id])} />
              <span className="scene-num">{s.sceneNumber}</span>
              <span className="scene-loc">{s.intExt}. {s.location} ({s.timeOfDay})</span>
              <span className="scene-pp">{s.pages}pp</span>
            </label>
          ))}
      </div>
    </div>
  )
}

// ── Casting slot list ────────────────────────────────────────────────────────

function CastingSlots({ event, potentialActors, onSlotChange }) {
  const availableActors = potentialActors.filter(a =>
    (a.availability ?? []).some(av => av.eventId === event.id && av.available)
  )

  return (
    <div className="casting-slots">
      <div className="casting-slots-header">
        <span>{event.slots?.length ?? 0} slots · {availableActors.length} actor{availableActors.length !== 1 ? 's' : ''} available</span>
      </div>
      {(event.slots ?? []).length === 0
        ? <p className="cal-empty-hint">No slots generated yet. Edit the event to set slot duration.</p>
        : (event.slots ?? []).map(slot => {
          const assignedActor = potentialActors.find(a => a.id === slot.actorId)
          const slotAvail = potentialActors.filter(a =>
            (a.availability ?? []).some(av => av.eventId === event.id && av.available)
          )
          return (
            <div key={slot.id} className={`casting-slot${slot.isBreak ? ' is-break' : ''}`}>
              <div className="casting-slot-time">{slot.startTime}–{slot.endTime}</div>
              {slot.isBreak
                ? <div className="casting-slot-break">— Break —</div>
                : (
                  <select
                    className="casting-slot-actor"
                    value={slot.actorId ?? ''}
                    onChange={e => onSlotChange(slot.id, { actorId: e.target.value ? parseInt(e.target.value) : null })}
                  >
                    <option value="">Unassigned</option>
                    {slotAvail.map(a => (
                      <option key={a.id} value={a.id}>✓ {a.name}{a.role ? ` (${a.role})` : ''}</option>
                    ))}
                    {potentialActors.filter(a => !slotAvail.find(sa => sa.id === a.id)).map(a => (
                      <option key={a.id} value={a.id}>{a.name}{a.role ? ` (${a.role})` : ''}</option>
                    ))}
                  </select>
                )}
            </div>
          )
        })}
    </div>
  )
}

// ── Event form ───────────────────────────────────────────────────────────────

function blankForm(type, date) {
  return {
    type, title: '', date: date ?? toIso(new Date()),
    startTime: '09:00', endTime: '17:00',
    location: '', locationType: 'in_person', notes: '',
    slotDurationMinutes: 20, breakAfterSlots: '', breakDurationMinutes: 15,
    attendees: [], sceneIds: [],
  }
}

function EventForm({ initial, departments, crew, scenes, potentialActors, projectId, onSave, onCancel, onDelete, isAdmin }) {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const durationH = form.startTime && form.endTime ? durH(form.startTime, form.endTime) : 0

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setSaving(true)

    const body = {
      ...form,
      slotDurationMinutes: form.type === 'casting' ? (parseInt(form.slotDurationMinutes) || null) : undefined,
      breakAfterSlots: form.type === 'casting' ? (parseInt(form.breakAfterSlots) || null) : undefined,
      breakDurationMinutes: form.type === 'casting' ? (parseInt(form.breakDurationMinutes) || null) : undefined,
    }

    const isNew = !form.id
    const url = isNew
      ? `/api/projects/${projectId}/events`
      : `/api/projects/${projectId}/events/${form.id}`
    const method = isNew ? 'POST' : 'PUT'

    const res = await fetch(url, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSaving(false)

    if (res.ok) {
      const saved = await res.json()
      onSave(saved, isNew)
    } else {
      const d = await res.json()
      setError(d.error ?? 'Something went wrong.')
    }
  }

  const del = async () => {
    if (!form.id || !window.confirm('Delete this event?')) return
    const res = await fetch(`/api/projects/${projectId}/events/${form.id}`, {
      method: 'DELETE', credentials: 'include',
    })
    if (res.ok) onDelete(form.id)
  }

  const cfg = TYPE_CFG[form.type] ?? TYPE_CFG.meeting

  return (
    <form className="cal-form" onSubmit={submit}>
      {/* Type selector (new events only) */}
      {!form.id && (
        <div className="cal-form-section">
          <div className="cal-type-grid">
            {Object.entries(TYPE_CFG).map(([t, c]) => (
              <button key={t} type="button"
                className={`cal-type-btn${form.type === t ? ' active' : ''}`}
                style={{ '--type-color': c.color }}
                onClick={() => set('type', t)}
              >
                <span className="cal-type-icon">{c.icon}</span>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Title */}
      <div className="cal-form-section">
        <div className="cal-field">
          <label>Title</label>
          <input value={form.title} onChange={e => set('title', e.target.value)}
            placeholder={cfg.label} />
        </div>
      </div>

      {/* Date & time */}
      <div className="cal-form-section">
        <div className="cal-field-row">
          <div className="cal-field">
            <label>Date</label>
            <input type="date" value={form.date} onChange={e => set('date', e.target.value)} required />
          </div>
          <div className="cal-field">
            <label>Start</label>
            <input type="time" value={form.startTime} onChange={e => set('startTime', e.target.value)} required />
          </div>
          <div className="cal-field">
            <label>End</label>
            <input type="time" value={form.endTime} onChange={e => set('endTime', e.target.value)} required />
          </div>
        </div>
        {form.type === 'shoot_day' && durationH > 0 && (
          <p className={`cal-duration-hint${durationH > 12 ? ' warn' : ''}`}>
            {durationH}h {durationH > 12 ? '— exceeds 12-hour maximum' : ''}
          </p>
        )}
      </div>

      {/* Location */}
      {form.type !== 'shoot_day' && (
        <div className="cal-form-section">
          <div className="cal-field-row">
            <div className="cal-field" style={{ flex: 2 }}>
              <label>Location</label>
              <input value={form.location} onChange={e => set('location', e.target.value)}
                placeholder={form.type === 'recce' ? 'Location (required to visit)' : 'Address or link'} />
            </div>
            {form.type !== 'recce' && (
              <div className="cal-field">
                <label>Format</label>
                <select value={form.locationType} onChange={e => set('locationType', e.target.value)}>
                  {LOCATION_TYPES.map(lt => <option key={lt.value} value={lt.value}>{lt.label}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Shoot day — scene picker */}
      {form.type === 'shoot_day' && (
        <div className="cal-form-section">
          <div className="cal-section-label">Scenes</div>
          <ScenePicker scenes={scenes} value={form.sceneIds} onChange={v => set('sceneIds', v)} />
        </div>
      )}

      {/* Casting — slot settings */}
      {form.type === 'casting' && (
        <div className="cal-form-section">
          <div className="cal-section-label">Casting slots</div>
          <div className="cal-field-row">
            <div className="cal-field">
              <label>Slot duration (min)</label>
              <input type="number" min={5} max={120} value={form.slotDurationMinutes}
                onChange={e => set('slotDurationMinutes', e.target.value)} />
            </div>
            <div className="cal-field">
              <label>Break every N slots</label>
              <input type="number" min={1} value={form.breakAfterSlots}
                onChange={e => set('breakAfterSlots', e.target.value)} placeholder="Never" />
            </div>
            <div className="cal-field">
              <label>Break length (min)</label>
              <input type="number" min={5} value={form.breakDurationMinutes}
                onChange={e => set('breakDurationMinutes', e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {/* Attendees (all except casting) */}
      {form.type !== 'casting' && (
        <div className="cal-form-section">
          <div className="cal-section-label">Attendees</div>
          <AttendeePicker departments={departments} crew={crew}
            value={form.attendees} onChange={v => set('attendees', v)} />
        </div>
      )}

      {/* Notes */}
      <div className="cal-form-section">
        <div className="cal-field">
          <label>Notes</label>
          <textarea rows={3} value={form.notes} onChange={e => set('notes', e.target.value)}
            style={{ resize: 'vertical' }} />
        </div>
      </div>

      {error && <p className="cal-error">{error}</p>}

      <div className="cal-form-actions">
        <div className="cal-form-actions-left">
          {form.id && isAdmin && (
            <button type="button" className="btn-danger-sm" onClick={del}>Delete</button>
          )}
        </div>
        <div className="cal-form-actions-right">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : (form.id ? 'Save changes' : 'Create event')}
          </button>
        </div>
      </div>
    </form>
  )
}

// ── Event detail ─────────────────────────────────────────────────────────────

function EventDetail({ event, departments, crew, scenes, potentialActors, projectId, onEdit, onDelete, onSlotChange, isAdmin }) {
  const navigate = useNavigate()
  const cfg = TYPE_CFG[event.type] ?? TYPE_CFG.meeting

  const attendeeDepts   = (event.attendees ?? []).filter(a => a.type === 'department')
  const attendeeMembers = (event.attendees ?? []).filter(a => a.type === 'member')

  return (
    <div className="cal-detail">
      <div className="cal-detail-header" style={{ '--type-color': cfg.color }}>
        <div className="cal-detail-type">{cfg.icon} {cfg.label}</div>
        <h2 className="cal-detail-title">{event.title || cfg.label}</h2>
        <div className="cal-detail-meta">
          <span>{fmt(event.date)}</span>
          <span>·</span>
          <span>{event.startTime}–{event.endTime} ({durH(event.startTime, event.endTime)}h)</span>
        </div>
        {event.location && (
          <div className="cal-detail-location">
            {event.locationType === 'online' ? '💻' : event.locationType === 'hybrid' ? '🔀' : '📍'} {event.location}
          </div>
        )}
      </div>

      {/* Attendees */}
      {(attendeeDepts.length > 0 || attendeeMembers.length > 0) && (
        <div className="cal-detail-section">
          <div className="cal-section-label">Attendees</div>
          {attendeeDepts.map(a => {
            const d = departments.find(x => x.id === a.departmentId)
            return d ? <div key={a.id} className="cal-attendee-chip">{d.icon} {d.name}</div> : null
          })}
          {attendeeMembers.map(a => {
            const m = crew.find(x => x.id === a.memberId)
            return m ? <div key={a.id} className="cal-attendee-chip">◎ {m.name}</div> : null
          })}
        </div>
      )}

      {/* Scenes (shoot day) */}
      {event.type === 'shoot_day' && (event.sceneIds ?? []).length > 0 && (
        <div className="cal-detail-section">
          <div className="cal-section-label">
            Scenes — {pageSum(scenes, event.sceneIds).toFixed(2)}pp · est. {pageSum(scenes, event.sceneIds).toFixed(1)}h
          </div>
          {event.sceneIds.map(id => {
            const s = scenes.find(sc => sc.id === id)
            return s ? (
              <div key={id} className="cal-scene-chip">
                <strong>{s.sceneNumber}</strong> {s.intExt}. {s.location}
              </div>
            ) : null
          })}
        </div>
      )}

      {/* Casting slots */}
      {event.type === 'casting' && (
        <div className="cal-detail-section">
          <div className="cal-section-label">Casting slots</div>
          <CastingSlots event={event} potentialActors={potentialActors} onSlotChange={onSlotChange} />
        </div>
      )}

      {/* Notes */}
      {event.notes && (
        <div className="cal-detail-section">
          <div className="cal-section-label">Notes</div>
          <p className="cal-detail-notes">{event.notes}</p>
        </div>
      )}

      <div className="cal-detail-actions">
        <button className="btn-secondary" onClick={() => onEdit(event)}>Edit event</button>
        {event.type === 'shoot_day' && isAdmin && (
          <button
            className="btn-primary"
            onClick={() => navigate(`/projects/${projectId}/call-sheet/${event.id}`)}
          >
            Call Sheet →
          </button>
        )}
      </div>
    </div>
  )
}

// ── Calendar grid ────────────────────────────────────────────────────────────

function CalGrid({ year, month, events, onDayClick, onEventClick, selectedDate }) {
  const days = gridDays(year, month)
  const today = toIso(new Date())

  return (
    <div className="cal-grid">
      {DAYS.map(d => <div key={d} className="cal-day-header">{d}</div>)}
      {days.map(day => {
        const iso = toIso(day)
        const isCurrentMonth = day.getMonth() === month
        const dayEvents = events.filter(e => e.date === iso)
        return (
          <div
            key={iso}
            className={`cal-day${!isCurrentMonth ? ' other-month' : ''}${iso === today ? ' today' : ''}${iso === selectedDate ? ' selected' : ''}`}
            onClick={() => isCurrentMonth && onDayClick(iso)}
          >
            <div className="cal-day-num">{day.getDate()}</div>
            <div className="cal-day-events">
              {dayEvents.slice(0, 3).map(ev => {
                const cfg = TYPE_CFG[ev.type] ?? TYPE_CFG.meeting
                return (
                  <div key={ev.id} className="cal-event-pill"
                    style={{ '--pill-color': cfg.color }}
                    onClick={e => { e.stopPropagation(); onEventClick(ev) }}
                    title={`${ev.title || cfg.label} ${ev.startTime}–${ev.endTime}`}
                  >
                    {ev.title || cfg.label}
                  </div>
                )
              })}
              {dayEvents.length > 3 && (
                <div className="cal-more">+{dayEvents.length - 3} more</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Potential actors panel ────────────────────────────────────────────────────

function ActorsPanel({ actors, projectId, onRefresh }) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', phone: '', role: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [linkResult, setLinkResult] = useState({})
  const [copied, setCopied] = useState({})

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const save = async (e) => {
    e.preventDefault()
    setSaving(true)
    const res = await fetch(`/api/projects/${projectId}/potential-actors`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    setSaving(false)
    if (res.ok) { setForm({ name: '', email: '', phone: '', role: '', notes: '' }); setShowForm(false); onRefresh() }
  }

  const sendLink = async (actorId) => {
    const res = await fetch(`/api/projects/${projectId}/potential-actors/${actorId}/availability-link`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const data = await res.json()
    setLinkResult(p => ({ ...p, [actorId]: data }))
    onRefresh()
  }

  const copyLink = (actorId, link) => {
    navigator.clipboard.writeText(link)
    setCopied(p => ({ ...p, [actorId]: true }))
    setTimeout(() => setCopied(p => ({ ...p, [actorId]: false })), 2000)
  }

  const del = async (actorId) => {
    if (!window.confirm('Remove this actor?')) return
    await fetch(`/api/projects/${projectId}/potential-actors/${actorId}`, {
      method: 'DELETE', credentials: 'include',
    })
    onRefresh()
  }

  return (
    <div className="actors-panel">
      <div className="actors-panel-header">
        <span className="cal-section-label" style={{ margin: 0 }}>Potential Actors</span>
        <button className="btn-primary-sm" onClick={() => setShowForm(p => !p)}>
          {showForm ? 'Cancel' : '+ Add actor'}
        </button>
      </div>

      {showForm && (
        <form className="actor-form" onSubmit={save}>
          <input placeholder="Name *" value={form.name} onChange={e => set('name', e.target.value)} required />
          <input placeholder="Email" value={form.email} onChange={e => set('email', e.target.value)} />
          <input placeholder="Phone" value={form.phone} onChange={e => set('phone', e.target.value)} />
          <input placeholder="Role / character auditioning for" value={form.role} onChange={e => set('role', e.target.value)} />
          <div className="actor-form-actions">
            <button type="submit" className="btn-primary-sm" disabled={saving}>
              {saving ? 'Adding…' : 'Add actor'}
            </button>
          </div>
        </form>
      )}

      <div className="actors-list">
        {actors.length === 0 && !showForm && (
          <p className="cal-empty-hint">No potential actors yet. Add actors to send them casting availability links.</p>
        )}
        {actors.map(actor => {
          const result = linkResult[actor.id]
          const submitted = actor.availabilitySubmittedAt
          const availCount = (actor.availability ?? []).filter(a => a.available).length
          return (
            <div key={actor.id} className="actor-row">
              <div className="actor-row-info">
                <div className="actor-name">{actor.name}</div>
                {actor.role && <div className="actor-role">{actor.role}</div>}
                {submitted && <div className="actor-status">✓ Availability submitted · {availCount} session{availCount !== 1 ? 's' : ''}</div>}
              </div>
              <div className="actor-row-actions">
                {result?.link && !result?.emailSent && (
                  <button className="btn-link-sm" onClick={() => copyLink(actor.id, result.link)}>
                    {copied[actor.id] ? 'Copied!' : 'Copy link'}
                  </button>
                )}
                {result?.emailSent && <span className="actor-sent">✓ Email sent</span>}
                <button className="btn-secondary-sm" onClick={() => sendLink(actor.id)}
                  title={actor.email ? undefined : 'Add email first'} disabled={!actor.email}>
                  {submitted ? 'Resend' : 'Send link'}
                </button>
                <button className="btn-ghost-sm" onClick={() => del(actor.id)}>×</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ProjectCalendar() {
  const { id: projectId } = useParams()

  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())

  const [events, setEvents]               = useState([])
  const [departments, setDepartments]     = useState([])
  const [crew, setCrew]                   = useState([])
  const [scenes, setScenes]               = useState([])
  const [potentialActors, setPotentialActors] = useState([])

  const [panel, setPanel]   = useState('idle')  // idle | form | detail | actors
  const [editing, setEditing] = useState(null)   // event being edited (or null for new)
  const [selected, setSelected] = useState(null) // selected event for detail
  const [formDate, setFormDate] = useState(null)
  const [isAdmin, setIsAdmin]   = useState(false)

  const load = useCallback(async () => {
    const [evRes, deptRes, crewRes, bdRes, actRes] = await Promise.all([
      fetch(`/api/projects/${projectId}/events`, { credentials: 'include' }),
      fetch(`/api/projects/${projectId}/departments`, { credentials: 'include' }),
      fetch(`/api/projects/${projectId}/crew`, { credentials: 'include' }),
      fetch(`/api/projects/${projectId}/breakdown`, { credentials: 'include' }),
      fetch(`/api/projects/${projectId}/potential-actors`, { credentials: 'include' }),
    ])
    if (evRes.ok)   setEvents(await evRes.json())
    if (deptRes.ok) setDepartments(await deptRes.json())
    if (crewRes.ok) setCrew(await crewRes.json())
    if (bdRes.ok)   setScenes((await bdRes.json()).map(s => ({ id: s.id, sceneNumber: s.sceneNumber, intExt: s.intExt, location: s.location, timeOfDay: s.timeOfDay, pages: s.pages })))
    if (actRes.ok)  setPotentialActors(await actRes.json())
  }, [projectId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setIsAdmin(data.user?.role === 'admin') })
  }, [])

  const prevMonth = () => { if (month === 0) { setMonth(11); setYear(y => y - 1) } else setMonth(m => m - 1) }
  const nextMonth = () => { if (month === 11) { setMonth(0); setYear(y => y + 1) } else setMonth(m => m + 1) }

  const handleDayClick = (iso) => {
    setFormDate(iso)
    setEditing(null)
    setSelected(null)
    setPanel('form')
  }

  const handleEventClick = (ev) => {
    setSelected(ev)
    setEditing(null)
    setPanel('detail')
  }

  const handleSave = (saved, isNew) => {
    if (isNew) {
      setEvents(p => [...p, saved])
    } else {
      setEvents(p => p.map(e => e.id === saved.id ? saved : e))
    }
    setSelected(saved)
    setEditing(null)
    setPanel('detail')
  }

  const handleDelete = (id) => {
    setEvents(p => p.filter(e => e.id !== id))
    setPanel('idle')
  }

  const handleEdit = (ev) => {
    setEditing({
      ...ev,
      attendees: ev.attendees ?? [],
      sceneIds: ev.sceneIds ?? [],
    })
    setPanel('form')
  }

  const handleSlotChange = async (slotId, updates) => {
    const res = await fetch(`/api/projects/${projectId}/events/${selected.id}/slots/${slotId}`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (res.ok) {
      // Refresh the selected event
      const evRes = await fetch(`/api/projects/${projectId}/events/${selected.id}`, { credentials: 'include' })
      if (evRes.ok) {
        const updated = await evRes.json()
        setEvents(p => p.map(e => e.id === updated.id ? updated : e))
        setSelected(updated)
      }
    }
  }

  const formInitial = editing
    ? { ...editing }
    : blankForm('meeting', formDate)

  return (
    <div className="cal-page">
      {/* ── Header ── */}
      <div className="page-header">
        <div className="page-header-row">
          <h1>Calendar</h1>
          <div className="cal-header-actions">
            <button className="btn-secondary" onClick={() => { setPanel(panel === 'actors' ? 'idle' : 'actors'); setSelected(null); setEditing(null) }}>
              {panel === 'actors' ? '← Back' : '🎭 Potential actors'}
            </button>
            <button className="btn-primary" onClick={() => { setFormDate(toIso(new Date())); setEditing(null); setPanel('form') }}>
              + New event
            </button>
          </div>
        </div>

        {/* Legend */}
        <div className="cal-legend">
          {Object.entries(TYPE_CFG).map(([t, c]) => (
            <span key={t} className="cal-legend-item" style={{ '--pill-color': c.color }}>
              {c.icon} {c.label}
            </span>
          ))}
        </div>
      </div>

      <div className="cal-layout">
        {/* ── Left: month grid ── */}
        <div className="cal-main">
          <div className="cal-month-nav">
            <button className="cal-nav-btn" onClick={prevMonth}>←</button>
            <span className="cal-month-title">{MONTHS[month]} {year}</span>
            <button className="cal-nav-btn" onClick={nextMonth}>→</button>
          </div>
          <CalGrid
            year={year} month={month} events={events}
            selectedDate={selected?.date ?? formDate}
            onDayClick={handleDayClick}
            onEventClick={handleEventClick}
          />
        </div>

        {/* ── Right: panel ── */}
        <div className="cal-side">
          {panel === 'idle' && (
            <div className="cal-idle">
              <p>Click a day to create an event, or click an existing event to view it.</p>
              {events.length > 0 && (
                <div className="cal-upcoming">
                  <div className="cal-section-label">Upcoming</div>
                  {[...events]
                    .filter(e => e.date >= toIso(new Date()))
                    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
                    .slice(0, 8)
                    .map(ev => {
                      const cfg = TYPE_CFG[ev.type] ?? TYPE_CFG.meeting
                      return (
                        <div key={ev.id} className="cal-upcoming-row" onClick={() => handleEventClick(ev)}>
                          <div className="cal-upcoming-dot" style={{ background: cfg.color }} />
                          <div>
                            <div className="cal-upcoming-title">{ev.title || cfg.label}</div>
                            <div className="cal-upcoming-meta">{fmt(ev.date)} · {ev.startTime}</div>
                          </div>
                        </div>
                      )
                    })}
                </div>
              )}
            </div>
          )}

          {panel === 'form' && (
            <div className="cal-panel">
              <div className="cal-panel-header">
                <div className="cal-panel-title">{editing ? 'Edit event' : 'New event'}</div>
              </div>
              <EventForm
                key={editing?.id ?? 'new'}
                initial={formInitial}
                departments={departments}
                crew={crew}
                scenes={scenes}
                potentialActors={potentialActors}
                projectId={projectId}
                isAdmin={isAdmin}
                onSave={handleSave}
                onCancel={() => setPanel(selected ? 'detail' : 'idle')}
                onDelete={handleDelete}
              />
            </div>
          )}

          {panel === 'detail' && selected && (
            <div className="cal-panel">
              <EventDetail
                key={selected.id}
                event={selected}
                departments={departments}
                crew={crew}
                scenes={scenes}
                potentialActors={potentialActors}
                projectId={projectId}
                isAdmin={isAdmin}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onSlotChange={handleSlotChange}
              />
            </div>
          )}

          {panel === 'actors' && (
            <div className="cal-panel">
              <ActorsPanel
                actors={potentialActors}
                projectId={projectId}
                onRefresh={load}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
