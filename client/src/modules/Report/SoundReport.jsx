import { useState, useRef } from 'react'
import { parseMixPre } from '../../utils/parseMixPre'

export default function SoundReport({ projectId, eventId, soundReport, onSaved }) {
  const fileRef = useRef()
  const [headers, setHeaders] = useState(() => {
    if (soundReport?.csvData) {
      try {
        const rows = JSON.parse(soundReport.csvData)
        return rows.length > 0 ? Object.keys(rows[0]) : []
      } catch { return [] }
    }
    return []
  })
  const [rows, setRows] = useState(() => {
    if (soundReport?.csvData) {
      try { return JSON.parse(soundReport.csvData) } catch { return [] }
    }
    return []
  })
  const [dragOver, setDragOver] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  function loadFile(file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const { headers: h, rows: r } = parseMixPre(e.target.result)
      setHeaders(h)
      setRows(r)
      setSaved(false)
    }
    reader.readAsText(file)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/reports/${eventId}/sound`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csvData: rows }),
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

  const PRIORITY_COLS = ['SCENE', 'TAKE', 'CIRCLED', 'FALSE START', 'FILE NAME', 'DURATION', 'NOTES']
  const displayHeaders = headers.length > 0
    ? [...PRIORITY_COLS.filter(c => headers.includes(c)), ...headers.filter(c => !PRIORITY_COLS.includes(c))]
    : []

  return (
    <div>
      <div
        className={`snd-drop-zone${dragOver ? ' drag-over' : ''}`}
        onClick={() => fileRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); loadFile(e.dataTransfer.files[0]) }}
      >
        <input ref={fileRef} type="file" accept=".csv,.txt" onChange={e => loadFile(e.target.files[0])} />
        {rows.length > 0
          ? `${rows.length} row${rows.length !== 1 ? 's' : ''} loaded — click to replace`
          : 'Drop a Sound Devices MixPre CSV here, or click to browse'}
      </div>

      {rows.length > 0 && (
        <>
          <div className="snd-table-wrap">
            <table className="snd-table">
              <thead>
                <tr>
                  {displayHeaders.map(h => <th key={h}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {displayHeaders.map(h => <td key={h}>{row[h] ?? ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="rpt-saved-msg">Saved</span>}
            {error && <span style={{ color: 'red', fontSize: 13 }}>{error}</span>}
          </div>
        </>
      )}
    </div>
  )
}
