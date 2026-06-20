import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useProject } from '../../context/ProjectContext'
import { useAuth } from '../../context/AuthContext'
import { projectTools } from '../../tools'

const STATUS_LABELS = {
  'development':    'Development',
  'pre-production': 'Pre-Production',
  'production':     'Production',
  'post-production':'Post-Production',
  'completed':      'Completed',
}

export default function ProjectDashboard() {
  const { id } = useParams()
  const { currentProject, departments, reloadDepartments } = useProject()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [seeding, setSeeding] = useState(false)
  const [addName, setAddName] = useState('')
  const [addIcon, setAddIcon] = useState('📁')
  const [showAddForm, setShowAddForm] = useState(false)
  const [error, setError] = useState('')

  if (!currentProject) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⚠</div>
        <p>Project not found.</p>
      </div>
    )
  }

  const seedDepartments = async () => {
    setSeeding(true)
    setError('')
    const res = await fetch(`/api/projects/${id}/departments/seed`, { method: 'POST', credentials: 'include' })
    const data = await res.json()
    if (!res.ok) setError(data.error)
    else reloadDepartments()
    setSeeding(false)
  }

  const addDepartment = async (e) => {
    e.preventDefault()
    if (!addName.trim()) return
    setError('')
    const res = await fetch(`/api/projects/${id}/departments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: addName.trim(), icon: addIcon }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error); return }
    reloadDepartments()
    setAddName('')
    setAddIcon('📁')
    setShowAddForm(false)
  }

  return (
    <>
      <div className="page-header">
        <div className="project-header-meta">
          <span className={`badge badge-status badge-status--${currentProject.status}`}>
            {STATUS_LABELS[currentProject.status]}
          </span>
          {currentProject.format && <span className="project-chip">{currentProject.format}</span>}
          {currentProject.genre  && <span className="project-chip">{currentProject.genre}</span>}
        </div>
        <div className="page-header-row" style={{ marginTop: 8 }}>
          <div>
            <h1>{currentProject.title}</h1>
            {currentProject.description && <p>{currentProject.description}</p>}
          </div>
          {isAdmin && (
            <Link to={`/projects/${id}/edit`} className="btn-secondary">Edit project</Link>
          )}
        </div>
      </div>

      {/* Project tools row — driven by tools.js registry */}
      <div className="proj-tools-row">
        {projectTools().map(tool => {
          const isLive = tool.status === 'live'
          const inner = (
            <span className={`proj-tool-card${isLive ? '' : ' proj-tool-card--planned'}`} key={tool.id}>
              <span className="proj-tool-icon">{tool.icon}</span>
              <span className="proj-tool-label">{tool.name}</span>
              {!isLive && <span className="proj-tool-soon">soon</span>}
            </span>
          )
          return isLive
            ? <Link key={tool.id} to={tool.route({ projectId: id })} style={{ textDecoration: 'none' }}>{inner}</Link>
            : <span key={tool.id}>{inner}</span>
        })}
      </div>

      {/* Departments */}
      <div className="proj-section-header">
        <p className="section-title" style={{ margin: 0 }}>Departments</p>
        {isAdmin && (
          <div style={{ display: 'flex', gap: 8 }}>
            {departments.length === 0 && (
              <button className="btn-primary" style={{ width: 'auto', padding: '6px 14px', fontSize: 12 }} onClick={seedDepartments} disabled={seeding}>
                {seeding ? 'Setting up…' : 'Set up standard departments'}
              </button>
            )}
            <button className="btn-secondary" style={{ width: 'auto', padding: '6px 14px', fontSize: 12 }} onClick={() => setShowAddForm(v => !v)}>
              {showAddForm ? 'Cancel' : '+ Add department'}
            </button>
          </div>
        )}
      </div>

      {error && <p className="auth-error" style={{ marginBottom: 12 }}>{error}</p>}

      {showAddForm && isAdmin && (
        <form onSubmit={addDepartment} className="dept-add-form">
          <input
            className="field input"
            style={{ width: 48, textAlign: 'center', fontSize: 20, padding: '6px 4px' }}
            value={addIcon}
            onChange={e => setAddIcon(e.target.value)}
            maxLength={4}
            placeholder="📁"
          />
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <input
              value={addName}
              onChange={e => setAddName(e.target.value)}
              placeholder="Department name"
              required
              autoFocus
            />
          </div>
          <button type="submit" className="btn-primary" style={{ width: 'auto', padding: '8px 16px' }}>Add</button>
        </form>
      )}

      {departments.length === 0 ? (
        <div className="empty-state" style={{ padding: '40px 20px' }}>
          <div className="empty-state-icon">🎬</div>
          <p>{isAdmin ? 'Set up departments to organise your crew and tools by team.' : 'No departments configured yet.'}</p>
        </div>
      ) : (
        <div className="dept-grid">
          {departments.map(dept => (
            <Link key={dept.id} to={`/projects/${id}/departments/${dept.id}`} className="dept-card">
              <div className="dept-card-icon">{dept.icon}</div>
              <div className="dept-card-name">{dept.name}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
