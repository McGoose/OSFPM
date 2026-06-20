import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useProject } from '../../context/ProjectContext'
import ProjectForm from './ProjectForm'

export default function CreateProject() {
  const { loadProjects } = useProject()
  const navigate = useNavigate()
  const [form, setForm] = useState({ title: '', genre: '', format: '', status: 'development', description: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async e => {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      loadProjects()
      navigate(`/projects/${data.id}`)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <>
      <div className="page-header">
        <Link to="/projects" className="back-link">← Projects</Link>
        <h1>New project</h1>
        <p>Set up the basics — everything can be edited later.</p>
      </div>
      <ProjectForm
        form={form}
        onChange={setForm}
        onSubmit={submit}
        error={error}
        saving={saving}
        mode="create"
      />
    </>
  )
}
