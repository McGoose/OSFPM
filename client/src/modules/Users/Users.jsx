import { useState, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'

export default function Users() {
  const { user: self } = useAuth()
  const [users, setUsers] = useState([])
  const [error, setError] = useState('')

  const load = () =>
    fetch('/api/users', { credentials: 'include' })
      .then(r => r.json())
      .then(setUsers)
      .catch(() => setError('Failed to load users'))

  useEffect(() => { load() }, [])

  const changeRole = async (id, role) => {
    setError('')
    const res = await fetch(`/api/users/${id}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ role }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error); return }
    setUsers(u => u.map(x => x.id === id ? { ...x, role: data.role } : x))
  }

  const deleteUser = async (id, name) => {
    if (!confirm(`Remove ${name} from this workspace? They will lose access immediately.`)) return
    setError('')
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE', credentials: 'include' })
    const data = await res.json()
    if (!res.ok) { setError(data.error); return }
    setUsers(u => u.filter(x => x.id !== id))
  }

  const fmt = ts => {
    if (!ts) return '—'
    return new Date(typeof ts === 'number' ? ts * 1000 : ts).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    })
  }

  if (self?.role !== 'admin') {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🔒</div>
        <p>Only admins can manage users.</p>
      </div>
    )
  }

  return (
    <>
      <div className="page-header">
        <h1>Users</h1>
        <p>Manage who has access to this workspace and their roles.</p>
      </div>

      {error && <p className="auth-error" style={{ marginBottom: 16 }}>{error}</p>}

      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Joined</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className={u.id === self.id ? 'table-row--self' : ''}>
                <td>
                  <span className="user-name">{u.name}</span>
                  {u.id === self.id && <span className="user-you-badge">you</span>}
                </td>
                <td className="table-muted">{u.email}</td>
                <td>
                  {u.id === self.id ? (
                    <span className="role-badge role-badge--admin">admin</span>
                  ) : (
                    <select
                      className="role-select"
                      value={u.role}
                      onChange={e => changeRole(u.id, e.target.value)}
                    >
                      <option value="admin">admin</option>
                      <option value="crew">crew</option>
                    </select>
                  )}
                </td>
                <td className="table-muted">{fmt(u.createdAt)}</td>
                <td className="table-actions">
                  {u.id !== self.id && (
                    <button
                      className="btn-table-delete"
                      onClick={() => deleteUser(u.id, u.name)}
                      title={`Remove ${u.name}`}
                    >
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="users-hint">
        New users can join by registering at <code>/setup</code> — they are assigned the crew role automatically.
      </p>
    </>
  )
}
