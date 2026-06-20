import { NavLink, Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'
import { useProject } from '../../context/ProjectContext'

const sharedTools = [
  { to: '/calendar', label: 'Calendar', icon: '◷' },
  { to: '/contacts', label: 'Contacts', icon: '◎' },
  { to: '/todo', label: 'To-Do', icon: '◻' },
]

const projectTools = [
  { to: '', label: 'Overview', icon: '⊞', end: true },
  { to: '/budget', label: 'Budget', icon: '💰' },
  { to: '/breakdown', label: 'Breakdown', icon: '📋' },
  { to: '/crew', label: 'Crew & Cast', icon: '👥' },
  { to: '/calendar', label: 'Calendar', icon: '📅' },
]

export default function Sidebar() {
  const { user, logout } = useAuth()
  const { settings } = useSettings()
  const { currentProject, currentProjectId, departments } = useProject()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  const navLink = (to, icon, label, end = false) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
    >
      <span className="icon">{icon}</span>
      {label}
    </NavLink>
  )

  return (
    <aside className="sidebar">
      <div className="sidebar-nav">

        {currentProject ? (
          <>
            <Link to="/projects" className="sidebar-link sidebar-back">
              <span className="icon">←</span>
              Projects
            </Link>
            <div className="sidebar-divider" />
            <div className="sidebar-section-label sidebar-project-name" title={currentProject.title}>
              {currentProject.title}
            </div>

            {/* Project-level tools */}
            {projectTools.map(t => (
              <NavLink
                key={t.to}
                to={`/projects/${currentProjectId}${t.to}`}
                end={t.end}
                className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              >
                <span className="icon">{t.icon}</span>
                {t.label}
              </NavLink>
            ))}

            {/* Departments */}
            {departments.length > 0 && (
              <>
                <div className="sidebar-divider" />
                <div className="sidebar-section-label">Departments</div>
                {departments.map(dept => (
                  <NavLink
                    key={dept.id}
                    to={`/projects/${currentProjectId}/departments/${dept.id}`}
                    className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
                  >
                    <span className="icon">{dept.icon}</span>
                    {dept.name}
                  </NavLink>
                ))}
              </>
            )}
          </>
        ) : (
          navLink('/projects', '⊞', 'Projects', true)
        )}

        <div className="sidebar-divider" />
        <div className="sidebar-section-label">Shared Tools</div>
        {sharedTools.map(t => navLink(t.to, t.icon, t.label))}

        {user?.role === 'admin' && (
          <>
            <div className="sidebar-divider" />
            <div className="sidebar-section-label">Admin</div>
            {navLink('/users', '◎', 'Users')}
            {navLink('/settings', '⚙', 'Settings')}
            {navLink('/settings/budget-template', '≡', 'Budget Template')}
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
