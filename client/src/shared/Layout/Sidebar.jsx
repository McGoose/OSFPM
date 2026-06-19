import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'

const nav = [
  { to: '/', label: 'Dashboard', icon: '⌂', end: true },
  { type: 'divider' },
  { type: 'section', label: 'Pre-Production' },
  { to: '/preproduction', label: 'Overview', icon: '◈' },
  { type: 'divider' },
  { type: 'section', label: 'Production' },
  { to: '/production', label: 'Overview', icon: '◉' },
  { type: 'divider' },
  { type: 'section', label: 'Post-Production' },
  { to: '/postproduction', label: 'Overview', icon: '◆' },
  { type: 'divider' },
  { type: 'section', label: 'Shared Tools' },
  { to: '/calendar', label: 'Calendar', icon: '◷' },
  { to: '/contacts', label: 'Contacts', icon: '◎' },
  { to: '/todo', label: 'To-Do', icon: '◻' },
]

export default function Sidebar() {
  const { user, logout } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-nav">
        {nav.map((item, i) => {
          if (item.type === 'divider') return <div key={i} className="sidebar-divider" />
          if (item.type === 'section') return <div key={i} className="sidebar-section-label">{item.label}</div>
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              <span className="icon">{item.icon}</span>
              {item.label}
            </NavLink>
          )
        })}

        {user?.role === 'admin' && (
          <>
            <div className="sidebar-divider" />
            <NavLink
              to="/settings"
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              <span className="icon">⚙</span>
              Settings
            </NavLink>
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="sidebar-user-name">{user?.name}</div>
          <div className="sidebar-user-org">{settings.org_name}</div>
        </div>
        <button className="sidebar-logout" onClick={handleLogout} title="Sign out">↪</button>
      </div>
    </aside>
  )
}
