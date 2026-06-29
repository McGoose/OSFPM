# User Guide

*Version: 0.2.x — Last updated: 2026-06-29*

---

## Getting Started

### First Run

When you open OSFPM for the first time, you'll be taken to the **Setup** page automatically. No users exist yet, so the app guides you through:

1. **Create your admin account** — enter your name, email, and a password (minimum 8 characters).
2. **Configure your workspace** — set your organization name, preferred currency, and timezone. These can be changed later in Settings.

Once complete, you're logged in as admin and taken to the Dashboard.

---

### Logging In

After the first run, the app goes straight to the **Login** page. Enter your email and password. Your session lasts 7 days before you need to log in again.

---

## Navigation

The sidebar on the left gives access to everything:

| Section | Pages |
|---|---|
| Projects | Project list and dashboard |
| Script | Script version manager — scriptments, drafts, shooting scripts |
| Money | Budget, invoices, co-production, funding |
| Breakdown | Scene-by-scene element tagging |
| Crew & Cast | Full roster and onboarding |
| Calendar | Project calendar and shoot days |
| Reports | Sound, camera, and daily progress reports |
| Calendar | Shared team calendar |
| Contacts | Contact book |
| To-Do | Task lists |
| Settings | Workspace configuration *(admin only)* |

Your name and organization are shown at the bottom of the sidebar. Click the **↪** icon to sign out.

**On mobile:** the sidebar collapses — tap the **☰** button in the top-left of the header to open it. Tap a link or tap the dark overlay to close it.

---

## Roles

| Role | Access |
|---|---|
| **Admin** | Full access to all modules, tools, and Settings |
| **Crew** | Access to all modules and shared tools; cannot access Settings |

The first registered user is always admin. Subsequent registrations are crew by default.

---

## Settings *(Admin only)*

Access via **Settings** in the sidebar.

### Branding
- **Organization name** — displayed in the sidebar footer.
- **Accent color** — changes the highlight color throughout the app. Use the color picker or type a hex value directly.

### Localization
- **Currency** — used across budget and cost fields in Pre-Production.
- **Timezone** — used for scheduling and calendar display.

Changes apply immediately after clicking **Save settings**.

---

## Modules

See the [Roadmap](../../ROADMAP.md) for the full planned timeline.

### Live now

| Tool | What it does |
|---|---|
| **Script** | Upload scriptments, drafts, and shooting scripts. DGA revision colours assigned automatically. Send a shooting script to Breakdown to auto-populate scenes. |
| **Money** | Budget lines, invoice tracker, co-production splits, funding tracker. |
| **Breakdown** | Scene list driven by the Script tool. Tag each scene with cast, props, costume, VFX, vehicles, and more. |
| **Crew & Cast** | Full roster. Onboard crew via a one-time email link. Actors get a public availability form. |
| **Calendar** | Create and manage events — meetings, recces, casting, rehearsals, shoot days. Shoot days link to call sheets. |
| **Call Sheet** | Multi-tab form (times, cast, crew, notes) with PDF download. One per shoot day. |
| **Reports** | Per shoot day: Sound Report (MixPre import), Camera Report (take log), Daily Progress Report. |
| **To-Do** | Personal task list + per-department task lists. |
| **Meetings** | Meeting notes per project. |

### Coming soon

- **Production** — Dailies tracker, gear tracking, crew monitoring *(v0.3.0)*
- **Post-Production** — Review notes, media organisation, delivery scheduling *(v0.4.0)*

---

## FAQ

**Can I run this without an internet connection?**
Yes. OSFPM is fully self-hosted. Once installed, it runs entirely on your local network with no external dependencies.

**Where is my data stored?**
In a single SQLite file at `data/osfpm.db` in the project root. Back up that file to back up everything.

**Can I add other users?**
Yes — share the app URL with your crew and they can register. New accounts are assigned the `crew` role automatically.

**How do I change my password?**
User profile management is planned for a future release. For now, contact your admin.

---

Happy filming! 🎬
