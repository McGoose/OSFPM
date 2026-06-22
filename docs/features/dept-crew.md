# Department Crew

**Status:** Planned — v0.3.0  
**Route:** `/projects/:id/departments/:deptId/crew`  
**Scope:** Department-level

The Department Crew view is a filtered window into the project's Crew & Cast list, showing only the members assigned to a specific department. It gives department heads quick access to their team's contact information without navigating the full crew list.

---

## Planned features

### Team list

Shows all crew members whose `departmentId` matches this department. For each member:

- Name and role / job title
- Phone number (direct access for on-set use)
- Email address
- Status: `pending` / `confirmed` / `wrapped`
- Whether they have an active OSFPM account

### Quick contact

On mobile and tablet, phone numbers will be tappable to dial directly. Email addresses will open the default mail client.

### Availability at a glance

Cross-referenced with the Calendar: shows each team member's schedule for the current and upcoming week — which days they are called, any days they are not available.

### On-call view

During production, a simplified "who's on today" view shows at the top of the page — team members confirmed for today's shoot day, with their call time if available.

---

## Relationship to project Crew & Cast

This view reads from the same crew_members data as the project-level Crew & Cast tool. Department heads cannot add new crew members or change department assignments — those actions are admin-only and done from the project-level tool. Department heads can see (but not edit) their team members' details.
