import { Link } from 'react-router-dom'

export default function ToolCard({ tool, routeCtx }) {
  const content = (
    <div className={`card${tool.status === 'live' ? ' card--link' : ''}`}>
      <div className="card-icon">{tool.icon}</div>
      <div className="card-title">{tool.name}</div>
      <div className="card-desc">{tool.description}</div>
      {tool.status === 'live'
        ? <div className="badge badge-live">Live</div>
        : <div className="badge badge-planned">Planned — {tool.plannedVersion}</div>}
    </div>
  )

  if (tool.status === 'live' && routeCtx) {
    return <Link to={tool.route(routeCtx)} style={{ textDecoration: 'none' }}>{content}</Link>
  }
  return content
}
