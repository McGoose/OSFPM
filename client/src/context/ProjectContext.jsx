import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'

const ProjectContext = createContext({})

export function ProjectProvider({ children }) {
  const [projects, setProjects] = useState([])
  const [departments, setDepartments] = useState([])
  const location = useLocation()

  const loadProjects = useCallback(() => {
    fetch('/api/projects', { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then(setProjects)
      .catch(() => {})
  }, [])

  useEffect(() => { loadProjects() }, [loadProjects])

  const match = location.pathname.match(/^\/projects\/(\d+)/)
  const currentProjectId = match ? parseInt(match[1]) : null
  const currentProject = projects.find(p => p.id === currentProjectId) ?? null

  useEffect(() => {
    if (!currentProjectId) { setDepartments([]); return }
    fetch(`/api/projects/${currentProjectId}/departments`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then(data => setDepartments(Array.isArray(data) ? data : []))
      .catch(() => setDepartments([]))
  }, [currentProjectId])

  const reloadDepartments = useCallback(() => {
    if (!currentProjectId) return
    fetch(`/api/projects/${currentProjectId}/departments`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then(data => setDepartments(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [currentProjectId])

  return (
    <ProjectContext.Provider value={{ projects, currentProject, currentProjectId, loadProjects, departments, reloadDepartments }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  return useContext(ProjectContext)
}
