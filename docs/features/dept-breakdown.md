# Department Breakdown

**Status:** Planned — v0.3.0  
**Route:** `/projects/:id/departments/:deptId/breakdown`  
**Scope:** Department-level

The Department Breakdown is a filtered view of the project-level script breakdown, showing only the elements that belong to a specific department. It lets department heads and their teams work through their scene requirements without seeing unrelated categories.

---

## Planned features

### Filtered element list

Shows all scenes that contain at least one element tagged to this department. For each scene:

- Scene number, location, INT/EXT, page count
- Only the elements for this department (e.g. the Props department sees only Props elements)

### Department-specific fields

Some departments need additional fields beyond a basic description. Planned department-specific additions:

| Department | Extra fields |
|---|---|
| Props | Hired vs. owned, hire start/end |
| Costume & Wardrobe | Character, scene count, continuity notes |
| Hair & Makeup | Special makeup type (prosthetics, ageing, SFX) |
| Camera | Camera mount, lens notes |
| Special Effects | SFX type, safety notes |

### Status tracking

Each element can be marked with a prep status:

- `needed` — identified, not yet sourced
- `sourced` — found or booked
- `confirmed` — on hand and ready
- `wrapped` — returned or struck

### Export

Department heads will be able to export their breakdown as a PDF or CSV for distribution to team members who don't use OSFPM.

---

## Relationship to project breakdown

The project-level Breakdown tool is the source of truth. Department breakdowns are read from that data and display the relevant subset. Department heads can add notes and status to their elements without affecting the project-level view.
