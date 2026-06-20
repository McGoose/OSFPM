import { Link } from 'react-router-dom'
import { useProject } from '../../context/ProjectContext'
import { useAuth } from '../../context/AuthContext'

const STATUS_LABELS = {
  'development': 'Development',
  'pre-production': 'Pre-Production',
  'production': 'Production',
  'post-production': 'Post-Production',
  'completed': 'Completed',
}

export default function Projects() {
  const { projects } = useProject()
  const { user } = useAuth()

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1>Projects</h1>
            <p>Select a project to open it, or create a new one.</p>
          </div>
          {user?.role === 'admin' && (
            <Link to="/projects/new" className="btn-primary btn-inline">+ New project</Link>
          )}
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🎬</div>
          <p>
            {user?.role === 'admin'
              ? 'No projects yet. Create your first one to get started.'
              : 'No projects yet. Ask an admin to create one.'}
          </p>
        </div>
      ) : (
        <div className="card-grid">
          {projects.map(project => (
            <Link to={`/projects/${project.id}`} key={project.id} style={{ textDecoration: 'none' }}>
              <div className="card project-card">
                <span className={`badge badge-status badge-status--${project.status}`}>
                  {STATUS_LABELS[project.status]}
                </span>
                <div className="card-title" style={{ marginTop: 10 }}>{project.title}</div>
                {(project.format || project.genre) && (
                  <div className="project-meta">
                    {[project.format, project.genre].filter(Boolean).join(' · ')}
                  </div>
                )}
                {project.description && (
                  <div className="card-desc" style={{ marginTop: 6 }}>{project.description}</div>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
