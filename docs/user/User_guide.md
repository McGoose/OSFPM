# User Guide

*Version: 0.2.2 — Last updated: 2026-06-22*

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
| Dashboard | Overview and quick links to all modules |
| Pre-Production | Overview of pre-production tools |
| Production | Overview of production tools |
| Post-Production | Overview of post-production tools |
| Calendar | Shared team calendar *(coming v0.5.0)* |
| Contacts | Contact book *(coming v0.5.0)* |
| To-Do | Task lists *(coming v0.5.0)* |
| Settings | Workspace configuration *(admin only)* |

Your name and organization are shown at the bottom of the sidebar. Click the **↪** icon to sign out.

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

The three production modules are currently scaffolded — their full feature sets are being built out in upcoming releases. See the [Roadmap](../../ROADMAP.md) for the planned timeline.

- **Pre-Production** — Script breakdown, budgeting, scheduling, crew management, department reports, meeting tracker *(v0.2.0)*
- **Production** — Call sheets, dailies, filming reports, gear tracking, crew monitoring *(v0.3.0)*
- **Post-Production** — Review notes, media organization, delivery scheduling *(v0.4.0)*

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
