const tools = [
  {
    icon: '📄',
    title: 'Script Breakdown',
    desc: 'Break down scenes by characters, props, locations, costumes, and more. Auto-generate department task lists.',
    version: 'v0.2.0',
  },
  {
    icon: '💰',
    title: 'Budget Tracker',
    desc: 'Track estimated vs actual costs with local currency support. Generate budget reports by department.',
    version: 'v0.2.0',
  },
  {
    icon: '📅',
    title: 'Scheduling',
    desc: 'Build your shooting schedule integrated with the global calendar. Set deadlines and milestones.',
    version: 'v0.2.0',
  },
  {
    icon: '📑',
    title: 'Department Reports',
    desc: 'Customizable report templates for each department head.',
    version: 'v0.2.0',
  },
  {
    icon: '👥',
    title: 'Crew Management',
    desc: 'Manage crew contacts, roles, availability, and department assignments.',
    version: 'v0.2.0',
  },
  {
    icon: '📝',
    title: 'Meeting Tracker',
    desc: 'Log meeting notes, action items, and follow-ups by project and department.',
    version: 'v0.2.0',
  },
]

export default function PreProduction() {
  return (
    <div>
      <div className="page-header">
        <h1>Pre-Production</h1>
        <p>Plan your film from script to first day of principal photography.</p>
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
    </div>
  )
}
