import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function ProtectedRoute({ children }) {
  const { user } = useAuth()
  if (user === undefined) return <div className="loading">Loading...</div>
  if (user === null) return <Navigate to="/login" replace />
  return children
}
