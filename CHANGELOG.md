# Changelog

All notable changes to OSFPM are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.1.0] — 2026-06-19

### Added

- Monorepo structure with npm workspaces (`client/`, `server/`)
- React 18 + Vite 6 frontend with React Router v6
- Node.js + Express 4 backend using ES modules
- SQLite database via `better-sqlite3` with Drizzle ORM (`data/osfpm.db`)
- JWT authentication stored in httpOnly cookies (7-day sessions)
- Role-based access control — `admin` and `crew` roles
- `GET /api/auth/status` for first-run detection
- First-run setup wizard: creates admin account and configures workspace (org name, currency, timezone)
- Workspace settings system — key/value store in SQLite:
  - `org_name`, `currency`, `timezone`, `accent_color`
  - `GET /api/settings/public` (no auth) for client theming on load
  - `GET /api/settings` and `PUT /api/settings` (admin only)
- Live CSS variable theming — accent color applied at runtime via `SettingsContext`
- Admin Settings page (branding: org name + color picker; localization: currency + timezone)
- Dark cinematic UI theme with CSS custom properties
- Scaffolded UI for Pre-Production, Production, and Post-Production modules
- Scaffolded pages for shared tools: Calendar, Contacts, To-Do
- Sidebar with role-aware navigation (Settings link visible to admins only)
- Sidebar footer shows logged-in user name and organization name
- `GET /api/health` endpoint

---

## [0.0.0] — 2024-12-17

*Pre-existing placeholder. The app did not actually exist yet.*

---
