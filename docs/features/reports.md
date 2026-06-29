# Reports Tool

**Status:** Live  
**Route:** `/projects/:id/reports`  
**Scope:** Project-level

## Overview

One report set per shoot day. The Reports list shows every shoot-day event from the Calendar with **✓ / —** badges indicating which of the three reports have been completed. Click any row to open that day's report.

---

## Sound Report

Import a Sound Devices MixPre recorder's daily export.

### Importing

- Drag-drop a `.csv` or `.txt` MixPre export onto the drop zone, or use the file picker
- The parser is **header-driven** — it works with any MixPre model regardless of track count (T1–T8)
- Handles quoted fields and Windows (`\r\n`) line endings

### Display

Priority columns shown first: **Scene, Take, Circled, False Start, File Name, Duration, Notes**. All other columns (track names, metadata) appear after.

### Integration

Saved sound rows automatically feed into the Daily Progress Report — card IDs are extracted from the File Name column prefix to populate the "Sound cards" media field.

---

## Camera Report

### Camera Setup (collapsible panel)

The setup panel is expanded by default on a new shoot day and collapsed when an existing report is loaded. Fields auto-populate from the most recent prior shoot day's camera report.

| Field | Input |
|---|---|
| Camera Type | Dropdown: ARRI ALEXA 35, ALEXA Mini LF, ALEXA Mini, RED V-RAPTOR, KOMODO-X, KOMODO, Sony VENICE 2, FX9, FX6, FX3, Blackmagic URSA Mini Pro 12K, Pocket 6K Pro, Canon EOS C70, EOS R5 C, DJI Ronin 4D, **Other** |
| Recording Format | Dropdown: ARRIRAW, ARRIRAW HDE, ProRes 4444 XQ, ProRes 4444, ProRes 422 HQ, ProRes 422, ProRes 422 LT, BRAW 12:1/8:1/5:1/3:1, R3D REDCODE RAW, CinemaDNG, XAVC-I 4K, XAVC-S 4K, H.265 4K, H.264 4K, **Other** |
| Frame Guides | Select: 1.33:1 / 1.78:1 / 1.85:1 / 2.39:1 / Custom |
| Color Space | Free text (e.g. ARRI LogC3 / AWG4) |

Selecting **Other** reveals a free-text input below the dropdown. Switching back to a standard option clears the custom text.

### Takes Log

Columns: **Card/Mag # | File | Scene | Take | Lens | ISO | Shutter | Notes**

All cells are inline-editable. Card/Mag # is read-only (incremented by Card/Mag Change).

#### Action bar

| Button | Behaviour |
|---|---|
| **+ Add Take** | Appends a new take row. Scene copies from the previous row. If the previous take was a False Take, the new take gets the **same take number** (re-shoot). Otherwise take number increments by 1. |
| **False Take** | Marks the last take as a false take — shown in grey italic with "FT" in the Take column. Disabled if no takes exist yet. |
| **Card / Mag Change** | Inserts a full-width divider "── CARD/MAG CHANGE — Card N ──" and increments the card counter. File numbers on the new card start from 1. |
| **Save** | Saves setup + all takes to the database. |

---

## Daily Progress Report

All fields are auto-populated from other tools on first load; everything remains editable before saving.

| Section | Auto-population source |
|---|---|
| **Title** | Manual |
| **Date** | Shoot day event date |
| **Production Office** | Call sheet |
| **Producer / Director / 1st AD / DOP / Sound Recordist** | Crew list — matched by role keyword |
| **Locations** | Shoot day event location field |
| **Crew Call** | Call sheet crew call time |
| **Turnover / First Slate, Camera Wrap, Crew Wrap, Last Person** | Manual |
| **Lunch** | Call sheet meal break time |
| **Slates shot today** | Camera Report — unique scene numbers from non-false takes |
| **Camera cards/mags** | Camera Report — roll numbers from card-change markers + initial card |
| **Sound cards** | Sound Report — card identifiers from File Name column prefixes |
| **Previously shot (GB) / To date shot (GB)** | Manual |
| **Scenes scheduled today** | Call sheet scene list |
| **Scenes completed / part-completed / carried forward** | Manual |
| **Talent** | Call sheet cast rows (name + call time); arrival, on-set, wrap filled manually |
| **Petty Cash** | Read-only: sum of approved + paid invoices in budget categories containing "petty". Links to Money tool. |
| **Incidents / Remarks** | Free text |
