# Breakdown

**Status:** Live  
**Route:** `/projects/:id/breakdown`  
**Scope:** Project-level

The Breakdown tool is a scene-by-scene script analysis workspace. It lets the production team parse a screenplay, tag each scene with its requirements, and build a structured element list that feeds into scheduling and department planning.

---

## Script import

A script written in **Fountain** format can be uploaded directly. The parser extracts:

- Scene headings (INT./EXT., location, DAY/NIGHT)
- Scene content (action lines, dialogue)
- Estimated page count per scene (based on content length)

Fountain is a plain-text screenplay format supported by most modern screenwriting apps (Highland, Writer Duet, Fade In, etc.).

Once imported, the script cannot be re-imported without clearing existing scenes.

---

## Scene list

All scenes are displayed in script order. Each scene row shows:

| Field | Description |
|---|---|
| Scene # | Identifier from the script heading (e.g. `1`, `2A`) |
| INT/EXT | Interior or exterior |
| Location | The location from the heading |
| Time of day | DAY, NIGHT, DAWN, DUSK, etc. |
| Pages | Estimated page count |

Scenes can be reordered by drag. New scenes can be added manually without importing a script.

---

## Scene detail

Clicking a scene opens a detail panel showing the full scene content and a breakdown element list.

### Breakdown elements

Elements are tagged items within a scene, organised by category:

| Category | Examples |
|---|---|
| Cast | Named characters appearing in the scene |
| Extras / Atmosphere | Background performers |
| Props | Objects handled by cast |
| Costume | Specific wardrobe items or changes |
| Makeup & Hair | Special makeup, prosthetics, continuity notes |
| Lighting | Practicals, special rigs, time-of-day notes |
| Camera | Crane, steadicam, underwater, special formats |
| Sound | Playback, practical audio sources |
| Special Effects | Physical SFX, squibs, weather rigs |
| Visual Effects | VFX plates, digital extensions, markers |
| Art Department | Set dressing notes, construction requirements |
| Animals | Animals appearing in the scene |
| Vehicles | Cars, trucks, picture vehicles |
| Notes | General production notes |

Elements are added inline. Each has a description and optional notes field.

---

## Page count and scheduling

Scene page counts are used by the Calendar tool to estimate shoot duration when scheduling a shoot day. The standard estimate is **1 page = 1 hour of shooting time**. This is shown as an estimate in the shoot day form and is not a hard constraint.
