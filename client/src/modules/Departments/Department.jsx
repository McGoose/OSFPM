import { useState, useEffect } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useProject } from '../../context/ProjectContext'
import { useAuth } from '../../context/AuthContext'
import { departmentTools } from '../../tools'
import ToolCard from '../../components/ToolCard'

export default function Department() {
  const { id, deptId } = useParams()
  const navigate = useNavigate()
  const { departments, reloadDepartments } = useProject()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const dept = departments.find(d => d.id === parseInt(deptId))

  const [editName, setEditName] = useState('')
  const [editIcon, setEditIcon] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (dept) { setEditName(dept.name); setEditIcon(dept.icon) }
  }, [dept])

  if (!dept) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⚠</div>
        <p>Department not found.</p>
        <Link to={`/projects/${id}`} className="back-link" style={{ marginTop: 16, display: 'inline-block' }}>← Back to project</Link>
      </div>
    )
  }

  const save = async () => {
    if (!editName.trim()) return
    setSaving(true)
    setError('')
    const res = await fetch(`/api/projects/${id}/departments/${deptId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: editName.trim(), icon: editIcon }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error); setSaving(false); return }
    reloadDepartments()
    setEditing(false)
    setSaving(false)
  }

  const deleteDept = async () => {
    if (!confirm(`Delete the "${dept.name}" department?`)) return
    await fetch(`/api/projects/${id}/departments/${deptId}`, { method: 'DELETE', credentials: 'include' })
    reloadDepartments()
    navigate(`/projects/${id}`)
  }

  return (
    <>
      <div className="page-header">
        <Link to={`/projects/${id}`} className="back-link">← Overview</Link>
        <div className="page-header-row" style={{ marginTop: 8 }}>
          {editing ? (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flex: 1, flexWrap: 'wrap' }}>
              <input
                value={editIcon}
                onChange={e => setEditIcon(e.target.value)}
                style={{ width: 52, textAlign: 'center', fontSize: 22, padding: '6px 4px', background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontFamily: 'var(--font)' }}
                maxLength={4}
              />
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                style={{ flex: 1, minWidth: 180, fontSize: 22, fontWeight: 700, background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', padding: '6px 10px', fontFamily: 'var(--font)' }}
                onKeyDown={e => e.key === 'Enter' && save()}
                autoFocus
              />
              <button className="btn-primary" style={{ width: 'auto', padding: '8px 16px' }} onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button className="btn-secondary" style={{ width: 'auto', padding: '8px 14px' }} onClick={() => { setEditing(false); setEditName(dept.name); setEditIcon(dept.icon) }}>
                Cancel
              </button>
            </div>
          ) : (
            <>
              <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 28 }}>{dept.icon}</span>
                {dept.name}
              </h1>
              {isAdmin && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-secondary" style={{ width: 'auto', padding: '7px 14px' }} onClick={() => setEditing(true)}>
                    Edit
                  </button>
                  <button className="btn-danger" style={{ marginLeft: 0 }} onClick={deleteDept}>
                    Delete
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {error && <p className="auth-error" style={{ marginBottom: 16 }}>{error}</p>}

      {/* Department tools — driven by tools.js registry */}
      <p className="section-title">Tools</p>
      <div className="card-grid">
        {departmentTools().map(tool => (
          <ToolCard key={tool.id} tool={tool} routeCtx={{ projectId: id, deptId }} />
        ))}
      </div>
    </>
  )
}
