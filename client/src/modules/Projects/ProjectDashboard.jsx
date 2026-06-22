import { useState, useEffect, useCallback } from 'react'
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

const EVENT_COLORS = {
  meeting:   '#4a9eff',
  recce:     '#f59e0b',
  casting:   '#a855f7',
  rehearsal: '#14b8a6',
  shoot_day: '#ef4444',
}

const EVENT_LABELS = {
  meeting:   'Meeting',
  recce:     'Recce',
  casting:   'Casting',
  rehearsal: 'Rehearsal',
  shoot_day: 'Shoot Day',
}

function formatEventDate(dateStr) {
  return new Date(dateStr + 'T00:00').toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
  })
}

function TaskRow({ task, onToggle, onDelete }) {
  return (
    <div className="db-task-row">
      <input
        type="checkbox"
        className="db-task-check"
        checked={!!task.done}
        onChange={() => onToggle(task)}
      />
      <span className={`db-task-label${task.done ? ' done' : ''}`}>{task.title}</span>
      <button className="db-task-delete" onClick={() => onDelete(task.id)} title="Delete">×</button>
    </div>
  )
}

function AddTaskRow({ placeholder, onAdd }) {
  const [val, setVal] = useState('')

  const submit = (e) => {
    e.preventDefault()
    if (!val.trim()) return
    onAdd(val.trim())
    setVal('')
  }

  return (
    <form className="db-task-add" onSubmit={submit}>
      <input
        value={val}
        onChange={e => setVal(e.target.value)}
        placeholder={placeholder}
      />
      <button type="submit" className="btn-primary" style={{ padding: '4px 10px', fontSize: 12, width: 'auto' }}>
        Add
      </button>
    </form>
  )
}

export default function ProjectDashboard() {
  const { id } = useParams()
  const { currentProject, departments, reloadDepartments } = useProject()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [tasks, setTasks] = useState({ personal: [], department: [], userDeptIds: [] })
  const [upcoming, setUpcoming] = useState([])

  // Dept management state
  const [seeding, setSeeding] = useState(false)
  const [addName, setAddName] = useState('')
  const [addIcon, setAddIcon] = useState('📁')
  const [showAddForm, setShowAddForm] = useState(false)
  const [error, setError] = useState('')

  const loadTasks = useCallback(async () => {
    const res = await fetch(`/api/projects/${id}/tasks`, { credentials: 'include' })
    if (res.ok) setTasks(await res.json())
  }, [id])

  useEffect(() => {
    if (!id) return
    loadTasks()

    fetch(`/api/projects/${id}/events`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then(events => {
        const today = new Date().toISOString().slice(0, 10)
        setUpcoming(
          events
            .filter(e => e.date >= today)
            .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
            .slice(0, 5)
        )
      })
  }, [id, loadTasks])

  const addTask = async (title, departmentId = null) => {
    const res = await fetch(`/api/projects/${id}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ title, departmentId }),
    })
    if (res.ok) loadTasks()
  }

  const toggleTask = async (task) => {
    await fetch(`/api/projects/${id}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ done: !task.done }),
    })
    loadTasks()
  }

  const deleteTask = async (taskId) => {
    await fetch(`/api/projects/${id}/tasks/${taskId}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    loadTasks()
  }

  const toggleDeptPermission = async (dept) => {
    const next = dept.taskPermission === 'admin_only' ? 'all' : 'admin_only'
    await fetch(`/api/projects/${id}/departments/${dept.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ taskPermission: next }),
    })
    reloadDepartments()
  }

  // Group dept tasks by departmentId
  const deptTaskMap = {}
  for (const t of tasks.department) {
    if (!deptTaskMap[t.departmentId]) deptTaskMap[t.departmentId] = []
    deptTaskMap[t.departmentId].push(t)
  }

  // Which departments to show in tasks widget:
  // admin = all; crew = their own depts + any depts they already have tasks in
  const userDeptIds = tasks.userDeptIds ?? []
  const taskDepts = isAdmin
    ? departments
    : departments.filter(d => userDeptIds.includes(d.id) || deptTaskMap[d.id]?.length > 0)

  // Dept management handlers
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

  if (!currentProject) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⚠</div>
        <p>Project not found.</p>
      </div>
    )
  }

  return (
    <>
      {/* Project header */}
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

      {/* Widgets row */}
      <div className="db-widgets">

        {/* My Tasks */}
        <div className="db-widget">
          <div className="db-widget-title">My Tasks</div>

          {/* Personal */}
          <div className="db-dept-sub">Personal</div>
          {tasks.personal.length === 0 && (
            <div className="db-empty">No personal tasks yet.</div>
          )}
          {tasks.personal.map(t => (
            <TaskRow key={t.id} task={t} onToggle={toggleTask} onDelete={deleteTask} />
          ))}

          {/* Department sub-sections */}
          {taskDepts.map(dept => {
            const deptTasks = deptTaskMap[dept.id] ?? []
            const canAdd = isAdmin || dept.taskPermission === 'all'
            return (
              <div key={dept.id}>
                <div className="db-dept-sub">
                  <span>{dept.icon}</span>
                  {dept.name}
                </div>
                {deptTasks.length === 0 && <div className="db-empty">No tasks yet.</div>}
                {deptTasks.map(t => (
                  <TaskRow key={t.id} task={t} onToggle={toggleTask} onDelete={deleteTask} />
                ))}
              </div>
            )
          })}
        </div>

        {/* Upcoming Events */}
        <div className="db-widget">
          <div className="db-widget-title">Upcoming</div>
          {upcoming.length === 0 ? (
            <div className="db-empty">
              No upcoming events.{' '}
              <Link to={`/projects/${id}/calendar`} style={{ color: 'var(--accent)' }}>
                Go to calendar →
              </Link>
            </div>
          ) : (
            <>
              {upcoming.map(e => (
                <div key={e.id} className="db-event-row">
                  <div className="db-event-dot" style={{ background: EVENT_COLORS[e.type] ?? '#888' }} />
                  <div className="db-event-info">
                    <div className="db-event-title">{e.title || EVENT_LABELS[e.type]}</div>
                    <div className="db-event-meta">
                      {EVENT_LABELS[e.type]} · {formatEventDate(e.date)} · {e.startTime}
                    </div>
                  </div>
                </div>
              ))}
              <div className="db-widget-footer">
                <Link to={`/projects/${id}/calendar`}>View full calendar →</Link>
              </div>
            </>
          )}
        </div>

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

      {/* Tools strip — bottom */}
      <div className="proj-section-header" style={{ marginTop: 28 }}>
        <p className="section-title" style={{ margin: 0 }}>Tools</p>
      </div>
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
    </>
  )
}
