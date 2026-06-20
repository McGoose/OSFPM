import { useState, useEffect, useRef } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { parseFountain, extractCharacters } from '../../utils/fountain'
import { INT_EXT_OPTIONS, TIME_OPTIONS } from './constants'
import BreakdownSheet from './BreakdownSheet'

function api(path, opts) {
  return fetch(path, { credentials: 'include', ...opts })
}

function defaultNew() {
  return { sceneNumber: '', intExt: 'INT', location: '', timeOfDay: 'DAY', description: '', pages: '1' }
}

export default function Breakdown() {
  const { id } = useParams()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const fileInputRef = useRef(null)

  const [scenes, setScenes] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Manual add-scene form
  const [adding, setAdding] = useState(false)
  const [newScene, setNewScene] = useState(defaultNew())
  const [addError, setAddError] = useState('')

  // Fountain import
  const [importPreview, setImportPreview] = useState(null) // { filename, rawContent, scenes, charsByScene }
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')

  // ── Load ─────────────────────────────────────────────────────────────────────

  const load = async () => {
    const res = await api(`/api/projects/${id}/breakdown`)
    if (!res.ok) { setError('Failed to load breakdown'); setLoading(false); return }
    const data = await res.json()
    setScenes(data)
    if (data.length > 0) setSelectedId(prev => prev ?? data[0].id)
    setLoading(false)
  }

  useEffect(() => { load() }, [id])

  const selectedScene = scenes.find(s => s.id === selectedId) ?? null

  // ── Scene CRUD ────────────────────────────────────────────────────────────────

  const addScene = async (e) => {
    e.preventDefault()
    setAddError('')
    if (!newScene.sceneNumber.trim()) { setAddError('Scene number is required'); return }
    const res = await api(`/api/projects/${id}/breakdown/scenes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newScene, pages: parseFloat(newScene.pages) || 1 }),
    })
    const data = await res.json()
    if (!res.ok) { setAddError(data.error); return }
    setScenes(prev => [...prev, data])
    setSelectedId(data.id)
    setNewScene(defaultNew())
    setAdding(false)
  }

  const patchScene = async (sceneId, updates) => {
    const res = await api(`/api/projects/${id}/breakdown/scenes/${sceneId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!res.ok) return
    const updated = await res.json()
    setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, ...updated } : s))
  }

  const deleteScene = async (sceneId) => {
    const scene = scenes.find(s => s.id === sceneId)
    if (!confirm(`Delete scene ${scene?.sceneNumber}? This removes all its breakdown elements.`)) return
    await api(`/api/projects/${id}/breakdown/scenes/${sceneId}`, { method: 'DELETE' })
    const remaining = scenes.filter(s => s.id !== sceneId)
    setScenes(remaining)
    if (selectedId === sceneId) setSelectedId(remaining[0]?.id ?? null)
  }

  // ── Element CRUD ──────────────────────────────────────────────────────────────

  const addElement = async (sceneId, categoryId, description) => {
    if (!description?.trim()) return
    const res = await api(`/api/projects/${id}/breakdown/elements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneId, category: categoryId, description }),
    })
    const data = await res.json()
    if (!res.ok) return
    setScenes(prev => prev.map(s =>
      s.id === sceneId ? { ...s, elements: [...(s.elements ?? []), data] } : s
    ))
  }

  const deleteElement = async (sceneId, elementId) => {
    await api(`/api/projects/${id}/breakdown/elements/${elementId}`, { method: 'DELETE' })
    setScenes(prev => prev.map(s =>
      s.id === sceneId ? { ...s, elements: s.elements.filter(e => e.id !== elementId) } : s
    ))
  }

  const patchElement = async (sceneId, elementId, description) => {
    if (!description.trim()) return
    const res = await api(`/api/projects/${id}/breakdown/elements/${elementId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    })
    if (!res.ok) return
    const updated = await res.json()
    setScenes(prev => prev.map(s =>
      s.id === sceneId ? { ...s, elements: s.elements.map(e => e.id === elementId ? updated : e) } : s
    ))
  }

  // ── Fountain import ───────────────────────────────────────────────────────────

  const handleFileChange = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const raw = ev.target.result
      const parsed = parseFountain(raw)
      const charsByScene = parsed.map(s => extractCharacters(s.content))
      setImportPreview({ filename: file.name, rawContent: raw, scenes: parsed, charsByScene })
      setImportError('')
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const doImport = async (replaceExisting) => {
    if (!importPreview) return
    setImporting(true)
    setImportError('')

    // Build auto-elements from detected characters
    const autoElements = []
    importPreview.charsByScene.forEach((chars, sceneIndex) => {
      chars.forEach(name => autoElements.push({ sceneIndex, category: 'cast', description: name }))
    })

    const res = await api(`/api/projects/${id}/breakdown/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: importPreview.filename,
        rawContent: importPreview.rawContent,
        scenes: importPreview.scenes,
        autoElements,
        replaceExisting,
      }),
    })
    const data = await res.json()
    setImporting(false)

    if (!res.ok) { setImportError(data.error ?? 'Import failed'); return }
    setScenes(data)
    setSelectedId(data[0]?.id ?? null)
    setImportPreview(null)
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading) return <div className="empty-state"><p>Loading…</p></div>
  if (error) return <div className="empty-state"><p>{error}</p></div>

  const totalPageEighths = scenes.reduce((sum, s) => sum + Math.round((s.pages || 1) * 8), 0)
  const totalPagesDisplay = (() => {
    const whole = Math.floor(totalPageEighths / 8)
    const rem = totalPageEighths % 8
    if (rem === 0) return String(whole)
    if (whole === 0) return `${rem}/8`
    return `${whole} ${rem}/8`
  })()

  return (
    <>
      <div className="page-header">
        <Link to={`/projects/${id}`} className="back-link">← Overview</Link>
        <div className="page-header-row" style={{ marginTop: 8 }}>
          <div>
            <h1>Script Breakdown</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
              {scenes.length} scene{scenes.length !== 1 ? 's' : ''}
              {scenes.length > 0 && ` · ${totalPagesDisplay} pages`}
            </p>
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn-secondary"
                style={{ width: 'auto', padding: '8px 14px' }}
                onClick={() => fileInputRef.current?.click()}
              >
                Import .fountain
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".fountain,.txt"
                style={{ display: 'none' }}
                onChange={handleFileChange}
              />
              <button
                className="btn-primary"
                style={{ width: 'auto', padding: '8px 16px' }}
                onClick={() => { setAdding(v => !v); setAddError('') }}
              >
                {adding ? 'Cancel' : '+ Add scene'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Import preview panel */}
      {importPreview && (
        <div className="import-panel">
          <div className="import-panel-header">
            <div>
              <span className="import-panel-filename">📄 {importPreview.filename}</span>
              <span className="import-panel-count">{importPreview.scenes.length} scenes found</span>
              <span className="import-panel-count">
                {importPreview.charsByScene.flat().length} character mention{importPreview.charsByScene.flat().length !== 1 ? 's' : ''} auto-detected
              </span>
            </div>
            <button className="btn-secondary" style={{ width: 'auto', padding: '6px 12px', fontSize: 12 }} onClick={() => setImportPreview(null)}>
              Discard
            </button>
          </div>
          {importError && <p className="auth-error" style={{ margin: '8px 0 0' }}>{importError}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button
              className="btn-primary"
              style={{ width: 'auto', padding: '8px 16px' }}
              onClick={() => doImport(true)}
              disabled={importing}
            >
              {importing ? 'Importing…' : scenes.length > 0 ? 'Replace all scenes' : 'Import scenes'}
            </button>
            {scenes.length > 0 && (
              <button
                className="btn-secondary"
                style={{ width: 'auto', padding: '8px 14px' }}
                onClick={() => doImport(false)}
                disabled={importing}
              >
                Append to existing
              </button>
            )}
          </div>
          {scenes.length > 0 && (
            <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              "Replace all scenes" will delete the current {scenes.length} scene{scenes.length !== 1 ? 's' : ''} and all their elements.
            </p>
          )}
        </div>
      )}

      {/* Manual add-scene form */}
      {adding && !importPreview && isAdmin && (
        <form onSubmit={addScene} className="breakdown-add-form">
          <div className="breakdown-add-row">
            <div className="field" style={{ width: 80, marginBottom: 0 }}>
              <label>Scene #</label>
              <input
                value={newScene.sceneNumber}
                onChange={e => setNewScene(p => ({ ...p, sceneNumber: e.target.value }))}
                placeholder="1"
                autoFocus
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>INT/EXT</label>
              <select value={newScene.intExt} onChange={e => setNewScene(p => ({ ...p, intExt: e.target.value }))}>
                {INT_EXT_OPTIONS.map(o => <option key={o}>{o}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1, marginBottom: 0 }}>
              <label>Location</label>
              <input
                value={newScene.location}
                onChange={e => setNewScene(p => ({ ...p, location: e.target.value }))}
                placeholder="e.g. OFFICE"
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Time</label>
              <select value={newScene.timeOfDay} onChange={e => setNewScene(p => ({ ...p, timeOfDay: e.target.value }))}>
                {TIME_OPTIONS.map(o => <option key={o}>{o}</option>)}
              </select>
            </div>
            <div className="field" style={{ width: 64, marginBottom: 0 }}>
              <label>Pages</label>
              <input
                value={newScene.pages}
                onChange={e => setNewScene(p => ({ ...p, pages: e.target.value }))}
                placeholder="1"
              />
            </div>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Synopsis</label>
            <input
              value={newScene.description}
              onChange={e => setNewScene(p => ({ ...p, description: e.target.value }))}
              placeholder="One-line synopsis (optional)"
            />
          </div>
          {addError && <p className="auth-error" style={{ marginTop: 8 }}>{addError}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="submit" className="btn-primary" style={{ width: 'auto', padding: '8px 16px' }}>Add scene</button>
            <button type="button" className="btn-secondary" style={{ width: 'auto', padding: '8px 14px' }} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}

      {scenes.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 40 }}>
          <div className="empty-state-icon">📋</div>
          <p>
            {isAdmin
              ? 'Import a .fountain script to auto-populate scenes, or add scenes manually.'
              : 'No scenes yet.'}
          </p>
        </div>
      ) : (
        <div className="breakdown-layout">
          {/* Scene list */}
          <div className="breakdown-scenes">
            {scenes.map(scene => {
              const elemCount = scene.elements?.length ?? 0
              const eighths = Math.round((scene.pages || 1) * 8)
              const pagesStr = eighths % 8 === 0
                ? `${eighths / 8}p`
                : eighths < 8
                  ? `${eighths}/8p`
                  : `${Math.floor(eighths / 8)} ${eighths % 8}/8p`

              return (
                <div
                  key={scene.id}
                  className={`scene-row${scene.id === selectedId ? ' scene-row--active' : ''}`}
                  onClick={() => setSelectedId(scene.id)}
                >
                  <div className="scene-row-num">{scene.sceneNumber}</div>
                  <div className="scene-row-info">
                    <div className="scene-row-slug">
                      <span className="scene-badge">{scene.intExt}</span>
                      <span className="scene-badge">{scene.timeOfDay}</span>
                      <span className="scene-location">{scene.location || '—'}</span>
                    </div>
                    {scene.description && (
                      <div className="scene-row-desc">{scene.description}</div>
                    )}
                  </div>
                  <div className="scene-row-meta">
                    <span className="scene-pages">{pagesStr}</span>
                    {elemCount > 0 && <span className="scene-elem-count">{elemCount}</span>}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Breakdown sheet */}
          <div className="breakdown-sheet">
            {selectedScene ? (
              <BreakdownSheet
                key={selectedScene.id}
                scene={selectedScene}
                isAdmin={isAdmin}
                onPatchScene={patchScene}
                onDeleteScene={deleteScene}
                onAddElement={addElement}
                onDeleteElement={deleteElement}
                onPatchElement={patchElement}
              />
            ) : (
              <div className="empty-state"><p>Select a scene.</p></div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
