import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import './Report.css'

export default function ReportList() {
  const { id: projectId } = useParams()
  const navigate = useNavigate()
  const [days, setDays] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch(`/api/projects/${projectId}/reports`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e.error)))
      .then(setDays)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [projectId])

  if (loading) return <div className="rpt-list-wrap"><p>Loading…</p></div>
  if (error) return <div className="rpt-list-wrap"><p style={{ color: 'red' }}>{error}</p></div>

  return (
    <div className="rpt-list-wrap">
      <div className="rpt-list-header">
        <h2>📊 Reports</h2>
      </div>

      {days.length === 0 ? (
        <div className="rpt-empty">
          No shoot days scheduled yet — add one in the Calendar.
        </div>
      ) : (
        <table className="rpt-list-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Shoot Day</th>
              <th>Sound</th>
              <th>Camera</th>
              <th>Daily Progress</th>
            </tr>
          </thead>
          <tbody>
            {days.map(({ event, hasSoundReport, hasCameraReport, hasProgressReport }) => (
              <tr key={event.id} onClick={() => navigate(`/projects/${projectId}/reports/${event.id}`)}>
                <td style={{ whiteSpace: 'nowrap' }}>{event.date}</td>
                <td>{event.title || 'Shoot Day'}</td>
                <td>
                  <span className={`rpt-status-badge ${hasSoundReport ? 'done' : 'missing'}`}>
                    {hasSoundReport ? '✓' : '—'}
                  </span>
                </td>
                <td>
                  <span className={`rpt-status-badge ${hasCameraReport ? 'done' : 'missing'}`}>
                    {hasCameraReport ? '✓' : '—'}
                  </span>
                </td>
                <td>
                  <span className={`rpt-status-badge ${hasProgressReport ? 'done' : 'missing'}`}>
                    {hasProgressReport ? '✓' : '—'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
