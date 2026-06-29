import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Header from './Header'
import Sidebar from './Sidebar'

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="layout">
      <Header onMenuToggle={() => setSidebarOpen(o => !o)} />
      <div
        className={`sidebar-overlay${sidebarOpen ? ' sidebar-overlay--open' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />
      <div className="layout-body">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
