import { Link } from 'react-router-dom'

const modules = [
  {
    to: '/preproduction',
    icon: '🎬',
    title: 'Pre-Production',
    desc: 'Script breakdown, budgeting, scheduling, crew management, and department reports.',
  },
  {
    to: '/production',
    icon: '🎥',
    title: 'Production',
    desc: 'Call sheets, dailies management, filming reports, gear tracking, and schedule adherence.',
  },
  {
    to: '/postproduction',
    icon: '🎞️',
    title: 'Post-Production',
    desc: 'Review notes, media organization, delivery scheduling, and collaboration tools.',
  },
]

const sharedTools = [
  { to: '/calendar', icon: '📅', title: 'Calendar', desc: 'Unified scheduling across all production phases.' },
  { to: '/contacts', icon: '📋', title: 'Contacts', desc: 'Cast, crew, and vendor contact book.' },
  { to: '/todo', icon: '✓', title: 'To-Do', desc: 'Cross-module task management with priorities.' },
]

export default function Home() {
  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>Open Source Film Production Manager — v0.1.0</p>
      </div>

      <p className="section-title">Modules</p>
      <div className="card-grid" style={{ marginBottom: '32px' }}>
        {modules.map(m => (
          <Link to={m.to} key={m.to}>
            <div className="card">
              <div className="card-icon">{m.icon}</div>
              <div className="card-title">{m.title}</div>
              <div className="card-desc">{m.desc}</div>
              <div className="badge badge-planned">In Development</div>
            </div>
          </Link>
        ))}
      </div>

      <p className="section-title">Shared Tools</p>
      <div className="card-grid">
        {sharedTools.map(t => (
          <Link to={t.to} key={t.to}>
            <div className="card">
              <div className="card-icon">{t.icon}</div>
              <div className="card-title">{t.title}</div>
              <div className="card-desc">{t.desc}</div>
              <div className="badge badge-planned">In Development</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
