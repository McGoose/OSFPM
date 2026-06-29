import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

function findCrew(crew, keywords) {
  if (!Array.isArray(crew)) return ''
  for (const kw of keywords) {
    const found = crew.find(c => c.role?.toLowerCase().includes(kw.toLowerCase()))
    if (found) return found.name
  }
  return ''
}

function parseCameraSlates(takes) {
  const slates = new Set()
  for (const t of takes) {
    if (t.rowType === 'take' && !t.isFalseTake && t.scene) slates.add(String(t.scene).trim())
  }
  return [...slates].join(', ')
}

function parseCameraCards(takes) {
  const cards = new Set([1])
  for (const t of takes) {
    if (t.rowType === 'roll_change') cards.add(t.roll)
  }
  return [...cards].sort((a, b) => a - b).map(n => `Card ${n}`).join(', ')
}

function parseSoundCards(soundRows) {
  const cards = new Set()
  for (const row of soundRows) {
    const filename = row['FILE NAME'] ?? row['File Name'] ?? ''
    if (filename) {
      // Take the part before the last underscore as the card identifier, fallback to full filename
      const parts = filename.split('_')
      const card = parts.length > 1 ? parts.slice(0, -1).join('_') : filename
      cards.add(card)
    }
  }
  return [...cards].join(', ')
}

function buildInitialData(event, crew, scenes, callSheet, cameraReport, soundReport, pettyCash) {
  const csData = callSheet?.data ? (typeof callSheet.data === 'string' ? JSON.parse(callSheet.data) : callSheet.data) : {}
  const camTakes = cameraReport?.takes ? (typeof cameraReport.takes === 'string' ? JSON.parse(cameraReport.takes) : cameraReport.takes) : []
  const sndRows = soundReport?.csvData ? (typeof soundReport.csvData === 'string' ? JSON.parse(soundReport.csvData) : soundReport.csvData) : []

  const eventScenes = (event.sceneIds ?? []).map(id => scenes.find(s => s.id === id)).filter(Boolean)
  const scheduledScenes = eventScenes.map(s => s.sceneNumber).join(', ')

  const castRows = (csData.castRows ?? []).map(r => ({
    name: r.name ?? '',
    callTime: r.pickupTime || csData.crewCall || '',
    arrival: '',
    onSet: '',
    wrap: '',
  }))

  return {
    title: '',
    date: event.date ?? '',
    productionOffice: csData.productionOffice ?? '',
    producer: findCrew(crew, ['producer']),
    director: findCrew(crew, ['director']),
    firstAD: findCrew(crew, ['1st ad', 'first ad', '1st assistant director']),
    dop: findCrew(crew, ['dop', 'dp', 'director of photography', 'cinematographer']),
    soundRecordist: findCrew(crew, ['sound recordist', 'production sound', 'sound mixer', 'sound']),
    locations: event.location ?? '',
    crewCall: csData.crewCall ?? '',
    firstSlate: '',
    lunch: csData.meal1 ?? '',
    cameraWrap: '',
    crewWrap: csData.wrap ?? '',
    lastPerson: '',
    slatesShot: parseCameraSlates(camTakes),
    cameraCards: parseCameraCards(camTakes),
    soundCards: parseSoundCards(sndRows),
    previouslyShot: '',
    todayShot: '',
    scenesScheduled: scheduledScenes,
    scenesCompleted: '',
    scenesPartCompleted: '',
    scenesCarriedForward: '',
    talent: castRows,
    pettyCash,
    incidents: '',
    remarks: '',
  }
}

export default function ProgressReport({ projectId, eventId, event, crew, scenes, callSheet, cameraReport, soundReport, progressReport, pettyCash, onSaved }) {
  const navigate = useNavigate()

  const [data, setData] = useState(() => {
    if (progressReport?.data) {
      try { return JSON.parse(progressReport.data) } catch {}
    }
    return buildInitialData(event, crew, scenes, callSheet, cameraReport, soundReport, pettyCash)
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  function set(field, val) {
    setData(d => ({ ...d, [field]: val }))
    setSaved(false)
  }

  function setTalentRow(i, field, val) {
    setData(d => {
      const talent = [...(d.talent ?? [])]
      talent[i] = { ...talent[i], [field]: val }
      return { ...d, talent }
    })
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/reports/${eventId}/progress`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      setSaved(true)
      onSaved?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const Field = ({ label, field, type = 'text', rows }) => (
    <div className="prg-field-row">
      <label>{label}</label>
      {rows ? (
        <textarea rows={rows} value={data[field] ?? ''} onChange={e => set(field, e.target.value)} />
      ) : (
        <input type={type} value={data[field] ?? ''} onChange={e => set(field, e.target.value)} />
      )}
    </div>
  )

  return (
    <div className="prg-wrap">
      {/* Production Info */}
      <div className="prg-section">
        <div className="prg-section-label">Production Info</div>
        <Field label="Title" field="title" />
        <Field label="Date" field="date" type="date" />
        <Field label="Production Office" field="productionOffice" />
        <Field label="Producer" field="producer" />
        <Field label="Director" field="director" />
        <Field label="1st AD" field="firstAD" />
        <Field label="DOP" field="dop" />
        <Field label="Sound Recordist" field="soundRecordist" />
      </div>

      {/* Locations */}
      <div className="prg-section">
        <div className="prg-section-label">Locations</div>
        <div className="prg-field-row">
          <label>Today's locations</label>
          <textarea rows={3} value={data.locations ?? ''} onChange={e => set('locations', e.target.value)} />
        </div>
      </div>

      {/* Timings */}
      <div className="prg-section">
        <div className="prg-section-label">Today's Timings</div>
        <div className="prg-timings-grid">
          {[
            ['Crew Call', 'crewCall'],
            ['Turnover / First Slate', 'firstSlate'],
            ['Lunch', 'lunch'],
            ['Camera Wrap', 'cameraWrap'],
            ['Crew Wrap', 'crewWrap'],
            ['Last Person', 'lastPerson'],
          ].map(([label, field]) => (
            <div key={field}>
              <label>{label}</label>
              <input type="time" value={data[field] ?? ''} onChange={e => set(field, e.target.value)} />
            </div>
          ))}
        </div>
      </div>

      {/* Media */}
      <div className="prg-section">
        <div className="prg-section-label">Media</div>
        <Field label="Slates shot today" field="slatesShot" />
        <Field label="Camera cards/mags" field="cameraCards" />
        <Field label="Sound cards" field="soundCards" />
        <div className="prg-field-row">
          <label>Previously shot (GB)</label>
          <input type="number" min="0" step="0.01" value={data.previouslyShot ?? ''} onChange={e => set('previouslyShot', e.target.value)} />
        </div>
        <div className="prg-field-row">
          <label>To date shot (GB)</label>
          <input type="number" min="0" step="0.01" value={data.todayShot ?? ''} onChange={e => set('todayShot', e.target.value)} />
        </div>
      </div>

      {/* Scenes */}
      <div className="prg-section">
        <div className="prg-section-label">Scenes</div>
        <Field label="Scheduled today" field="scenesScheduled" />
        <Field label="Completed today" field="scenesCompleted" rows={2} />
        <Field label="Part-completed" field="scenesPartCompleted" rows={2} />
        <Field label="Carried forward" field="scenesCarriedForward" rows={2} />
      </div>

      {/* Talent */}
      <div className="prg-section">
        <div className="prg-section-label">Talent</div>
        <div className="prg-talent-wrap">
          <table className="prg-talent-table">
            <thead>
              <tr>
                <th>Artist Name</th>
                <th>Call Time</th>
                <th>Arrival</th>
                <th>On Set</th>
                <th>Wrap</th>
              </tr>
            </thead>
            <tbody>
              {(data.talent ?? []).map((row, i) => (
                <tr key={i}>
                  <td><input value={row.name ?? ''} onChange={e => setTalentRow(i, 'name', e.target.value)} /></td>
                  <td><input type="time" value={row.callTime ?? ''} onChange={e => setTalentRow(i, 'callTime', e.target.value)} /></td>
                  <td><input type="time" value={row.arrival ?? ''} onChange={e => setTalentRow(i, 'arrival', e.target.value)} /></td>
                  <td><input type="time" value={row.onSet ?? ''} onChange={e => setTalentRow(i, 'onSet', e.target.value)} /></td>
                  <td><input type="time" value={row.wrap ?? ''} onChange={e => setTalentRow(i, 'wrap', e.target.value)} /></td>
                </tr>
              ))}
              {(data.talent ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '12px', fontStyle: 'italic' }}>
                    No cast rows — auto-populated from call sheet cast once a call sheet exists
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <button
          className="btn-secondary"
          style={{ marginTop: 8 }}
          onClick={() => setData(d => ({ ...d, talent: [...(d.talent ?? []), { name: '', callTime: '', arrival: '', onSet: '', wrap: '' }] }))}
        >
          + Add row
        </button>
      </div>

      {/* Petty Cash */}
      <div className="prg-section">
        <div className="prg-section-label">Petty Cash</div>
        <div className="prg-petty-cash">
          <span>Approved + Paid invoices in petty cash categories:</span>
          <strong>{pettyCash != null ? `£${Number(pettyCash).toFixed(2)}` : '—'}</strong>
          <button className="btn-secondary" style={{ fontSize: 12 }} onClick={() => navigate(`/projects/${projectId}/budget`)}>
            View in Money →
          </button>
        </div>
      </div>

      {/* Incidents */}
      <div className="prg-section">
        <div className="prg-section-label">Incidents</div>
        <div className="prg-field-row">
          <label>Description</label>
          <textarea rows={3} value={data.incidents ?? ''} onChange={e => set('incidents', e.target.value)} placeholder="None" />
        </div>
      </div>

      {/* Remarks */}
      <div className="prg-section">
        <div className="prg-section-label">Remarks</div>
        <div className="prg-field-row">
          <label>Today's remarks</label>
          <textarea rows={4} value={data.remarks ?? ''} onChange={e => set('remarks', e.target.value)} />
        </div>
      </div>

      <div className="prg-save-bar">
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="rpt-saved-msg">Saved</span>}
        {error && <span style={{ color: 'red', fontSize: 13 }}>{error}</span>}
      </div>
    </div>
  )
}
