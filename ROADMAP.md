# OSFPM Roadmap

*Last updated: 2026-06-19*

---

## Current Status

**Version:** 0.1.0 — Foundation complete. Auth, database, and workspace customization are live. Module UI is scaffolded; real features begin in v0.2.0.

---

## Phase 1: Foundation and Architecture — v0.1.0 ✅

- [x] Monorepo structure (npm workspaces: `client/`, `server/`)
- [x] React 18 + Vite 6 frontend with React Router v6
- [x] Node.js + Express 4 backend (ES modules)
- [x] SQLite database via better-sqlite3 + Drizzle ORM
- [x] JWT authentication (httpOnly cookies, 7-day sessions)
- [x] Role-based access control foundation (`admin` / `crew`)
- [x] First-run setup wizard (admin account + workspace config)
- [x] Workspace customization: accent color, org name, currency, timezone
- [x] Scaffolded UI for all three production modules + shared tools
- [x] Dark cinematic UI theme with live CSS variable theming

---

## Phase 2: Pre-Production Module — v0.2.0

- [ ] Film project creation (title, genre, format, technical details)
- [ ] Script breakdown tool (scenes, characters, props, locations, costumes)
- [ ] Budget tracker (estimated vs. actual costs, currency from workspace settings)
- [ ] Department reports (customizable templates per department head)
- [ ] Scheduling (calendar integration)
- [ ] Crew management
- [ ] Meeting tracker

---

## Phase 3: Production Module — v0.3.0

- [ ] Call sheet creation and distribution
- [ ] Dailies management (footage tracking, metadata, backup status)
- [ ] Filming reports (daily updates, automated and manual)
- [ ] Gear tracking (equipment list with status)
- [ ] Crew monitoring (availability, contact, on-set notes)
- [ ] Schedule adherence tools

---

## Phase 4: Post-Production Module — v0.4.0

- [ ] Media data organization (footage, edits, metadata)
- [ ] Review notes (annotate and track feedback on edits)
- [ ] Delivery scheduling (timeline for editing, grade, VFX, sound)
- [ ] Collaboration tools for editors and VFX supervisors

---

## Phase 5: Shared Tools — v0.5.0

- [ ] Unified calendar (events from all modules, per-user and global views)
- [ ] Contact book (cast, crew, vendors — linked to crew management)
- [ ] To-do lists (cross-module task management with priorities and reminders)
- [ ] Video leader creator

---

## Phase 6: UI Polish and Collaboration — v0.6.0

- [ ] Responsive layout for tablets and mobile
- [ ] Real-time multi-user updates (WebSockets or polling)
- [ ] Change tracking and activity log
- [ ] Notification system (in-app, optionally email via SMTP)
- [ ] Logo upload for workspace branding

---

## Phase 7: Beta Release — v1.0.0

- [ ] Full end-to-end testing
- [ ] Performance review and optimisation
- [ ] Complete user documentation
- [ ] Complete developer/self-hosting documentation
- [ ] Stable API with versioning

---

## Future Enhancements

- **Mobile app** — React Native companion for on-set use
- **AI-assisted tools** — script breakdown automation, budget suggestions, scheduling optimisation
- **Third-party integrations** — cloud storage, external calendar sync (iCal/Google)
- **Plugin system** — allow developers to extend functionality with custom modules

---

Contributions and feature suggestions welcome via [GitHub Issues](https://github.com/McGoose/OSFPM/issues).

Happy filming! 🎬
