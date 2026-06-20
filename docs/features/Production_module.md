# Production Module

Production covers the shooting period — the days when cameras are rolling.

In OSFPM, production tools will be project-level and department-level tools visible from the project hub. The old `/preproduction`, `/production`, `/postproduction` URL structure has been replaced: these now redirect to the project dashboard.

---

## Planned Features

All production features are currently planned. They appear as "coming soon" in the project hub tools strip.

### Call Sheets (future)

Auto-generated from the shooting schedule. Distributed to cast and crew via email. Will include:

- General call time and advance call times by role
- Location details and directions
- Scene(s) for the day with cast, page count, and INT/EXT/DAY/NIGHT
- Weather forecast
- Special equipment, stunts, or VFX requirements
- Emergency contacts

### Daily Production Reports (future)

End-of-day records capturing:

- Scenes completed vs. planned
- Pages shot
- Total setups
- Running over/under schedule
- Crew hours

### Filming Reports / Camera Reports (future)

Per-camera or per-card reports tracking media labelling, fps, format, and notes. Feeds into the post-production handover.

### Gear / Equipment Tracking (future)

Track what equipment is on hire, from whom, and when it's due back. Linked to the budget and invoice tracker.

### Crew Tracking (v0.3.0)

Live view of who is on call, confirmed, or unavailable on a given shoot day. Connected to the schedule.

---

## Notes for Developers

Production tools will integrate tightly with:

- **Schedule** (project-level tool, v0.3.0) — provides the day-by-day plan
- **Departments** — each department has its own workspace where department-specific tools (breakdown, crew, reports) will live
- **Budget / Invoices** — shoot costs feed directly into the invoice tracker

Call sheet distribution will use Nodemailer. The email server setup will be configurable via `/settings`.
