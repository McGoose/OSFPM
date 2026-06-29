# OSFPM Roadmap

*Last updated: 2026-06-29*

---

## Current status

**Version 0.2.x** — Pre-production module live plus early production tools. Projects, departments, crew & cast, calendar, call sheets, script tool, script breakdown, budget/money, reports, to-do, and meetings are all working. The app is fully mobile-responsive.

---

## Phase 1 — Foundation ✅ v0.1.0

- [x] Monorepo (npm workspaces: `client/`, `server/`)
- [x] React 18 + Vite 6, React Router v6
- [x] Node.js + Express 4 (ES modules)
- [x] SQLite + `@libsql/client` + Drizzle ORM
- [x] JWT auth (HttpOnly cookies, 7-day sessions)
- [x] Role-based access (`admin` / `crew`)
- [x] First-run setup wizard
- [x] App settings (org name, accent color, currency, timezone)
- [x] Dark cinematic UI theme with live CSS variable theming
- [x] User management

---

## Phase 2 — Pre-Production Module ✅ v0.2.x

- [x] Projects CRUD (title, genre, format, status, description)
- [x] Project hub — tool strip + per-project departments
- [x] Department workspaces (14 standard or custom)
- [x] **Crew & Cast** — full roster, roles, departments, character names
- [x] **Money** — budget categories + lines, invoice tracker, co-production splits
- [x] Funding tracker (crowdfunding, sponsors, in-kind, co-production income)
- [x] **Calendar** — events, shoot days, attendees
- [x] **Call Sheet** — multi-tab form (times, cast, crew, dept notes, PDF export)
- [x] **Script Breakdown** — scene list, per-scene element tagging by category
- [x] Breakdown annotation view (script + highlighted elements side-by-side)
- [x] **Script tool** — multi-version management, DGA revision colours, send to Breakdown, diff view
- [x] **To-Do** — personal + per-department task lists, permission control
- [x] **Meetings** — meeting notes per project
- [x] Central tool registry (`tools.js`)
- [x] Demo seeder with full screenplay content

---

## Phase 3 — Production Tools — v0.3.0

- [x] **Sound Report** — MixPre CSV import, header-driven parser, table display
- [x] **Camera Report** — per-take log, card/mag tracking, setup continuity between days
- [x] **Daily Progress Report** — aggregates from call sheet, crew, camera, sound, money
- [ ] Dailies tracker (footage, metadata, backup status)
- [ ] Gear tracking (equipment list + status)
- [ ] On-set crew monitoring
- [ ] Schedule adherence tracking

---

## Phase 4 — Post-Production Module — v0.4.0

- [ ] Media data organization (footage, edits, metadata)
- [ ] Review notes (annotate and track feedback per cut)
- [ ] Delivery schedule (editing, grade, VFX, sound, delivery)
- [ ] Collaboration tools for editors and VFX supervisors

---

## Phase 5 — Shared / Cross-Module Tools — v0.5.0

- [ ] Unified calendar (events from all modules in one view)
- [ ] Contact book (cast, crew, vendors — linked to crew management)
- [ ] Video leader generator

---

## Phase 6 — Polish & Collaboration — v0.6.0

- [x] Responsive layout for tablets and mobile
- [ ] Real-time multi-user updates (WebSockets or SSE)
- [ ] Activity log / change tracking
- [ ] In-app notifications (optionally email via SMTP)
- [ ] Logo upload for workspace branding

---

## Phase 7 — Beta Release — v1.0.0

- [ ] End-to-end test coverage
- [ ] Performance review and optimisation
- [ ] Complete user and self-hosting documentation
- [ ] Stable API with versioning

---

## Future ideas

- Mobile app (React Native) for on-set use
- AI-assisted script breakdown and budget estimation
- Third-party integrations (cloud storage, iCal/Google Calendar sync)
- Plugin system for custom modules

---

Suggestions and contributions welcome via [GitHub Issues](https://github.com/McGoose/OSFPM/issues).
