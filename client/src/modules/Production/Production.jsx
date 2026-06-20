import { Link, useParams } from 'react-router-dom'
import { useProject } from '../../context/ProjectContext'

const tools = [
  { icon: '📋', title: 'Call Sheets', desc: 'Create and distribute daily call sheets to cast and crew with automated scheduling integration.', version: 'v0.3.0' },
  { icon: '🎞️', title: 'Dailies Management', desc: 'Track footage, metadata, camera reports, and backup status for each shooting day.', version: 'v0.3.0' },
  { icon: '📊', title: 'Filming Reports', desc: 'Generate end-of-day reports: scenes shot, pages covered, setups, and schedule adherence.', version: 'v0.3.0' },
  { icon: '🔧', title: 'Gear Tracking', desc: 'Equipment list with status, rental periods, and department assignments.', version: 'v0.3.0' },
  { icon: '👥', title: 'Crew Monitor', desc: 'Real-time crew availability, dietary requirements, and on-set status.', version: 'v0.3.0' },
  { icon: '📆', title: 'Schedule Adherence', desc: 'Compare planned vs actual shooting progress and flag delays early.', version: 'v0.3.0' },
]

export default function Production() {
  const { id } = useParams()
  const { currentProject } = useProject()

  return (
    <>
      <div className="page-header">
        <Link to={`/projects/${id}`} className="back-link">← {currentProject?.title ?? 'Project'}</Link>
        <h1>Production</h1>
        <p>Manage the shoot — from call sheets to dailies and end-of-day reports.</p>
      </div>
      <p className="section-title">Tools</p>
      <div className="card-grid">
        {tools.map(t => (
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
