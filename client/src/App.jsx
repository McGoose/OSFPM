import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { SettingsProvider } from './context/SettingsContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './shared/Layout/Layout'
import Home from './modules/Home/Home'
import Login from './modules/Auth/Login'
import Setup from './modules/Auth/Setup'
import PreProduction from './modules/PreProduction/PreProduction'
import Production from './modules/Production/Production'
import PostProduction from './modules/PostProduction/PostProduction'
import Calendar from './shared/Calendar/Calendar'
import Contacts from './shared/Contacts/Contacts'
import Todo from './shared/Todo/Todo'
import Settings from './modules/Settings/Settings'

export default function App() {
  return (
    <SettingsProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/setup" element={<Setup />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Home />} />
              <Route path="preproduction" element={<PreProduction />} />
              <Route path="production" element={<Production />} />
              <Route path="postproduction" element={<PostProduction />} />
              <Route path="calendar" element={<Calendar />} />
              <Route path="contacts" element={<Contacts />} />
              <Route path="todo" element={<Todo />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </SettingsProvider>
  )
}
