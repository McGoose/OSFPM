import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { SettingsProvider } from './context/SettingsContext'
import { ProjectProvider } from './context/ProjectContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './shared/Layout/Layout'
import Login from './modules/Auth/Login'
import Setup from './modules/Auth/Setup'
import Projects from './modules/Projects/Projects'
import ProjectDashboard from './modules/Projects/ProjectDashboard'
import CreateProject from './modules/Projects/CreateProject'
import EditProject from './modules/Projects/EditProject'
import Budget from './modules/Budget/Budget'
import Breakdown from './modules/Breakdown/Breakdown'
import Crew from './modules/Crew/Crew'
import ProjectCalendar from './modules/Calendar/ProjectCalendar'
import ActorAvailability from './modules/Actors/ActorAvailability'
import Department from './modules/Departments/Department'
import Calendar from './shared/Calendar/Calendar'
import Contacts from './shared/Contacts/Contacts'
import Todo from './shared/Todo/Todo'
import OnboardingForm from './modules/Onboarding/OnboardingForm'
import Settings from './modules/Settings/Settings'
import BudgetTemplate from './modules/Settings/BudgetTemplate'
import Users from './modules/Users/Users'

export default function App() {
  return (
    <SettingsProvider>
      <AuthProvider>
        <BrowserRouter>
          <ProjectProvider>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/setup" element={<Setup />} />
              <Route path="/onboard/:token" element={<OnboardingForm />} />
              <Route path="/casting-availability/:token" element={<ActorAvailability />} />
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <Layout />
                  </ProtectedRoute>
                }
              >
                <Route index element={<Navigate to="/projects" replace />} />
                <Route path="projects" element={<Projects />} />
                <Route path="projects/new" element={<CreateProject />} />
                <Route path="projects/:id" element={<ProjectDashboard />} />
                <Route path="projects/:id/edit" element={<EditProject />} />
                <Route path="projects/:id/budget" element={<Budget />} />
                <Route path="projects/:id/breakdown" element={<Breakdown />} />
                <Route path="projects/:id/crew" element={<Crew />} />
              <Route path="projects/:id/calendar" element={<ProjectCalendar />} />
                <Route path="projects/:id/departments/:deptId" element={<Department />} />
                {/* Legacy redirects so old bookmarks still work */}
                <Route path="projects/:id/preproduction/budget" element={<Navigate to="../budget" relative="path" replace />} />
                <Route path="projects/:id/preproduction" element={<Navigate to=".." relative="path" replace />} />
                <Route path="projects/:id/production" element={<Navigate to=".." relative="path" replace />} />
                <Route path="projects/:id/postproduction" element={<Navigate to=".." relative="path" replace />} />
                <Route path="calendar" element={<Calendar />} />
                <Route path="contacts" element={<Contacts />} />
                <Route path="todo" element={<Todo />} />
                <Route path="users" element={<Users />} />
                <Route path="settings" element={<Settings />} />
                <Route path="settings/budget-template" element={<BudgetTemplate />} />
              </Route>
            </Routes>
          </ProjectProvider>
        </BrowserRouter>
      </AuthProvider>
    </SettingsProvider>
  )
}
