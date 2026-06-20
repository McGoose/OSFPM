# Post-Production Module

Post-production covers everything after the shoot wraps: editing, sound, colour, VFX, delivery.

In OSFPM, post-production work will be handled through the same project hub and department system as pre-production. The "Post Production" department (one of the 14 standard departments) will have its own workspace and tools.

---

## Planned Features

All post-production features are currently planned for future versions.

### Media Management (future)

Track footage cards, drives, and deliverables:

- Card/drive labels, format, codec, resolution, fps
- Ingest status and backup confirmation (3-2-1 rule tracking)
- Links to camera reports from production

### Review Notes (future)

Structured feedback on cuts and deliverables:

- Attach notes to a timecode or scene
- Status per note: open, addressed, approved
- Useful for director/editor reviews, client screenings, grade reviews

### Post Schedule (future)

Timeline view for the post pipeline:

- Offline edit, online/conform, sound mix, grade, VFX, deliverables
- Linked to the global calendar
- Deadline tracking per stage

### VFX Tracking (future)

Manage VFX shots from plate to delivery:

- Shot list with status: plate, comp, review, approved
- Links to the VFX department workspace
- Notes and version tracking

### Music / Score (future)

Track music cues, temp track decisions, and composer deliverables. Linked to the Music department workspace.

### Deliverables Checklist (future)

Final delivery specs per platform or distributor:

- Format, resolution, codec, audio configuration
- Subtitle and accessibility requirements
- Status: outstanding / delivered / accepted

---

## Notes for Developers

Post-production tools will integrate with:

- **Production** handover: camera reports, sound reports, and footage logs feed into media management
- **Budget / Invoices**: post spend (edit suite hire, VFX, grade, mix, sound design) tracked in the existing invoice tracker, categorised under post-production budget lines
- **Departments**: Post Production and Music departments each get their own workspace with relevant tools
- **Global Calendar** (v0.5.0): post schedule milestones visible across the whole project
