import { useState, useEffect } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { useProject } from '../../context/ProjectContext'
import ProjectForm from './ProjectForm'

export default function EditProject() {
  const { id } = useParams()
  const { currentProject, loadProjects } = useProject()
  const navigate = useNavigate()
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (currentProject) {
      setForm({
        title: currentProject.title,
        genre: currentProject.genre ?? '',
        format: currentProject.format ?? '',
        status: currentProject.status,
        description: currentProject.description ?? '',
      })
    }
  }, [currentProject])

  const submit = async e => {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      loadProjects()
      navigate(`/projects/${id}`)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete "${currentProject?.title}"? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to delete project')
      loadProjects()
      navigate('/projects')
    } catch (err) {
      setError(err.message)
    }
  }

  if (!form) {
    return <div className="loading" style={{ minHeight: 200 }}>Loading…</div>
  }

  return (
    <>
      <div className="page-header">
        <Link to={`/projects/${id}`} className="back-link">← {currentProject?.title}</Link>
        <h1>Edit project</h1>
      </div>
      <ProjectForm
        form={form}
        onChange={setForm}
        onSubmit={submit}
        error={error}
        saving={saving}
        mode="edit"
        onDelete={handleDelete}
      />
    </>
  )
}
