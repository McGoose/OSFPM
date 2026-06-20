import { Link, useParams } from 'react-router-dom'
import { useProject } from '../../context/ProjectContext'

const planned = [
  { icon: '📄', title: 'Script Breakdown', desc: 'Break down scenes by characters, props, locations, costumes, and more.', version: 'v0.3.0' },
  { icon: '📅', title: 'Scheduling', desc: 'Build your shooting schedule integrated with the global calendar.', version: 'v0.3.0' },
  { icon: '📑', title: 'Department Reports', desc: 'Customizable report templates for each department head.', version: 'v0.3.0' },
  { icon: '👥', title: 'Crew Management', desc: 'Manage crew contacts, roles, availability, and department assignments.', version: 'v0.3.0' },
  { icon: '📝', title: 'Meeting Tracker', desc: 'Log meeting notes, action items, and follow-ups by project and department.', version: 'v0.3.0' },
]

export default function PreProduction() {
  const { id } = useParams()
  const { currentProject } = useProject()

  return (
    <>
      <div className="page-header">
        <Link to={`/projects/${id}`} className="back-link">← {currentProject?.title ?? 'Project'}</Link>
        <h1>Pre-Production</h1>
        <p>Plan your film from script to first day of principal photography.</p>
      </div>
      <p className="section-title">Tools</p>
      <div className="card-grid">
        <Link to={`/projects/${id}/preproduction/budget`} className="card card--link">
          <div className="card-icon">💰</div>
          <div className="card-title">Budget Tracker</div>
          <div className="card-desc">Track estimated vs actual costs. Company template, project-level editing, section totals.</div>
          <div className="badge badge-live">Live</div>
        </Link>
        {planned.map(t => (
          <div className="card" key={t.title}>
            <div className="card-icon">{t.icon}</div>
            <div className="card-title">{t.title}</div>
            <div className="card-desc">{t.desc}</div>
            <div className="badge badge-planned">Planned — {t.version}</div>
          </div>
        ))}
      </div>
    </>
  )
}
