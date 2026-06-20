import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { annotateLines } from '../../utils/fountain'
import { BREAKDOWN_CATEGORIES, INT_EXT_OPTIONS, TIME_OPTIONS } from './constants'

// ── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function buildHighlightedLine(text, elements) {
  if (!elements?.length) return escHtml(text)

  const marks = []
  for (const el of elements) {
    if (!el.description) continue
    let idx = text.indexOf(el.description)
    while (idx !== -1) {
      marks.push({ start: idx, end: idx + el.description.length, cat: el.category })
      idx = text.indexOf(el.description, idx + 1)
    }
  }
  if (!marks.length) return escHtml(text)

  marks.sort((a, b) => a.start !== b.start ? a.start - b.start : b.end - a.end)
  const noOverlap = []
  let cursor = 0
  for (const m of marks) {
    if (m.start >= cursor) { noOverlap.push(m); cursor = m.end }
  }

  let html = ''
  let pos = 0
  for (const m of noOverlap) {
    html += escHtml(text.slice(pos, m.start))
    const cat = BREAKDOWN_CATEGORIES.find(c => c.id === m.cat)
    const color = cat?.color ?? '#888'
    html += `<mark class="el-mark" style="background:${color}28;border-bottom:1.5px solid ${color};border-radius:2px;padding:0 1px" title="${escHtml(cat?.label ?? m.cat)}">${escHtml(text.slice(m.start, m.end))}</mark>`
    pos = m.end
  }
  html += escHtml(text.slice(pos))
  return html
}

// ── Tag popup (appears on text selection) ────────────────────────────────────

function TagPopup({ x, y, onSelect, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 80)
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler) }
  }, [onClose])

  const style = {
    position: 'fixed',
    top: Math.min(y, window.innerHeight - 300),
    left: Math.min(x, window.innerWidth - 260),
    zIndex: 1000,
  }

  return (
    <div ref={ref} className="tag-popup" style={style}>
      <div className="tag-popup-label">Tag selection as:</div>
      <div className="tag-popup-grid">
        {BREAKDOWN_CATEGORIES.map(cat => (
          <button
            key={cat.id}
            className="tag-popup-btn"
            style={{ '--cat-color': cat.color }}
            onMouseDown={e => { e.preventDefault(); onSelect(cat.id) }}
          >
            <span className="tag-popup-dot" style={{ background: cat.color }} />
            {cat.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Script view (rendered fountain + selection tagging) ───────────────────────

function ScriptView({ scene, onAddElement, onDeleteElement }) {
  const containerRef = useRef(null)
  const [popup, setPopup] = useState(null)

  const annotated = useMemo(() => annotateLines(scene.content || ''), [scene.content])
  const elements = scene.elements ?? []

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (!text) { setPopup(null); return }
    if (!containerRef.current?.contains(sel.anchorNode)) { setPopup(null); return }
    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    setPopup({ x: rect.left, y: rect.bottom + 8, text })
  }, [])

  const handleTag = useCallback(async (categoryId) => {
    if (!popup) return
    const text = popup.text
    setPopup(null)
    window.getSelection()?.removeAllRanges()
    await onAddElement(categoryId, text)
  }, [popup, onAddElement])

  if (!scene.content) {
    return (
      <p className="script-empty">
        No script content for this scene. Import a <code>.fountain</code> file to populate scenes automatically, or add elements manually in the Elements tab.
      </p>
    )
  }

  return (
    <div className="script-view" onMouseUp={handleMouseUp} ref={containerRef}>
      {annotated.map((line, i) => {
        if (line.type === 'empty') return <div key={i} className="script-line--empty" />
        if (line.type === 'note') return null
        return (
          <div
            key={i}
            className={`script-line script-line--${line.type}`}
            dangerouslySetInnerHTML={{ __html: buildHighlightedLine(line.text, elements) }}
          />
        )
      })}

      {popup && (
        <TagPopup
          x={popup.x}
          y={popup.y}
          onSelect={handleTag}
          onClose={() => { setPopup(null); window.getSelection()?.removeAllRanges() }}
        />
      )}
    </div>
  )
}

// ── Elements grid (category boxes with inline add) ────────────────────────────

function ElementsGrid({ scene, catDrafts, setCatDrafts, onAddElement, onDeleteElement, onPatchElement }) {
  const [editingEl, setEditingEl] = useState(null)

  const elementsByCategory = {}
  for (const cat of BREAKDOWN_CATEGORIES) {
    elementsByCategory[cat.id] = scene.elements?.filter(e => e.category === cat.id) ?? []
  }

  return (
    <div className="breakdown-categories">
      {BREAKDOWN_CATEGORIES.map(cat => {
        const els = elementsByCategory[cat.id]
        const draft = catDrafts[cat.id] ?? ''

        return (
          <div key={cat.id} className="breakdown-category" style={{ '--cat-color': cat.color }}>
            <div className="breakdown-category-title">{cat.label}</div>

            <ul className="breakdown-element-list">
              {els.map(el => (
                <li key={el.id} className="breakdown-element">
                  {editingEl?.id === el.id ? (
                    <input
                      className="breakdown-element-input"
                      value={editingEl.value}
                      autoFocus
                      onChange={e => setEditingEl(p => ({ ...p, value: e.target.value }))}
                      onBlur={() => { onPatchElement(el.id, editingEl.value); setEditingEl(null) }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { onPatchElement(el.id, editingEl.value); setEditingEl(null) }
                        if (e.key === 'Escape') setEditingEl(null)
                      }}
                    />
                  ) : (
                    <>
                      <span
                        className="breakdown-element-text"
                        onClick={() => setEditingEl({ id: el.id, value: el.description })}
                        style={{ cursor: 'text' }}
                      >
                        {el.description}
                      </span>
                      <button className="breakdown-element-delete" onClick={() => onDeleteElement(el.id)} title="Remove">×</button>
                    </>
                  )}
                </li>
              ))}
            </ul>

            <div className="breakdown-element-add">
              <input
                className="breakdown-element-input"
                placeholder={`Add ${cat.label.toLowerCase()}…`}
                value={draft}
                onChange={e => setCatDrafts(p => ({ ...p, [cat.id]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') onAddElement(cat.id) }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Main BreakdownSheet ───────────────────────────────────────────────────────

export default function BreakdownSheet({
  scene,
  isAdmin,
  onPatchScene,
  onDeleteScene,
  onAddElement,      // (categoryId, description) → Promise
  onDeleteElement,   // (elementId) → Promise
  onPatchElement,    // (elementId, description) → Promise
}) {
  const [tab, setTab] = useState(scene.content ? 'script' : 'elements')
  const [catDrafts, setCatDrafts] = useState({})
  const [fields, setFields] = useState(fieldsFrom(scene))

  function fieldsFrom(s) {
    return {
      sceneNumber: s.sceneNumber,
      intExt: s.intExt,
      location: s.location,
      timeOfDay: s.timeOfDay,
      description: s.description,
      pages: String(s.pages),
    }
  }

  // Reset when scene changes (component is keyed by scene.id)
  useEffect(() => {
    setFields(fieldsFrom(scene))
    setTab(scene.content ? 'script' : 'elements')
    setCatDrafts({})
  }, [scene.id])

  const blur = (key) => {
    const val = fields[key]
    const original = key === 'pages' ? String(scene.pages) : scene[key]
    if (val !== original) onPatchScene(scene.id, { [key]: val })
  }

  const handleAddElement = useCallback(async (categoryId, description) => {
    const desc = description ?? (catDrafts[categoryId] ?? '').trim()
    if (!desc) return
    await onAddElement(scene.id, categoryId, desc)
    if (!description) setCatDrafts(p => ({ ...p, [categoryId]: '' }))
  }, [catDrafts, onAddElement, scene.id])

  const handleDeleteElement = useCallback((elementId) => {
    onDeleteElement(scene.id, elementId)
  }, [onDeleteElement, scene.id])

  const handlePatchElement = useCallback((elementId, description) => {
    if (description.trim()) onPatchElement(scene.id, elementId, description)
  }, [onPatchElement, scene.id])

  const elementCount = scene.elements?.length ?? 0

  // Page display: e.g. "1⅛" or "2/8" etc.
  const pagesDisplay = (() => {
    const eighths = Math.round(parseFloat(fields.pages || 1) * 8)
    const whole = Math.floor(eighths / 8)
    const rem = eighths % 8
    if (rem === 0) return `${whole}${whole === 0 ? '0' : ''}`
    if (whole === 0) return `${rem}/8`
    return `${whole} ${rem}/8`
  })()

  return (
    <div>
      {/* Scene header */}
      <div className="sheet-header">
        {isAdmin ? (
          <>
            <div className="sheet-header-fields">
              <div className="field sheet-field" style={{ width: 72 }}>
                <label>Scene #</label>
                <input
                  value={fields.sceneNumber}
                  onChange={e => setFields(p => ({ ...p, sceneNumber: e.target.value }))}
                  onBlur={() => blur('sceneNumber')}
                />
              </div>
              <div className="field sheet-field">
                <label>INT/EXT</label>
                <select
                  value={fields.intExt}
                  onChange={e => { setFields(p => ({ ...p, intExt: e.target.value })); onPatchScene(scene.id, { intExt: e.target.value }) }}
                >
                  {INT_EXT_OPTIONS.map(o => <option key={o}>{o}</option>)}
                </select>
              </div>
              <div className="field sheet-field" style={{ flex: 1 }}>
                <label>Location</label>
                <input
                  value={fields.location}
                  onChange={e => setFields(p => ({ ...p, location: e.target.value }))}
                  onBlur={() => blur('location')}
                  placeholder="LOCATION NAME"
                />
              </div>
              <div className="field sheet-field">
                <label>Time</label>
                <select
                  value={fields.timeOfDay}
                  onChange={e => { setFields(p => ({ ...p, timeOfDay: e.target.value })); onPatchScene(scene.id, { timeOfDay: e.target.value }) }}
                >
                  {TIME_OPTIONS.map(o => <option key={o}>{o}</option>)}
                </select>
              </div>
              <div className="field sheet-field" style={{ width: 72 }}>
                <label>Pages</label>
                <input
                  value={fields.pages}
                  onChange={e => setFields(p => ({ ...p, pages: e.target.value }))}
                  onBlur={() => blur('pages')}
                  placeholder="1"
                />
              </div>
              <button
                className="btn-danger"
                style={{ alignSelf: 'flex-end', padding: '7px 12px', fontSize: 12, marginLeft: 8 }}
                onClick={() => onDeleteScene(scene.id)}
              >
                Delete
              </button>
            </div>
            <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
              <label>Synopsis</label>
              <input
                value={fields.description}
                onChange={e => setFields(p => ({ ...p, description: e.target.value }))}
                onBlur={() => blur('description')}
                placeholder="One-line synopsis"
              />
            </div>
          </>
        ) : (
          <div className="sheet-header-readonly">
            <span className="sheet-scene-num">Scene {scene.sceneNumber}</span>
            <span className="scene-badge">{scene.intExt}</span>
            <span className="scene-badge">{scene.timeOfDay}</span>
            <span style={{ flex: 1, fontSize: 13 }}>{scene.location}</span>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{pagesDisplay}p</span>
            {scene.description && <p style={{ marginTop: 6, color: 'var(--text-secondary)', fontSize: 13 }}>{scene.description}</p>}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="budget-tabs">
        {scene.content && (
          <button
            className={`budget-tab${tab === 'script' ? ' budget-tab--active' : ''}`}
            onClick={() => setTab('script')}
          >
            📄 Script
          </button>
        )}
        <button
          className={`budget-tab${tab === 'elements' ? ' budget-tab--active' : ''}`}
          onClick={() => setTab('elements')}
        >
          📋 Elements
          {elementCount > 0 && <span className="budget-tab-count">{elementCount}</span>}
        </button>
      </div>

      {tab === 'script' ? (
        <ScriptView scene={scene} onAddElement={handleAddElement} onDeleteElement={handleDeleteElement} />
      ) : (
        <ElementsGrid
          scene={scene}
          catDrafts={catDrafts}
          setCatDrafts={setCatDrafts}
          onAddElement={handleAddElement}
          onDeleteElement={handleDeleteElement}
          onPatchElement={handlePatchElement}
        />
      )}
    </div>
  )
}
