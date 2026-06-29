import { useState } from 'react'

const CAMERA_TYPES = [
  'ARRI ALEXA 35', 'ARRI ALEXA Mini LF', 'ARRI ALEXA Mini',
  'RED V-RAPTOR', 'RED KOMODO-X', 'RED KOMODO',
  'Sony VENICE 2', 'Sony FX9', 'Sony FX6', 'Sony FX3',
  'Blackmagic URSA Mini Pro 12K', 'Blackmagic Pocket 6K Pro',
  'Canon EOS C70', 'Canon EOS R5 C',
  'DJI Ronin 4D', 'Other',
]

const RECORDING_FORMATS = [
  'ARRIRAW', 'ARRIRAW HDE',
  'ProRes 4444 XQ', 'ProRes 4444', 'ProRes 422 HQ', 'ProRes 422', 'ProRes 422 LT',
  'BRAW 12:1', 'BRAW 8:1', 'BRAW 5:1', 'BRAW 3:1',
  'R3D REDCODE RAW', 'CinemaDNG',
  'XAVC-I 4K', 'XAVC-S 4K',
  'H.265 4K', 'H.264 4K',
  'Other',
]

const FRAME_GUIDES = ['1.33:1', '1.78:1', '1.85:1', '2.39:1', 'Custom']

function defaultSetup(prev) {
  if (prev) {
    try { return JSON.parse(prev) } catch {}
  }
  return { cameraType: '', cameraTypeCustom: '', recordingFormat: '', recordingFormatCustom: '', frameGuides: '1.85:1', colorSpace: '' }
}

function parseTakes(raw) {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

function lastTakeOf(takes) {
  for (let i = takes.length - 1; i >= 0; i--) {
    if (takes[i].rowType === 'take') return takes[i]
  }
  return null
}

function currentRoll(takes) {
  let roll = 1
  for (const t of takes) {
    if (t.rowType === 'roll_change') roll = t.roll
  }
  return roll
}

function nextFile(takes) {
  const roll = currentRoll(takes)
  let file = 0
  for (const t of takes) {
    if (t.rowType === 'take' && t.roll === roll) file = Math.max(file, Number(t.file) || 0)
  }
  return file + 1
}

function SelectWithCustom({ options, value, customValue, onChange, onCustomChange, placeholder }) {
  const isOther = value === 'Other'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <select value={value} onChange={e => onChange(e.target.value)}>
        <option value="">— select —</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      {isOther && (
        <input
          value={customValue}
          onChange={e => onCustomChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
    </div>
  )
}

export default function CameraReport({ projectId, eventId, cameraReport, previousCameraSetup, onSaved }) {
  const [setup, setSetup] = useState(() => defaultSetup(cameraReport?.setup ?? previousCameraSetup))
  const [takes, setTakes] = useState(() => parseTakes(cameraReport?.takes))
  const [setupOpen, setSetupOpen] = useState(!cameraReport)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  function updateSetup(field, val) {
    setSetup(s => ({ ...s, [field]: val }))
    setSaved(false)
  }

  function updateTake(idx, field, val) {
    setTakes(ts => ts.map((t, i) => i === idx ? { ...t, [field]: val } : t))
    setSaved(false)
  }

  function addTake() {
    const last = lastTakeOf(takes)
    const roll = currentRoll(takes)
    const file = nextFile(takes)
    // If the last take was a false take, keep the same take number (re-shoot)
    const take = last
      ? last.isFalseTake ? (Number(last.take) || 1) : (Number(last.take) || 0) + 1
      : 1
    const scene = last?.scene ?? ''
    setTakes(ts => [...ts, { rowType: 'take', roll, file, scene, take, lens: '', iso: '', shutter: '', notes: '', isFalseTake: false }])
    setSaved(false)
  }

  function falseTake() {
    setTakes(ts => {
      const copy = [...ts]
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].rowType === 'take') {
          copy[i] = { ...copy[i], isFalseTake: true }
          break
        }
      }
      return copy
    })
    setSaved(false)
  }

  function rollChange() {
    const nextRoll = currentRoll(takes) + 1
    setTakes(ts => [...ts, { rowType: 'roll_change', roll: nextRoll }])
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/reports/${eventId}/camera`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setup, takes }),
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

  return (
    <div>
      {/* Setup panel */}
      <div className="cam-setup-panel">
        <button className="cam-setup-toggle" onClick={() => setSetupOpen(o => !o)}>
          <span>Camera Setup</span>
          <span>{setupOpen ? '▲' : '▼'}</span>
        </button>
        {setupOpen && (
          <div className="cam-setup-fields">
            <div>
              <label>Camera Type</label>
              <SelectWithCustom
                options={CAMERA_TYPES}
                value={setup.cameraType}
                customValue={setup.cameraTypeCustom ?? ''}
                onChange={v => { updateSetup('cameraType', v); if (v !== 'Other') updateSetup('cameraTypeCustom', '') }}
                onCustomChange={v => updateSetup('cameraTypeCustom', v)}
                placeholder="e.g. ARRI ALEXA 35"
              />
            </div>
            <div>
              <label>Recording Format</label>
              <SelectWithCustom
                options={RECORDING_FORMATS}
                value={setup.recordingFormat}
                customValue={setup.recordingFormatCustom ?? ''}
                onChange={v => { updateSetup('recordingFormat', v); if (v !== 'Other') updateSetup('recordingFormatCustom', '') }}
                onCustomChange={v => updateSetup('recordingFormatCustom', v)}
                placeholder="e.g. ProRes 4444 UHD"
              />
            </div>
            <div>
              <label>Frame Guides</label>
              <select value={setup.frameGuides} onChange={e => updateSetup('frameGuides', e.target.value)}>
                {FRAME_GUIDES.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label>Color Space</label>
              <input value={setup.colorSpace} onChange={e => updateSetup('colorSpace', e.target.value)} placeholder="e.g. ARRI LogC3 / AWG4" />
            </div>
          </div>
        )}
      </div>

      {/* Takes log */}
      <div className="cam-takes-wrap">
        <table className="cam-takes-table">
          <thead>
            <tr>
              <th>Card/Mag</th>
              <th>File</th>
              <th>Scene</th>
              <th>Take</th>
              <th>Lens</th>
              <th>ISO</th>
              <th>Shutter</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {takes.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px', fontStyle: 'italic' }}>
                  No takes yet — press + Add Take
                </td>
              </tr>
            )}
            {takes.map((row, i) => {
              if (row.rowType === 'roll_change') {
                return (
                  <tr key={i} className="cam-roll-divider">
                    <td colSpan={8}>── CARD/MAG CHANGE — Card {row.roll} ──</td>
                  </tr>
                )
              }
              return (
                <tr key={i} className={row.isFalseTake ? 'cam-false-take' : ''}>
                  <td><input value={row.roll} readOnly style={{ color: 'var(--text-muted)' }} /></td>
                  <td><input value={row.file} onChange={e => updateTake(i, 'file', e.target.value)} /></td>
                  <td><input value={row.scene} onChange={e => updateTake(i, 'scene', e.target.value)} /></td>
                  <td><input value={row.isFalseTake ? 'FT' : row.take} onChange={e => updateTake(i, 'take', e.target.value)} readOnly={row.isFalseTake} /></td>
                  <td><input value={row.lens} onChange={e => updateTake(i, 'lens', e.target.value)} /></td>
                  <td><input value={row.iso} onChange={e => updateTake(i, 'iso', e.target.value)} style={{ maxWidth: 64 }} /></td>
                  <td><input value={row.shutter} onChange={e => updateTake(i, 'shutter', e.target.value)} style={{ maxWidth: 80 }} /></td>
                  <td><input value={row.notes} onChange={e => updateTake(i, 'notes', e.target.value)} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Action bar */}
      <div className="cam-action-bar">
        <button className="btn-primary" onClick={addTake}>+ Add Take</button>
        <button className="btn-secondary" onClick={falseTake} disabled={takes.filter(t => t.rowType === 'take').length === 0}>
          False Take
        </button>
        <button className="btn-secondary" onClick={rollChange}>Card / Mag Change</button>
        <div style={{ flex: 1 }} />
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="rpt-saved-msg">Saved</span>}
        {error && <span style={{ color: 'red', fontSize: 13 }}>{error}</span>}
      </div>
    </div>
  )
}
