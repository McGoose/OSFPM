import { useState, useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
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

  const [scenes, setScenes] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [scriptInfo, setScriptInfo] = useState(null)
  // scriptInfo: { current: script | null, hasNewer: boolean, latestId: number | null }

  // Manual add-scene form
  const [adding, setAdding] = useState(false)
  const [newScene, setNewScene] = useState(defaultNew())
  const [addError, setAddError] = useState('')

  // ── Load ─────────────────────────────────────────────────────────────────────

  const load = async () => {
    const [breakdownRes, scriptsRes] = await Promise.all([
      api(`/api/projects/${id}/breakdown`),
      api(`/api/projects/${id}/scripts`),
    ])
    if (!breakdownRes.ok) { setError('Failed to load breakdown'); setLoading(false); return }
    const data = await breakdownRes.json()
    setScenes(data)
    if (data.length > 0) setSelectedId(prev => prev ?? data[0].id)

    if (scriptsRes.ok) {
      const allScripts = await scriptsRes.json()
      const shootingScripts = allScripts
        .filter(s => s.type === 'shooting_script')
        .sort((a, b) => b.versionNumber - a.versionNumber)
      const latest = shootingScripts[0] ?? null
      const currentVersionId = data[0]?.scriptVersionId ?? null
      const current = currentVersionId
        ? allScripts.find(s => s.id === currentVersionId) ?? null
        : null
      const hasNewer = latest && currentVersionId !== latest.id
      setScriptInfo({ current, hasNewer: !!hasNewer, latestId: latest?.id ?? null })
    }

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
            <button
              className="btn-primary"
              style={{ width: 'auto', padding: '8px 16px' }}
              onClick={() => { setAdding(v => !v); setAddError('') }}
            >
              {adding ? 'Cancel' : '+ Add scene'}
            </button>
          )}
        </div>
      </div>

      {/* Script source banner */}
      {scriptInfo && (scriptInfo.current || scriptInfo.hasNewer) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '8px 12px', borderRadius: 6, marginBottom: 8,
          background: scriptInfo.hasNewer ? 'var(--warning-bg, #FFFBEB)' : 'var(--surface-2)',
          border: `1px solid ${scriptInfo.hasNewer ? 'var(--warning-border, #F6E05E)' : 'var(--border)'}`,
          fontSize: 13,
        }}>
          {scriptInfo.current ? (
            <span style={{ color: 'var(--text-secondary)' }}>
              Based on: <strong>{scriptInfo.current.title || scriptInfo.current.filename}</strong>
            </span>
          ) : null}
          {scriptInfo.hasNewer && (
            <span style={{ color: 'var(--text-secondary)' }}>
              {scriptInfo.current ? ' · ' : ''}
              New shooting script available.
            </span>
          )}
          <Link
            to={`/projects/${id}/script`}
            style={{ color: 'var(--accent)', fontSize: 13, marginLeft: 4 }}
          >
            {scriptInfo.hasNewer ? 'Go to Script tool to update →' : 'Script tool →'}
          </Link>
        </div>
      )}

      {/* Manual add-scene form */}
      {adding && isAdmin && (
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
              ? <>Send a shooting script from the <Link to={`/projects/${id}/script`} style={{ color: 'var(--accent)' }}>Script tool</Link> to populate scenes automatically, or add scenes manually.</>
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
