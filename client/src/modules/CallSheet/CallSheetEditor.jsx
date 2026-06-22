import { useState, useEffect, useCallback, Suspense, lazy, Component } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useProject } from '../../context/ProjectContext'
import { useSettings } from '../../context/SettingsContext'

class PDFErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(e) { return { error: e } }
  render() {
    if (this.state.error) {
      return (
        <button className="btn-primary" disabled title={String(this.state.error)}>
          PDF unavailable
        </button>
      )
    }
    return this.props.children
  }
}

// Load both the PDF renderer and the PDF document together so CallSheetPDF
// is never passed as a lazy component into the custom PDF reconciler.
const PDFButton = lazy(() =>
  Promise.all([
    import('@react-pdf/renderer'),
    import('./CallSheetPDF'),
  ]).then(([mod, { default: CallSheetPDF }]) => ({
    default: function PDFButton({ data, event, crew, allScenes, projectTitle, orgName, fileName }) {
      return (
        <mod.PDFDownloadLink
          document={
            <CallSheetPDF
              data={data}
              event={event}
              crew={crew}
              allScenes={allScenes}
              projectTitle={projectTitle}
              orgName={orgName}
            />
          }
          fileName={fileName}
        >
          {({ loading }) => (
            <button className="btn-primary" disabled={loading}>
              {loading ? 'Generating…' : 'Download PDF'}
            </button>
          )}
        </mod.PDFDownloadLink>
      )
    },
  }))
)

const TABS = ['Times', 'Info', 'Cast', 'Extras', 'Dept Notes', 'Page 2', 'Advance']

const DEPT_NOTES_FIELDS = [
  ['artDept',      'Art Department'],
  ['props',        'Props'],
  ['makeup',       'Make-up'],
  ['costumes',     'Costumes'],
  ['sfx',          'SFX'],
  ['camera',       'Camera'],
  ['gripElectric', 'Grip / Electric'],
  ['sound',        'Sound'],
  ['locations',    'Locations'],
  ['vehicles',     'Vehicles'],
  ['stunts',       'Stunts'],
  ['animals',      'Animals'],
]

const DEFAULT_RADIO = `1 - Production  5 - Props  9 - Locations
2 - Open  6 - Camera  10 - Open
3 - Transpo  7 - G&E  11 - SFX
4 - Open  8 - Open  16 - Relay`

const DEFAULT_REMINDERS = `1. Appropriate footwear — no flip-flops/sandals
2. No personal photography on set
3. ENSURE YOUR PHONE IS ON SILENT OR OFF
4. DON'T FORGET TO DRINK WATER!
5. Keep conversation to a minimum on or near set`

function parseMins(t) {
  if (!t) return 0
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
function fmtMins(m) {
  const total = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function calcTimes(row, shootCall) {
  const shoot = parseMins(shootCall || '10:00')
  const hmuStart = shoot - (Number(row.hmuMins) || 0)
  const blocking = hmuStart - (Number(row.blockingMins) || 0)
  const arrival  = blocking - 5
  return {
    arrival:  fmtMins(arrival),
    blocking: fmtMins(blocking),
    hmu:      fmtMins(hmuStart),
    set:      shootCall || '10:00',
  }
}

function buildDefaultData(event, crew) {
  const castCrew = (crew || []).filter(m => m.type === 'cast')
  return {
    dayNumber: 1,
    totalDays: 7,
    crewCall:  event?.startTime || '10:00',
    setup:     '',
    shootCall: event?.startTime || '10:00',
    wrap:      event?.endTime   || '22:00',
    breakfast: '',
    meal1:     '',
    meal1End:  '',
    meal2:     '',
    meal2End:  '',
    tempHigh:  '',
    tempLow:   '',
    sunrise:   '',
    sunset:    '',
    travelMins: 0,
    scriptVersion:   '',
    scheduleVersion: '',
    setMedicName:  '',
    setMedicPhone: '',
    catering:      '',
    generalNote:   'NOTE: VIDEO VILLAGE IS A WORK AREA. ESSENTIAL PERSONNEL ONLY.',
    castRows: castCrew.map((m, i) => ({
      id:           i + 1,
      name:         m.name,
      character:    m.characterName || m.role || '',
      status:       'W',
      pickupTime:   '',
      blockingMins: 10,
      hmuMins:      30,
      notes:        '',
    })),
    extras: [{ description: '', count: '', arrival: '', onSet: '', scenes: '' }],
    specialInstructions: Object.fromEntries(DEPT_NOTES_FIELDS.map(([k]) => [k, ''])),
    advanceSceneIds: [],
    crewCallOverrides: {},
    emergencyPhone: '',
    policePhone:    '',
    firePhone:      '',
    hospitalAddress: '',
    radioChannels: DEFAULT_RADIO,
    reminders:     DEFAULT_REMINDERS,
    quote:         '',
  }
}

// ── Sub-forms ─────────────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <div className="cs-field">
      <label className="cs-label">{label}</label>
      {children}
    </div>
  )
}

function TimeInput({ value, onChange, ...props }) {
  return <input type="time" className="cs-input" value={value || ''} onChange={e => onChange(e.target.value)} {...props} />
}

function TextInput({ value, onChange, ...props }) {
  return <input type="text" className="cs-input" value={value || ''} onChange={e => onChange(e.target.value)} {...props} />
}

function NumInput({ value, onChange, ...props }) {
  return <input type="number" className="cs-input" value={value ?? ''} onChange={e => onChange(e.target.value)} {...props} />
}

function TimesTab({ d, set }) {
  return (
    <div className="cs-tab-panel">
      <div className="cs-section-label">Day</div>
      <div className="cs-row">
        <Field label="Day #"><NumInput value={d.dayNumber} onChange={v => set('dayNumber', parseInt(v))} min={1} /></Field>
        <Field label="Total days"><NumInput value={d.totalDays} onChange={v => set('totalDays', parseInt(v))} min={1} /></Field>
        <Field label="Travel to set (min)"><NumInput value={d.travelMins} onChange={v => set('travelMins', parseInt(v))} min={0} /></Field>
      </div>

      <div className="cs-section-label" style={{ marginTop: 16 }}>Call times</div>
      <div className="cs-row">
        <Field label="Crew call"><TimeInput value={d.crewCall} onChange={v => set('crewCall', v)} /></Field>
        <Field label="Setup"><TimeInput value={d.setup} onChange={v => set('setup', v)} /></Field>
        <Field label="Shoot call"><TimeInput value={d.shootCall} onChange={v => set('shootCall', v)} /></Field>
        <Field label="Wrap"><TimeInput value={d.wrap} onChange={v => set('wrap', v)} /></Field>
      </div>

      <div className="cs-section-label" style={{ marginTop: 16 }}>Meals</div>
      <div className="cs-row">
        <Field label="Breakfast"><TimeInput value={d.breakfast} onChange={v => set('breakfast', v)} /></Field>
        <Field label="1st Meal"><TimeInput value={d.meal1} onChange={v => set('meal1', v)} /></Field>
        <Field label="1st Meal end"><TimeInput value={d.meal1End} onChange={v => set('meal1End', v)} /></Field>
        <Field label="2nd Meal"><TimeInput value={d.meal2} onChange={v => set('meal2', v)} /></Field>
        <Field label="2nd Meal end"><TimeInput value={d.meal2End} onChange={v => set('meal2End', v)} /></Field>
      </div>
    </div>
  )
}

function InfoTab({ d, set }) {
  return (
    <div className="cs-tab-panel">
      <div className="cs-section-label">Versions &amp; info</div>
      <div className="cs-row">
        <Field label="Script version"><TextInput value={d.scriptVersion} onChange={v => set('scriptVersion', v)} placeholder="6.1" /></Field>
        <Field label="Schedule version"><TextInput value={d.scheduleVersion} onChange={v => set('scheduleVersion', v)} placeholder="5.0" /></Field>
        <Field label="Catering"><TextInput value={d.catering} onChange={v => set('catering', v)} /></Field>
      </div>
      <div className="cs-row">
        <Field label="Set medic name"><TextInput value={d.setMedicName} onChange={v => set('setMedicName', v)} /></Field>
        <Field label="Set medic phone"><TextInput value={d.setMedicPhone} onChange={v => set('setMedicPhone', v)} /></Field>
      </div>

      <div className="cs-section-label" style={{ marginTop: 16 }}>Weather</div>
      <div className="cs-row">
        <Field label="Temp high (°c)"><NumInput value={d.tempHigh} onChange={v => set('tempHigh', v)} /></Field>
        <Field label="Temp low (°c)"><NumInput value={d.tempLow} onChange={v => set('tempLow', v)} /></Field>
        <Field label="Sunrise"><TimeInput value={d.sunrise} onChange={v => set('sunrise', v)} /></Field>
        <Field label="Sunset"><TimeInput value={d.sunset} onChange={v => set('sunset', v)} /></Field>
      </div>

      <div className="cs-section-label" style={{ marginTop: 16 }}>General note</div>
      <textarea
        className="cs-textarea"
        rows={3}
        value={d.generalNote || ''}
        onChange={e => set('generalNote', e.target.value)}
        placeholder="E.g. VIDEO VILLAGE IS A WORK AREA. ESSENTIAL PERSONNEL ONLY."
      />
    </div>
  )
}

function CastTab({ d, set }) {
  const { shootCall, castRows } = d
  const rows = castRows || []

  const updateRow = (i, field, val) => {
    const next = [...rows]
    next[i] = { ...next[i], [field]: val }
    set('castRows', next)
  }

  const addRow = () => set('castRows', [...rows, {
    id: rows.length + 1, name: '', character: '', status: 'W',
    pickupTime: '', blockingMins: 10, hmuMins: 30, notes: '',
  }])

  const removeRow = (i) => set('castRows', rows.filter((_, j) => j !== i))

  const STATUS_OPTIONS = ['W', 'SW', 'WF', 'H', 'WD', 'SWF', 'HOD']

  return (
    <div className="cs-tab-panel">
      <p className="cs-hint">Times are auto-calculated from the Shoot Call ({shootCall || '?'}). Set H/MU and Blocking durations per actor.</p>
      <div className="cs-cast-table">
        <div className="cs-cast-header">
          <span style={{ flex: 0.3 }}>#</span>
          <span style={{ flex: 2 }}>Actor</span>
          <span style={{ flex: 2 }}>Character</span>
          <span style={{ flex: 0.8 }}>Status</span>
          <span style={{ flex: 0.8 }}>Pickup</span>
          <span style={{ flex: 0.9 }}>H/MU (min)</span>
          <span style={{ flex: 0.9 }}>Block (min)</span>
          <span style={{ flex: 0.8 }}>Arrival</span>
          <span style={{ flex: 0.8 }}>Block</span>
          <span style={{ flex: 0.8 }}>H/MU</span>
          <span style={{ flex: 0.8 }}>Set</span>
          <span style={{ flex: 2 }}>Notes</span>
          <span style={{ flex: 0.4 }}></span>
        </div>
        {rows.map((row, i) => {
          const t = calcTimes(row, shootCall)
          return (
            <div key={i} className="cs-cast-row">
              <span style={{ flex: 0.3, color: 'var(--text-muted)', fontSize: 12 }}>{i + 1}</span>
              <input className="cs-cast-input" style={{ flex: 2 }} value={row.name || ''} onChange={e => updateRow(i, 'name', e.target.value)} placeholder="Actor name" />
              <input className="cs-cast-input" style={{ flex: 2 }} value={row.character || ''} onChange={e => updateRow(i, 'character', e.target.value)} placeholder="Character" />
              <select className="cs-cast-input" style={{ flex: 0.8 }} value={row.status || 'W'} onChange={e => updateRow(i, 'status', e.target.value)}>
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <input type="time" className="cs-cast-input" style={{ flex: 0.8 }} value={row.pickupTime || ''} onChange={e => updateRow(i, 'pickupTime', e.target.value)} />
              <input type="number" className="cs-cast-input" style={{ flex: 0.9 }} value={row.hmuMins ?? 30} min={0} onChange={e => updateRow(i, 'hmuMins', parseInt(e.target.value))} />
              <input type="number" className="cs-cast-input" style={{ flex: 0.9 }} value={row.blockingMins ?? 10} min={0} onChange={e => updateRow(i, 'blockingMins', parseInt(e.target.value))} />
              <span className="cs-calc-time" style={{ flex: 0.8 }}>{t.arrival}</span>
              <span className="cs-calc-time" style={{ flex: 0.8 }}>{t.blocking}</span>
              <span className="cs-calc-time" style={{ flex: 0.8 }}>{t.hmu}</span>
              <span className="cs-calc-time" style={{ flex: 0.8 }}>{t.set}</span>
              <input className="cs-cast-input" style={{ flex: 2 }} value={row.notes || ''} onChange={e => updateRow(i, 'notes', e.target.value)} placeholder="Notes" />
              <button className="cs-rm-btn" style={{ flex: 0.4 }} onClick={() => removeRow(i)}>×</button>
            </div>
          )
        })}
        <button className="btn-secondary" style={{ marginTop: 8, width: 'auto', padding: '5px 14px', fontSize: 12 }} onClick={addRow}>
          + Add cast member
        </button>
      </div>
    </div>
  )
}

function ExtrasTab({ d, set }) {
  const rows = d.extras || []
  const updateRow = (i, field, val) => {
    const next = [...rows]; next[i] = { ...next[i], [field]: val }; set('extras', next)
  }
  const addRow = () => set('extras', [...rows, { description: '', count: '', arrival: '', onSet: '', scenes: '' }])
  const removeRow = (i) => set('extras', rows.filter((_, j) => j !== i))

  return (
    <div className="cs-tab-panel">
      <div className="cs-cast-table">
        <div className="cs-cast-header">
          <span style={{ flex: 0.4 }}>#</span>
          <span style={{ flex: 3 }}>Description</span>
          <span style={{ flex: 0.8 }}>Count</span>
          <span style={{ flex: 0.8 }}>Arrival</span>
          <span style={{ flex: 0.8 }}>On set</span>
          <span style={{ flex: 1 }}>Scenes</span>
          <span style={{ flex: 0.4 }}></span>
        </div>
        {rows.map((row, i) => (
          <div key={i} className="cs-cast-row">
            <span style={{ flex: 0.4, color: 'var(--text-muted)', fontSize: 12 }}>{i + 1}</span>
            <input className="cs-cast-input" style={{ flex: 3 }} value={row.description || ''} onChange={e => updateRow(i, 'description', e.target.value)} placeholder="Description" />
            <input type="number" className="cs-cast-input" style={{ flex: 0.8 }} value={row.count || ''} onChange={e => updateRow(i, 'count', e.target.value)} min={0} />
            <input type="time" className="cs-cast-input" style={{ flex: 0.8 }} value={row.arrival || ''} onChange={e => updateRow(i, 'arrival', e.target.value)} />
            <input type="time" className="cs-cast-input" style={{ flex: 0.8 }} value={row.onSet || ''} onChange={e => updateRow(i, 'onSet', e.target.value)} />
            <input className="cs-cast-input" style={{ flex: 1 }} value={row.scenes || ''} onChange={e => updateRow(i, 'scenes', e.target.value)} placeholder="e.g. 12, 14" />
            <button className="cs-rm-btn" style={{ flex: 0.4 }} onClick={() => removeRow(i)}>×</button>
          </div>
        ))}
        <button className="btn-secondary" style={{ marginTop: 8, width: 'auto', padding: '5px 14px', fontSize: 12 }} onClick={addRow}>
          + Add extras group
        </button>
      </div>
    </div>
  )
}

function DeptNotesTab({ d, set }) {
  const si = d.specialInstructions || {}
  return (
    <div className="cs-tab-panel">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {DEPT_NOTES_FIELDS.map(([key, label]) => (
          <div key={key} className="cs-dept-note">
            <label className="cs-label">{label}</label>
            <textarea
              className="cs-textarea"
              rows={3}
              value={si[key] || ''}
              onChange={e => set('specialInstructions', { ...si, [key]: e.target.value })}
              placeholder={`${label} instructions…`}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function Page2Tab({ d, set, departments }) {
  const overrides = d.crewCallOverrides || {}
  const setOverride = (key, val) => set('crewCallOverrides', { ...overrides, [key]: val })

  const DEPT_GROUPS = [
    ['direction', 'Direction'],
    ['production', 'Production'],
    ['script', 'Script'],
    ['camera', 'Camera'],
    ['grip__electric', 'Grip / Electric'],
    ['art_department', 'Art Department'],
    ['special_effects', 'Special Effects'],
    ['make_up', 'Make-up'],
    ['costume', 'Costume'],
    ['locations__transpo', 'Locations & Transpo'],
  ]

  return (
    <div className="cs-tab-panel">
      <div className="cs-section-label">Crew call time overrides</div>
      <p className="cs-hint">Default call for all departments is the Crew Call ({d.crewCall || '?'}). Override per department here.</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
        {DEPT_GROUPS.map(([key, label]) => (
          <div key={key} className="cs-field">
            <label className="cs-label">{label}</label>
            <input type="time" className="cs-input" value={overrides[key] || ''} onChange={e => setOverride(key, e.target.value)} placeholder={d.crewCall || '10:00'} />
          </div>
        ))}
      </div>

      <div className="cs-section-label">Emergency contacts</div>
      <div className="cs-row">
        <Field label="Emergency"><TextInput value={d.emergencyPhone} onChange={v => set('emergencyPhone', v)} /></Field>
        <Field label="Police"><TextInput value={d.policePhone} onChange={v => set('policePhone', v)} /></Field>
        <Field label="Fire"><TextInput value={d.firePhone} onChange={v => set('firePhone', v)} /></Field>
      </div>
      <Field label="Nearest hospital address">
        <TextInput value={d.hospitalAddress} onChange={v => set('hospitalAddress', v)} />
      </Field>

      <div className="cs-section-label" style={{ marginTop: 16 }}>Radio channels</div>
      <textarea className="cs-textarea" rows={5} value={d.radioChannels || ''} onChange={e => set('radioChannels', e.target.value)} />

      <div className="cs-section-label" style={{ marginTop: 16 }}>Reminders</div>
      <textarea className="cs-textarea" rows={6} value={d.reminders || ''} onChange={e => set('reminders', e.target.value)} />

      <div className="cs-section-label" style={{ marginTop: 16 }}>Quote of the day</div>
      <TextInput value={d.quote} onChange={v => set('quote', v)} placeholder='"[Quote]"' />
    </div>
  )
}

function AdvanceTab({ d, set, allScenes, eventSceneIds }) {
  const selected = new Set(d.advanceSceneIds || [])
  const toggle = (id) => {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    set('advanceSceneIds', [...next])
  }
  const available = allScenes.filter(s => !eventSceneIds.includes(s.id))

  return (
    <div className="cs-tab-panel">
      <p className="cs-hint">Select scenes to include in tomorrow's advance schedule. Current shoot day scenes are excluded.</p>
      <div className="cs-scene-list">
        {available.length === 0 && <p className="cs-hint">No other scenes in the breakdown.</p>}
        {available.map(s => (
          <label key={s.id} className="cs-scene-row">
            <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
            <span><strong>{s.sceneNumber}</strong> — {s.intExt}. {s.location} ({s.timeOfDay}) — {s.pages}pp</span>
          </label>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CallSheetEditor() {
  const { id, eventId } = useParams()
  const { currentProject } = useProject()
  const { settings } = useSettings()

  const [tab, setTab] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const [event, setEvent]           = useState(null)
  const [crew, setCrew]             = useState([])
  const [allScenes, setAllScenes]   = useState([])
  const [departments, setDepts]     = useState([])
  const [data, setData]             = useState(null)

  useEffect(() => {
    fetch(`/api/projects/${id}/call-sheets/${eventId}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(res => {
        setEvent(res.event)
        setCrew(res.crew || [])
        setAllScenes(res.scenes || [])
        setDepts(res.departments || [])
        if (res.callSheet?.data) {
          setData(typeof res.callSheet.data === 'string'
            ? JSON.parse(res.callSheet.data)
            : res.callSheet.data)
        } else {
          setData(buildDefaultData(res.event, res.crew || []))
        }
      })
      .catch(() => setError('Failed to load call sheet data.'))
      .finally(() => setLoading(false))
  }, [id, eventId])

  const set = useCallback((field, val) => {
    setData(prev => ({ ...prev, [field]: val }))
    setSaved(false)
  }, [])

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/projects/${id}/call-sheets/${eventId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ data }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      setSaved(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="page-header"><p>Loading call sheet…</p></div>
  if (error && !data) return <div className="page-header"><p className="auth-error">{error}</p></div>

  const eventSceneIds = event?.sceneIds ?? []
  const projectTitle = currentProject?.title || 'Production'
  const orgName = settings?.org_name || ''

  const tabContent = [
    <TimesTab     key="times"   d={data} set={set} />,
    <InfoTab      key="info"    d={data} set={set} />,
    <CastTab      key="cast"    d={data} set={set} />,
    <ExtrasTab    key="extras"  d={data} set={set} />,
    <DeptNotesTab key="dept"    d={data} set={set} />,
    <Page2Tab     key="page2"   d={data} set={set} departments={departments} />,
    <AdvanceTab   key="advance" d={data} set={set} allScenes={allScenes} eventSceneIds={eventSceneIds} />,
  ]

  const fileName = `call-sheet-day-${data.dayNumber || 1}-${event?.date || 'date'}.pdf`

  return (
    <div>
      {/* Header */}
      <div className="cs-header">
        <Link to={`/projects/${id}/calendar`} className="cs-back">← Calendar</Link>
        <div className="cs-header-center">
          <h1 className="cs-title">Call Sheet — Day {data.dayNumber ?? '?'}</h1>
          <p className="cs-sub">{projectTitle} · {event?.date || ''}</p>
        </div>
        <div className="cs-header-actions">
          {error && <span className="auth-error" style={{ fontSize: 12, marginRight: 8 }}>{error}</span>}
          {saved && <span style={{ fontSize: 12, color: '#22c55e', marginRight: 8 }}>Saved</span>}
          <button className="btn-secondary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <PDFErrorBoundary>
            <Suspense fallback={<button className="btn-primary" disabled>Loading PDF…</button>}>
              <PDFButton
                data={data}
                event={{ ...event, sceneIds: eventSceneIds }}
                crew={crew}
                allScenes={allScenes}
                projectTitle={projectTitle}
                orgName={orgName}
                fileName={fileName}
              />
            </Suspense>
          </PDFErrorBoundary>
        </div>
      </div>

      {/* Tabs */}
      <div className="cs-tabs">
        {TABS.map((t, i) => (
          <button
            key={t}
            className={`cs-tab${tab === i ? ' active' : ''}`}
            onClick={() => { save(); setTab(i) }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      {tabContent[tab]}
    </div>
  )
}
