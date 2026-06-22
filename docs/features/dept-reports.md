# Department Reports

**Status:** Planned — v0.3.0  
**Route:** `/projects/:id/departments/:deptId/reports`  
**Scope:** Department-level

Department Reports provide a structured record of daily and weekly progress for each department. They capture what was completed, what issues arose, and what is outstanding — creating an auditable log for the production office.

---

## Planned features

### Daily reports

A daily report is filed at the end of each working day. Fields:

| Field | Description |
|---|---|
| Date | Report date |
| Author | Person filing (auto-populated from logged-in user) |
| Summary | Brief description of the day's work |
| Completed | What was accomplished (linked to scenes or tasks) |
| Outstanding | What was not completed and is carried over |
| Issues | Problems encountered — equipment, logistics, personnel |
| Notes | Anything else worth recording |

### Weekly reports

A weekly summary covering Monday–Friday. Auto-populated from the daily reports of that week, with a department-head sign-off field. Submitted to the production office at end of week.

### Sign-off workflow

Reports go through a simple approval:

- `draft` — being written
- `submitted` — filed by the department
- `acknowledged` — seen by the production office

### Report history

All past reports are stored and browsable. Production can search or filter by date range, department, or status.

### Integration with Calendar

Shoot days in the Calendar will link to the corresponding daily report, so the production office can cross-reference schedule vs. actual progress.

---

## Notes

Call sheets — the outward-facing daily document sent to cast and crew — are a separate planned feature (see the Calendar tool roadmap). Department reports are the inward-facing record.
