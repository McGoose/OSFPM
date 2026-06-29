import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import SoundReport from './SoundReport'
import CameraReport from './CameraReport'
import ProgressReport from './ProgressReport'
import './Report.css'

const TABS = ['Sound', 'Camera', 'Daily Progress']

export default function ReportDay() {
  const { id: projectId, eventId } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => { setTab(0) }, [eventId])

  useEffect(() => {
    setLoading(true)
    fetch(`/api/projects/${projectId}/reports/${eventId}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e.error)))
      .then(setData)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [projectId, eventId, refreshKey])

  if (loading) return <div className="rpt-day-wrap"><p style={{ padding: 24 }}>Loading…</p></div>
  if (error) return <div className="rpt-day-wrap"><p style={{ padding: 24, color: 'red' }}>{error}</p></div>

  const { event, soundReport, cameraReport, dailyProgressReport, crew, scenes, callSheet, previousCameraSetup, pettyCash } = data

  return (
    <div className="rpt-day-wrap">
      <div className="rpt-day-header">
        <button className="btn-secondary" onClick={() => navigate(`/projects/${projectId}/reports`)}>← Back</button>
        <h2>{event.title || 'Shoot Day'}</h2>
        <span className="rpt-date">{event.date}</span>
      </div>

      <div className="rpt-tabs">
        {TABS.map((t, i) => (
          <button
            key={t}
            className={`rpt-tab${tab === i ? ' active' : ''}`}
            onClick={() => setTab(i)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="rpt-tab-content">
        {tab === 0 && (
          <SoundReport
            projectId={projectId}
            eventId={eventId}
            soundReport={soundReport}
            onSaved={() => setRefreshKey(k => k + 1)}
          />
        )}
        {tab === 1 && (
          <CameraReport
            projectId={projectId}
            eventId={eventId}
            cameraReport={cameraReport}
            previousCameraSetup={previousCameraSetup}
            onSaved={() => setRefreshKey(k => k + 1)}
          />
        )}
        {tab === 2 && (
          <ProgressReport
            projectId={projectId}
            eventId={eventId}
            event={event}
            crew={crew}
            scenes={scenes}
            callSheet={callSheet}
            cameraReport={cameraReport}
            soundReport={soundReport}
            progressReport={dailyProgressReport}
            pettyCash={pettyCash}
            onSaved={() => setRefreshKey(k => k + 1)}
          />
        )}
      </div>
    </div>
  )
}
