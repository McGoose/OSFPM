# Calendar

**Status:** Live  
**Route:** `/projects/:id/calendar`  
**Scope:** Project-level

The Calendar is the scheduling hub for a project. It handles five distinct event types, each with its own rules and data requirements.

---

## Layout

A two-panel view:

- **Left panel** — month grid. Events appear as colour-coded pills on their date. Click a day to create a new event; click an event pill to view it.
- **Right panel** — context-sensitive. Shows the event creation form, event detail, or the potential actors manager depending on what is selected.

---

## Event types

| Type | Colour | Rules |
|---|---|---|
| Meeting | Blue | In person, online, or hybrid |
| Recce | Amber | Always in person |
| Casting | Purple | Generates time slots; links to potential actors |
| Rehearsal | Teal | In person, online, or hybrid |
| Shoot Day | Red | Maximum 12 hours; 12-hour gap rule (see below) |

---

## Common fields

All events share:

- **Title** — optional; defaults to the event type name if left blank
- **Date** — single day (YYYY-MM-DD)
- **Start time / End time** — 24-hour HH:MM
- **Location** — free text address or link
- **Notes** — free text

---

## Attendees (Meeting, Recce, Rehearsal, Shoot Day)

Attendees are selected from two lists in a tabbed picker:

- **Departments** — select one or more project departments; all members of those departments are considered attendees
- **Individuals** — select specific crew members from the project

A single event can have a mix of both.

---

## Shoot Day rules

**Maximum duration:** A shoot day cannot exceed 12 hours. The form shows a live duration counter and blocks saving if exceeded.

**12-hour gap rule:** When creating or editing a shoot day, the server checks every other event that shares at least one crew member with the new shoot day. If any of those events falls within 12 hours before the shoot day starts, or 12 hours after it ends, the save is blocked with a conflict message naming the conflicting event. This rule applies to all event types, including other shoot days.

**Scene picker:** A shoot day can have scenes from the breakdown attached to it. The scene picker shows all scenes with their page counts. The panel displays:
- Number of scenes selected
- Total page count
- Estimated shoot duration (1 page ≈ 1 hour)
- A warning if the estimate exceeds 12 hours

---

## Casting events

### Slot generation

When a casting event is created with a slot duration set, the server auto-generates time slots from the event's start to end time.

| Setting | Description |
|---|---|
| Slot duration | Length of each casting slot in minutes |
| Break every N slots | Insert a break slot after every N actor slots |
| Break duration | Length of each break in minutes |

Slots are generated automatically on creation. To regenerate slots after changing times or duration, edit the event and save with the "Regenerate slots" option.

### Slot assignment

In the event detail view, each slot shows:
- Time range
- An actor dropdown, pre-sorted to show available actors first (marked with ✓)
- Unassigned slots show "Unassigned"

Actors who have submitted their availability and marked this session as available appear at the top of the dropdown.

---

## Potential actors

Accessed via the "Potential actors" button in the calendar header.

A potential actor is a person being considered for casting. They do not have an OSFPM account.

### Fields

- Name, email, phone
- Role / character auditioning for
- Notes

### Availability link

Once added, an admin can send the actor a personalised link (14-day expiry) that takes them to a public page where they:
1. Confirm their name and phone number
2. See all upcoming casting events for the project
3. Mark each session as **Available** or **Unavailable**

If SMTP is not configured, the link is shown in the admin UI with a copy button for manual sharing.

Submitted availability is displayed in the actor list (`✓ Availability submitted · N sessions`).

---

## Public availability page

**Route:** `/casting-availability/:token`

No login required. Accessible on any device. Actors can update their availability by returning to the same link before the token expires.
