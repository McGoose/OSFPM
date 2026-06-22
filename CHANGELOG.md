# Changelog

All notable changes to OSFPM are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Fixed
- Annotation view not showing in Script Breakdown tool (investigation pending)

---

## [0.2.2] — 2026-06-22

### Added
- **Script Breakdown — annotation view**: side-by-side panel with elements legend (left) and annotated screenplay (right); each tagged element highlights its matching text in the script
- **Fountain screenplay content in seed**: all 20 scenes of *The Last Withdrawal* now have full screenplay text so the annotation view is testable immediately after seeding
- **Art Department grouping in breakdown**: Props, Special Props, Set Dressing, Art Department, Costume, and Makeup & Hair now appear under a shared "Art Department" group header in the breakdown sheet
- **Funding tracker in Money tool**: new Funding tab tracking crowdfunding, sponsors, in-kind sponsors, and co-production income — with expected vs. received totals
- **Call Sheet PDF**: per-shoot-day multi-tab form (times, cast, crew, dept notes, page 2) with client-side PDF download via `@react-pdf/renderer`

### Changed
- **Budget tool renamed to Money** — reflects broader scope (budget + funding)
- **Breakdown seed elements**: each element is now a single matchable string (individual names / props) rather than a comma-joined list; category IDs fixed to lowercase to match `BREAKDOWN_CATEGORIES`

### Fixed
- **Currency mismatch in Money tool**: `PUBLIC_KEYS` in `settings.js` now includes `'currency'` so the client receives the correct currency from the public settings endpoint
- **Call sheet black screen**: added `PDFErrorBoundary` class component around the PDF section; React 18 no longer unmounts the entire app when `@react-pdf/renderer` throws
- **Calendar "Call Sheet" button causing full page reload**: replaced `<a href>` with `useNavigate()` to keep React Router state and module cache intact

### Removed
- "Add task" inline input from the Overview/Dashboard (tasks are added in the To-Do tool)
- Permission toggle button (🔒 / 🔓) from the Overview dashboard department task headers (toggle is still available in the To-Do tool)

---

## [0.2.1] — 2026-06-19

### Added
- **Crew & Cast tool**: full project roster — crew and cast on separate tabs; roles, departments, character names, status (confirmed / tentative / released), notes
- **Calendar tool**: project-level calendar with event creation, shoot day type, attendee management; shoot days link to call sheet
- **To-Do tool**: personal task list + per-department task lists; admin can restrict departments to admin-only additions
- **Meetings tool**: meeting notes per project with date, attendees, agenda, and action items
- Actor availability routes (`/api/projects/:id/actor-availability`)
- Budget template, co-producers, crew, departments, invoices, onboarding, projects, and users routes consolidated

### Changed
- Project hub refactored to hybrid navigation: project-level tool strip + collapsible department list

---

## [0.2.0] — 2026-06-10

### Added
- **Projects**: create, edit, delete; fields: title, genre, format, status, description
- **Project dashboard** (hub): tool strip showing all project-level tools + per-project departments
- **Money (Budget) tool**:
  - Budget planning: categories + lines (qty × unit × rate = total, inline save-on-blur editing)
  - Invoice tracker: vendor, invoice #, date, amount, status, optional link to a budget line
  - Co-production split panel: multiple legal entities with share %
  - Company-wide budget template (admin-managed, copied to new projects on seed)
- **Script Breakdown tool**: scene list with INT/EXT, location, time of day, page count, description; per-scene element tagging by category (cast, props, vehicles, animals, etc.); Fountain screenplay import
- Department workspaces: 14 standard departments or custom, each with its own tool card strip
- Central tool registry (`client/src/tools.js`) — all tools defined in one place
- `tryAlter()` migration pattern for safe idempotent column additions
- `mergeParams: true` on all nested Express routers

---

## [0.1.0] — 2026-06-19

### Added
- Monorepo structure with npm workspaces (`client/`, `server/`)
- React 18 + Vite 6 frontend with React Router v6
- Node.js + Express 4 backend (ES modules)
- SQLite via `@libsql/client` + Drizzle ORM (`data/osfpm.db`)
- JWT auth in HttpOnly cookies (7-day sessions)
- Role-based access control — `admin` / `crew`
- First-run setup wizard (admin account + workspace config)
- App settings: `org_name`, `currency`, `timezone`, `accent_color`
- `GET /api/settings/public` (no auth) for client theming on load
- Live CSS variable theming via `SettingsContext`
- Admin Settings page: branding (org name + color picker) + localization
- Dark cinematic UI theme
- User management (admin CRUD)
- `GET /api/health` endpoint

---

## [0.0.0] — 2024-12-17

*Initial placeholder. The app did not exist yet.*
