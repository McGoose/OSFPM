import { Link, useParams } from 'react-router-dom'
import { useProject } from '../../context/ProjectContext'

const tools = [
  { icon: '📝', title: 'Review Notes', desc: 'Annotate and track feedback on cuts, VFX, color, and sound from directors and producers.', version: 'v0.4.0' },
  { icon: '🗂️', title: 'Media Management', desc: 'Organize footage, audio, VFX deliverables, and versions with metadata tagging.', version: 'v0.4.0' },
  { icon: '📅', title: 'Delivery Schedule', desc: 'Timeline for editing, color grade, VFX, sound design, and final delivery milestones.', version: 'v0.4.0' },
  { icon: '🤝', title: 'Collaboration', desc: 'Shared workspace for editors, colorists, VFX supervisors, and sound designers.', version: 'v0.4.0' },
]

export default function PostProduction() {
  const { id } = useParams()
  const { currentProject } = useProject()

  return (
    <>
      <div className="page-header">
        <Link to={`/projects/${id}`} className="back-link">← {currentProject?.title ?? 'Project'}</Link>
        <h1>Post-Production</h1>
        <p>Organize workflows from first assembly to final delivery.</p>
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
