# Script Tool

**Status:** Live  
**Route:** `/projects/:id/script`  
**Scope:** Project-level

## Overview

Manage all versions of a production's script in one place — from early scriptments and drafts through to colour-revised shooting scripts. Every version is stored permanently so the history is never lost, and any two versions can be diffed side by side.

## Script types

| Type | Description |
|---|---|
| **Scriptment** | Early prose/outline stage — narrative treatment of the story |
| **Draft** | Full screenplay draft, numbered sequentially |
| **Shooting Script** | The locked, production-ready script. Automatically assigned a DGA revision colour. |

## DGA revision colour system

Each shooting script upload is assigned the next colour in the WGA/DGA sequence:

**White → Blue → Pink → Yellow → Green → Goldenrod → Buff → Salmon → Cherry → Tan → Ivory → (repeats)**

The colour chip is shown on the version card and carried through to the Breakdown tool.

## Uploading a script

1. Click **+ Upload** and choose the script type (Scriptment / Draft / Shooting Script)
2. For shooting scripts, add an optional title and notes — the revision colour is assigned automatically
3. Supported format: **Fountain** (`.fountain` or `.txt`)

## Sending to Breakdown

Once a shooting script is uploaded, click **Send to Breakdown** on its version card. This parses the script into scenes and auto-populates the Breakdown tool with scene headings, INT/EXT, location, time of day, and page count estimates.

- Manually added scenes in Breakdown are **not** removed
- A banner in Breakdown shows which script version it is currently based on, and alerts when a newer shooting script is available

## Diff view

Click any two version cards while holding Shift (or use the Compare button) to open a side-by-side colour diff showing added, removed, and changed scene content.
