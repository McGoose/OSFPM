import { useState, useEffect, useRef } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { parseScript } from '../../utils/scriptParsers'

function api(path, opts) {
  return fetch(path, { credentials: 'include', ...opts })
}

// ── DGA Color System ──────────────────────────────────────────────────────────
// Standard WGA/DGA script revision color order used in US film/TV production.

const DGA_COLORS = {
  white:     { label: 'White',     bg: '#FFFFFF', border: '#CBD5E0', text: '#2D3748' },
  blue:      { label: 'Blue',      bg: '#BEE3F8', border: '#4299E1', text: '#2A4365' },
  pink:      { label: 'Pink',      bg: '#FED7E2', border: '#ED64A6', text: '#702459' },
  yellow:    { label: 'Yellow',    bg: '#FEFCBF', border: '#D69E2E', text: '#744210' },
  green:     { label: 'Green',     bg: '#C6F6D5', border: '#48BB78', text: '#22543D' },
  goldenrod: { label: 'Goldenrod', bg: '#FEEBC8', border: '#DD6B20', text: '#7B341E' },
  buff:      { label: 'Buff',      bg: '#F5F0E8', border: '#B7791F', text: '#5C4A28' },
  salmon:    { label: 'Salmon',    bg: '#FED7C0', border: '#F56565', text: '#7B341E' },
  cherry:    { label: 'Cherry',    bg: '#FEB2C6', border: '#E53E6E', text: '#6B2D4A' },
  tan:       { label: 'Tan',       bg: '#EDD9C0', border: '#C8A070', text: '#5C4028' },
  ivory:     { label: 'Ivory',     bg: '#FFFFF0', border: '#D4D0A0', text: '#5C5628' },
}

function ColorChip({ revision, size = 'sm' }) {
  const color = DGA_COLORS[revision] ?? DGA_COLORS.white
  const isSmall = size === 'sm'
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center',
        padding: isSmall ? '2px 8px' : '4px 12px',
        borderRadius: 4,
        fontSize: isSmall ? 11 : 13,
        fontWeight: 600,
        letterSpacing: '0.02em',
        background: color.bg,
        border: `1.5px solid ${color.border}`,
        color: color.text,
        whiteSpace: 'nowrap',
      }}
    >
      {color.label}
    </span>
  )
}

const TYPE_LABELS = {
  scriptment: 'Scriptment',
  draft: 'Draft',
  shooting_script: 'Shooting Script',
}

const FORMAT_LABELS = {
  fountain: '.fountain',
  fdx: '.fdx',
  fadein: '.fadein',
  xml: '.xml',
}

function versionLabel(script) {
  if (script.type === 'shooting_script') {
    const color = DGA_COLORS[script.colorRevision]
    return color ? `${color.label} Draft` : script.colorRevision
  }
  return `v${script.versionNumber}`
}

function formatDate(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Scene diff ────────────────────────────────────────────────────────────────

function getNextColor(versions, uploadType) {
  if (uploadType !== 'shooting_script') return 'white'
  const shootingScripts = versions.filter(v => v.type === 'shooting_script')
  const count = shootingScripts.length
  const DGA_ORDER = ['white', 'blue', 'pink', 'yellow', 'green', 'goldenrod', 'buff', 'salmon', 'cherry', 'tan', 'ivory']
  return DGA_ORDER[count % DGA_ORDER.length] ?? 'white'
}

function computeDiff(currentScenes, newScenes) {
  const currentByNum = new Map(currentScenes.map(s => [s.sceneNumber, s]))
  const newByNum = new Map(newScenes.map(s => [String(s.sceneNumber), s]))

  const added = newScenes.filter(s => !currentByNum.has(String(s.sceneNumber)))
  const removed = currentScenes.filter(s => !newByNum.has(s.sceneNumber))
  const modified = newScenes.filter(s => {
    const curr = currentByNum.get(String(s.sceneNumber))
    if (!curr) return false
    return curr.intExt !== s.intExt || curr.location !== s.location || curr.timeOfDay !== s.timeOfDay
  })
  const unchanged = newScenes.filter(s => {
    const curr = currentByNum.get(String(s.sceneNumber))
    if (!curr) return false
    return curr.intExt === s.intExt && curr.location === s.location && curr.timeOfDay === s.timeOfDay
  })

  return { added, removed, modified, unchanged }
}

function sceneSlug(s) {
  return `${s.sceneNumber}. ${s.intExt} ${s.location} — ${s.timeOfDay}`
}

// ── Component ─────────────────────────────────────────────────────────────────

const TABS = ['shooting_script', 'draft', 'scriptment']
const TAB_LABELS = { shooting_script: 'Shooting Scripts', draft: 'Drafts', scriptment: 'Scriptments' }

export default function Script() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const fileInputRef = useRef(null)

  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('shooting_script')

  // Upload form state
  const [showUpload, setShowUpload] = useState(false)
  const [uploadType, setUploadType] = useState('shooting_script')
  const [uploadNotes, setUploadNotes] = useState('')
  const [uploadParsed, setUploadParsed] = useState(null) // { filename, content, scenes, format, error }
  const [uploadSaving, setUploadSaving] = useState(false)
  const [uploadError, setUploadError] = useState('')

  // Send-to-breakdown diff state
  const [diffPanel, setDiffPanel] = useState(null)
  // { scriptId, scriptLabel, diff, newScenes, applying, applyError }

  // ── Load ────────────────────────────────────────────────────────────────────

  const load = async () => {
    const res = await api(`/api/projects/${id}/scripts`)
    if (!res.ok) { setError('Failed to load scripts'); setLoading(false); return }
    setVersions(await res.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [id])

  // ── File pick ───────────────────────────────────────────────────────────────

  const handleFilePick = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const content = await file.text()
      const { scenes, format } = parseScript(file.name, content)
      setUploadParsed({ filename: file.name, content, scenes, format, error: null })
    } catch (err) {
      setUploadParsed({ filename: file.name, content: '', scenes: [], format: 'unknown', error: err.message })
    }
    setUploadError('')
  }

  // ── Save version ────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!uploadParsed || uploadParsed.error) return
    setUploadSaving(true)
    setUploadError('')

    const res = await api(`/api/projects/${id}/scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: uploadType,
        filename: uploadParsed.filename,
        format: uploadParsed.format,
        rawContent: uploadParsed.content,
        scenesData: JSON.stringify(uploadParsed.scenes),
        notes: uploadNotes,
      }),
    })

    const data = await res.json()
    setUploadSaving(false)
    if (!res.ok) { setUploadError(data.error ?? 'Save failed'); return }

    setVersions(prev => [...prev, data])
    setShowUpload(false)
    setUploadParsed(null)
    setUploadNotes('')
    setUploadType('shooting_script')
    setActiveTab(uploadType)
  }

  const cancelUpload = () => {
    setShowUpload(false)
    setUploadParsed(null)
    setUploadNotes('')
    setUploadType('shooting_script')
    setUploadError('')
  }

  // ── Patch notes ────────────────────────────────────────────────────────────

  const handlePatchNotes = async (scriptId, notes) => {
    const res = await api(`/api/projects/${id}/scripts/${scriptId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    })
    if (!res.ok) return
    const updated = await res.json()
    setVersions(prev => prev.map(s => s.id === scriptId ? { ...s, notes: updated.notes } : s))
  }

  // ── Delete version ──────────────────────────────────────────────────────────

  const handleDelete = async (script) => {
    const label = versionLabel(script)
    if (!confirm(`Delete "${label}" (${script.filename})? This cannot be undone.`)) return
    const res = await api(`/api/projects/${id}/scripts/${script.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) { alert(data.error); return }
    setVersions(prev => prev.filter(s => s.id !== script.id))
  }

  // ── Send to Breakdown ───────────────────────────────────────────────────────

  const handleSendToBreakdown = async (script) => {
    setDiffPanel({ scriptId: script.id, scriptLabel: versionLabel(script), loading: true })

    const [scriptRes, breakdownRes] = await Promise.all([
      api(`/api/projects/${id}/scripts/${script.id}`),
      api(`/api/projects/${id}/breakdown`),
    ])

    if (!scriptRes.ok) {
      setDiffPanel(null)
      alert('Failed to load script data.')
      return
    }

    const fullScript = await scriptRes.json()
    const currentScenes = breakdownRes.ok ? await breakdownRes.json() : []

    let newScenes
    try { newScenes = JSON.parse(fullScript.scenesData) } catch { newScenes = [] }

    if (newScenes.length === 0) {
      setDiffPanel(null)
      alert('This script has no parsed scenes. Try re-uploading the file.')
      return
    }

    const diff = computeDiff(currentScenes, newScenes)
    setDiffPanel({
      scriptId: script.id,
      scriptLabel: versionLabel(script),
      diff,
      newScenes,
      currentScenes,
      loading: false,
      applying: false,
      applyError: '',
    })
  }

  const handleApply = async (merge) => {
    setDiffPanel(prev => ({ ...prev, applying: true, applyError: '' }))
    const res = await api(`/api/projects/${id}/scripts/${diffPanel.scriptId}/apply-to-breakdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge }),
    })
    if (!res.ok) {
      const data = await res.json()
      setDiffPanel(prev => ({ ...prev, applying: false, applyError: data.error ?? 'Apply failed' }))
      return
    }
    navigate(`/projects/${id}/breakdown`)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return <div className="empty-state"><p>Loading…</p></div>
  if (error) return <div className="empty-state"><p>{error}</p></div>

  const tabVersions = versions.filter(v => v.type === activeTab)
    .sort((a, b) => a.versionNumber - b.versionNumber)

  return (
    <>
      <div className="page-header">
        <Link to={`/projects/${id}`} className="back-link">← Overview</Link>
        <div className="page-header-row" style={{ marginTop: 8 }}>
          <div>
            <h1>Script</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
              {versions.length} version{versions.length !== 1 ? 's' : ''}
              {versions.filter(v => v.type === 'shooting_script').length > 0 &&
                ` · ${versions.filter(v => v.type === 'shooting_script').length} shooting script${versions.filter(v => v.type === 'shooting_script').length !== 1 ? 's' : ''}`}
            </p>
          </div>
          {isAdmin && (
            <button
              className="btn-primary"
              style={{ width: 'auto', padding: '8px 16px' }}
              onClick={() => { setShowUpload(v => !v); setUploadError('') }}
            >
              {showUpload ? 'Cancel' : '+ Add Version'}
            </button>
          )}
        </div>
      </div>

      {/* Upload form */}
      {showUpload && (
        <div className="import-panel">
          <div className="import-panel-header">
            <span className="import-panel-filename">Upload Script</span>
          </div>

          {/* Type selector */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {['scriptment', 'draft', 'shooting_script'].map(t => (
              <button
                key={t}
                className={uploadType === t ? 'btn-primary' : 'btn-secondary'}
                style={{ width: 'auto', padding: '6px 14px', fontSize: 13 }}
                onClick={() => setUploadType(t)}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>

          {/* File picker */}
          <div style={{ marginTop: 12 }}>
            <button
              className="btn-secondary"
              style={{ width: 'auto', padding: '8px 14px' }}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadParsed ? `📄 ${uploadParsed.filename}` : 'Choose file (.fountain, .fdx, .fadein, .xml)'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".fountain,.fdx,.fadein,.xml,.txt"
              style={{ display: 'none' }}
              onChange={handleFilePick}
            />
          </div>

          {/* Parse result */}
          {uploadParsed && (
            <div style={{ marginTop: 8 }}>
              {uploadParsed.error ? (
                <p className="auth-error" style={{ margin: 0 }}>{uploadParsed.error}</p>
              ) : (
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                  {uploadParsed.scenes.length} scene{uploadParsed.scenes.length !== 1 ? 's' : ''} detected
                  {' · '}<span style={{ textTransform: 'uppercase', fontSize: 11 }}>{uploadParsed.format}</span>
                  {uploadType === 'shooting_script' && (
                    <>
                      {' · '}
                      <ColorChip revision={getNextColor(versions, uploadType)} />
                    </>
                  )}
                </p>
              )}
            </div>
          )}

          {/* Notes */}
          <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
            <label>Notes / revision summary (optional)</label>
            <input
              value={uploadNotes}
              onChange={e => setUploadNotes(e.target.value)}
              placeholder="e.g. Added new act 2 scene, trimmed act 3"
            />
          </div>

          {uploadError && <p className="auth-error" style={{ marginTop: 8, marginBottom: 0 }}>{uploadError}</p>}

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              className="btn-primary"
              style={{ width: 'auto', padding: '8px 16px' }}
              onClick={handleSave}
              disabled={!uploadParsed || !!uploadParsed.error || uploadSaving}
            >
              {uploadSaving ? 'Saving…' : 'Save Version'}
            </button>
            <button
              className="btn-secondary"
              style={{ width: 'auto', padding: '8px 14px' }}
              onClick={cancelUpload}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Send-to-breakdown diff panel */}
      {diffPanel && (
        <DiffPanel
          panel={diffPanel}
          onApply={handleApply}
          onCancel={() => setDiffPanel(null)}
        />
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginTop: 16 }}>
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 20px', fontSize: 14,
              color: activeTab === tab ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
              fontWeight: activeTab === tab ? 600 : 400,
              marginBottom: -1,
            }}
          >
            {TAB_LABELS[tab]}
            {' '}
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              ({versions.filter(v => v.type === tab).length})
            </span>
          </button>
        ))}
      </div>

      {/* Version list */}
      <div style={{ marginTop: 16 }}>
        {tabVersions.length === 0 ? (
          <div className="empty-state" style={{ marginTop: 32 }}>
            <div className="empty-state-icon">📜</div>
            <p>
              {isAdmin
                ? `No ${TAB_LABELS[activeTab].toLowerCase()} yet. Click "+ Add Version" to upload one.`
                : `No ${TAB_LABELS[activeTab].toLowerCase()} yet.`}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {tabVersions.map(script => (
              <ScriptCard
                key={script.id}
                script={script}
                isAdmin={isAdmin}
                onDelete={handleDelete}
                onSendToBreakdown={handleSendToBreakdown}
                onPatchNotes={handlePatchNotes}
                sending={diffPanel?.loading && diffPanel?.scriptId === script.id}
              />
            ))}
          </div>
        )}
      </div>
    </>
  )

}

// ── ScriptCard ────────────────────────────────────────────────────────────────

function ScriptCard({ script, isAdmin, onDelete, onSendToBreakdown, onPatchNotes, sending }) {
  const [notesValue, setNotesValue] = useState(script.notes ?? '')

  const saveNotes = () => {
    if (notesValue !== (script.notes ?? '')) {
      onPatchNotes(script.id, notesValue)
    }
  }

  return (
    <div className="invoice-row" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Top row: badge, filename, meta, actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {/* Version badge */}
        <div style={{ minWidth: 110 }}>
          {script.type === 'shooting_script' ? (
            <ColorChip revision={script.colorRevision} />
          ) : (
            <span style={{
              display: 'inline-block', padding: '2px 10px', borderRadius: 4,
              fontSize: 12, fontWeight: 600, background: 'var(--surface-2)',
              border: '1px solid var(--border)', color: 'var(--text-secondary)',
            }}>
              v{script.versionNumber}
            </span>
          )}
        </div>

        {/* Filename + format */}
        <div style={{ flex: 1, minWidth: 180 }}>
          <span style={{ fontWeight: 500, fontSize: 14 }}>
            {script.title || script.filename}
          </span>
          {script.title && script.filename !== script.title && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 6 }}>
              {script.filename}
            </span>
          )}
          <span style={{
            marginLeft: 8, fontSize: 11, padding: '1px 6px',
            background: 'var(--surface-2)', borderRadius: 3,
            color: 'var(--text-muted)', textTransform: 'uppercase',
          }}>
            {script.format}
          </span>
        </div>

        {/* Scene count */}
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 70 }}>
          {script.sceneCount} scene{script.sceneCount !== 1 ? 's' : ''}
        </div>

        {/* Date */}
        <div style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 100 }}>
          {formatDate(script.uploadedAt)}
        </div>

        {/* Actions */}
        {isAdmin && (
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            {script.type === 'shooting_script' && (
              <button
                className="btn-primary"
                style={{ width: 'auto', padding: '5px 12px', fontSize: 12 }}
                onClick={() => onSendToBreakdown(script)}
                disabled={sending}
              >
                {sending ? 'Loading…' : 'Send to Breakdown'}
              </button>
            )}
            <button
              className="btn-secondary"
              style={{ width: 'auto', padding: '5px 10px', fontSize: 12, color: 'var(--text-muted)' }}
              onClick={() => onDelete(script)}
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {/* Notes row — editable for admins, read-only otherwise */}
      {isAdmin ? (
        <input
          value={notesValue}
          onChange={e => setNotesValue(e.target.value)}
          onFocus={e => { e.target.style.borderBottomColor = 'var(--border)' }}
          onBlur={e => { e.target.style.borderBottomColor = 'transparent'; saveNotes() }}
          placeholder="Add notes or revision summary…"
          style={{
            fontSize: 12, fontStyle: notesValue ? 'italic' : 'normal',
            color: notesValue ? 'var(--text-secondary)' : 'var(--text-muted)',
            background: 'transparent', border: 'none', borderBottom: '1px solid transparent',
            padding: '2px 0', width: '100%', outline: 'none',
          }}
        />
      ) : (
        script.notes && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            {script.notes}
          </div>
        )
      )}
    </div>
  )
}

// ── DiffPanel ─────────────────────────────────────────────────────────────────

function DiffPanel({ panel, onApply, onCancel }) {
  if (panel.loading) {
    return (
      <div className="import-panel">
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>Comparing with current breakdown…</p>
      </div>
    )
  }

  const { diff, currentScenes, scriptLabel } = panel
  const isFirstBreakdown = currentScenes.length === 0
  const hasChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.modified.length > 0

  return (
    <div className="import-panel">
      <div className="import-panel-header">
        <div>
          <span className="import-panel-filename">Send to Breakdown: {scriptLabel}</span>
          {isFirstBreakdown ? (
            <span className="import-panel-count">First breakdown — {diff.added.length} scenes will be imported</span>
          ) : !hasChanges ? (
            <span className="import-panel-count" style={{ color: 'var(--success, green)' }}>
              No scene heading changes detected ({diff.unchanged.length} scenes unchanged)
            </span>
          ) : (
            <>
              {diff.added.length > 0 && <span className="import-panel-count" style={{ color: 'var(--success, green)' }}>+{diff.added.length} added</span>}
              {diff.removed.length > 0 && <span className="import-panel-count" style={{ color: 'var(--danger, #e53e3e)' }}>−{diff.removed.length} removed</span>}
              {diff.modified.length > 0 && <span className="import-panel-count" style={{ color: 'var(--accent)' }}>~{diff.modified.length} heading changed</span>}
              {diff.unchanged.length > 0 && <span className="import-panel-count">{diff.unchanged.length} unchanged</span>}
            </>
          )}
        </div>
        <button
          className="btn-secondary"
          style={{ width: 'auto', padding: '6px 12px', fontSize: 12 }}
          onClick={onCancel}
          disabled={panel.applying}
        >
          Cancel
        </button>
      </div>

      {/* Added scenes */}
      {diff.added.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--success, green)', margin: '0 0 4px' }}>
            New scenes
          </p>
          {diff.added.map(s => (
            <div key={s.sceneNumber} style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '2px 0' }}>
              + {sceneSlug(s)}
            </div>
          ))}
        </div>
      )}

      {/* Removed scenes */}
      {diff.removed.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger, #e53e3e)', margin: '0 0 4px' }}>
            Removed scenes (breakdown elements will be deleted)
          </p>
          {diff.removed.map(s => (
            <div key={s.sceneNumber} style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '2px 0' }}>
              − {sceneSlug(s)}
            </div>
          ))}
        </div>
      )}

      {/* Modified headings */}
      {diff.modified.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', margin: '0 0 4px' }}>
            Changed headings (breakdown elements will be kept)
          </p>
          {diff.modified.map(s => {
            const old = panel.currentScenes.find(c => c.sceneNumber === String(s.sceneNumber))
            return (
              <div key={s.sceneNumber} style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '2px 0' }}>
                ~ {sceneSlug(old)} → {s.intExt} {s.location} — {s.timeOfDay}
              </div>
            )
          })}
        </div>
      )}

      {panel.applyError && (
        <p className="auth-error" style={{ margin: '12px 0 0' }}>{panel.applyError}</p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        {isFirstBreakdown ? (
          <button
            className="btn-primary"
            style={{ width: 'auto', padding: '8px 16px' }}
            onClick={() => onApply(false)}
            disabled={panel.applying}
          >
            {panel.applying ? 'Importing…' : 'Import to Breakdown'}
          </button>
        ) : (
          <>
            <button
              className="btn-primary"
              style={{ width: 'auto', padding: '8px 16px' }}
              onClick={() => onApply(true)}
              disabled={panel.applying}
              title="Keep elements for unchanged/modified scenes. Add new scenes, remove deleted ones."
            >
              {panel.applying ? 'Applying…' : 'Smart Merge'}
            </button>
            <button
              className="btn-secondary"
              style={{ width: 'auto', padding: '8px 14px' }}
              onClick={() => onApply(false)}
              disabled={panel.applying}
              title="Wipe all current scenes and elements and re-import from scratch."
            >
              Replace All
            </button>
          </>
        )}
      </div>

      {!isFirstBreakdown && (
        <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
          <strong>Smart Merge</strong> keeps existing breakdown elements for unchanged and modified scenes.
          <strong> Replace All</strong> wipes the current breakdown and re-imports from scratch.
        </p>
      )}
    </div>
  )
}
