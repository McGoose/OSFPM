# Meetings

**Status:** Planned — v0.3.0  
**Route:** `/projects/:id/meetings`  
**Scope:** Project-level

The Meetings tool provides structured meeting notes with action item tracking. It is separate from the Calendar tool — the Calendar schedules when meetings happen; this tool records what was decided and who needs to do what.

---

## Planned features

### Meeting records

Each meeting record captures:

- Date, title, and attendees
- Agenda items (pre-meeting)
- Notes per agenda item (written during or after the meeting)
- Action items with assignee, due date, and status

### Action items

Action items are the most important output of a meeting. The planned design:

- Each action is assigned to a named person (from the project's crew list)
- Status: `open` / `in progress` / `done`
- Due date
- Optionally linked to the meeting agenda item it came from

An "open actions" view will aggregate outstanding items across all meetings.

### Integration with Calendar

Meeting events created in the Calendar can be linked to a meeting record here. This means the scheduled time and attendees are pulled from the Calendar entry, and the notes and action items are stored here.

---

## Notes

This tool is currently shown as "coming soon" in the project dashboard. It will be built once the Calendar tool is stable.
