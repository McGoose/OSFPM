import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'

const SECTIONS = [
  { key: 'above_the_line', label: 'Above-the-Line' },
  { key: 'below_the_line', label: 'Below-the-Line' },
  { key: 'post_production', label: 'Post Production' },
  { key: 'other', label: 'Other' },
]

export default function BudgetTemplate() {
  const { user } = useAuth()
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [addSection, setAddSection] = useState('')
  const [addName, setAddName] = useState('')

  useEffect(() => {
    fetch('/api/settings/budget-template', { credentials: 'include' })
      .then(r => r.json())
      .then(data => { setCategories(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => { setError('Failed to load template'); setLoading(false) })
  }, [])

  const saveName = async (id, name) => {
    if (!name.trim()) return
    const res = await fetch(`/api/settings/budget-template/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name }),
    })
    const updated = await res.json()
    setCategories(cats => cats.map(c => c.id === id ? updated : c))
  }

  const changeSection = async (id, section) => {
    const res = await fetch(`/api/settings/budget-template/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ section }),
    })
    const updated = await res.json()
    setCategories(cats => cats.map(c => c.id === id ? updated : c))
  }

  const deleteCategory = async (id, name) => {
    if (!confirm(`Remove "${name}" from the company template?`)) return
    await fetch(`/api/settings/budget-template/${id}`, { method: 'DELETE', credentials: 'include' })
    setCategories(cats => cats.filter(c => c.id !== id))
  }

  const addCategory = async (e) => {
    e.preventDefault()
    if (!addName.trim() || !addSection) return
    setError('')
    const res = await fetch('/api/settings/budget-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: addName.trim(), section: addSection }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error); return }
    setCategories(cats => [...cats, data])
    setAddName('')
    setAddSection('')
  }

  if (user?.role !== 'admin') {
    return <div className="empty-state"><div className="empty-state-icon">🔒</div><p>Admin only.</p></div>
  }

  if (loading) return <div className="loading" style={{ minHeight: 200 }}>Loading…</div>

  return (
    <>
      <div className="page-header">
        <Link to="/settings" className="back-link">← Settings</Link>
        <h1>Budget Template</h1>
        <p>Manage the company-wide default budget categories. New projects copy this template when seeded.</p>
      </div>

      {error && <p className="auth-error" style={{ marginBottom: 16 }}>{error}</p>}

      {SECTIONS.map(section => {
        const sectionCats = categories.filter(c => c.section === section.key)
        return (
          <div key={section.key} className="settings-section">
            <div className="settings-section-title">{section.label}</div>
            <div className="data-table-wrap">
              <table className="data-table">
                <tbody>
                  {sectionCats.length === 0 ? (
                    <tr><td colSpan={3} className="table-muted" style={{ fontStyle: 'italic' }}>No categories in this section</td></tr>
                  ) : sectionCats.map(cat => (
                    <tr key={cat.id}>
                      <td style={{ width: '55%' }}>
                        <input
                          className="budget-cat-input"
                          style={{ fontWeight: 500 }}
                          defaultValue={cat.name}
                          onBlur={e => saveName(cat.id, e.target.value)}
                        />
                      </td>
                      <td style={{ width: '35%' }}>
                        <select
                          className="role-select"
                          value={cat.section}
                          onChange={e => changeSection(cat.id, e.target.value)}
                        >
                          {SECTIONS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                      </td>
                      <td className="table-actions">
                        <button className="btn-table-delete" onClick={() => deleteCategory(cat.id, cat.name)}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      <div className="settings-section">
        <div className="settings-section-title">Add category</div>
        <form onSubmit={addCategory} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '1 1 200px', marginBottom: 0 }}>
            <label>Name</label>
            <input
              value={addName}
              onChange={e => setAddName(e.target.value)}
              placeholder="e.g. Aerial Unit"
              required
            />
          </div>
          <div className="field" style={{ flex: '1 1 180px', marginBottom: 0 }}>
            <label>Section</label>
            <select value={addSection} onChange={e => setAddSection(e.target.value)} required>
              <option value="">Select section…</option>
              {SECTIONS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          <button type="submit" className="btn-primary" style={{ width: 'auto', padding: '9px 20px' }}>
            Add
          </button>
        </form>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 24, lineHeight: 1.6 }}>
        Changes here don't affect existing project budgets — only new projects seeded from this template.
      </p>
    </>
  )
}
