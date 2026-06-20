# Pre-Production Module

Pre-production covers everything that happens before cameras roll: budgeting, scheduling, crew assembly, and department preparation.

In OSFPM, pre-production activities are organised around the project hub and its departments, rather than a separate "pre-production section." Each department gets its own workspace with relevant tools.

---

## Live Features

### Budget (`/projects/:id/budget`)

The budget tool has two modes in a single view, accessed via tabs:

#### Budget Planning tab

A spreadsheet-style table for building a cost plan before spending begins.

| Column      | Description                                        |
|-------------|----------------------------------------------------|
| Description | Line item name (editable inline, saves on blur)    |
| Qty         | Quantity (numeric, editable inline)                |
| Unit        | Label: `day`, `week`, `flat`, `hour`, etc.         |
| Rate        | Cost per unit                                      |
| Total       | Auto-computed: `qty × rate` (stored server-side)   |
| Notes       | Free text (optional)                               |

Lines are grouped into **categories**, which are grouped into **sections** (`above_the_line` / `below_the_line`). Categories can be added, renamed, or removed by admins.

**Company-wide template**: An admin can manage a master list of budget categories at `/settings/budget-template`. When a new project's budget is initialised, it copies from this template. Template changes do not retroactively affect existing project budgets.

#### Invoice Tracking tab

Tracks actual spend against the budget plan.

| Field          | Description                                       |
|----------------|---------------------------------------------------|
| Vendor         | Who was paid                                      |
| Invoice #      | Reference number                                  |
| Date           | Invoice date                                      |
| Amount         | Invoice total                                     |
| Status         | `pending` / `approved` / `paid` / `rejected`      |
| Description    | What it was for                                   |
| Budget line    | Optional link to a specific budget line           |
| Notes          | Free text                                         |

Invoices can be filtered by status. Summary cards at the top show Total Budget, Total Invoiced (pending + approved), and Paid (with remaining).

#### Co-Production Split

Below the budget/invoice tabs, a panel lists co-production entities — other legal entities sharing the production cost. Each has a name, share percentage, calculated amount, and notes. An admin warning appears if share percentages don't sum to 100%.

Co-producers are managed per-project and do not need to be OSFPM users.

---

## Planned Features

The items below are planned for future versions. They are shown as "coming soon" in the UI.

### Script Breakdown (v0.3.0)

Scene-by-scene breakdown for each department. Planned to live in the department workspace (`/projects/:id/departments/:deptId/breakdown`). Will allow departments to tag scenes with their requirements (props, costume pieces, special equipment, etc.).

### Shooting Schedule (v0.3.0)

Day-by-day shooting schedule, integrated with the global calendar. Will show which scenes are scheduled on which day, total page count, and estimated shoot time.

### Crew Management (v0.3.0)

Crew list across departments with roles and availability. Department-level view will show just that department's team.

### Call Sheets (future)

Generated from the shooting schedule. Includes call times, location details, scene information, and cast/crew contact details. Distribution via email (Nodemailer).

### Department Reports (v0.3.0)

Daily and weekly department reports — progress notes, issues, sign-off sheets.

---

## Department Workspaces

Projects can have any number of departments. The 14 standard departments (seeded by an admin from the project dashboard) are:

- Production Office
- Direction
- Camera
- Lighting & Grip
- Sound
- Art Department
- Props
- Costume & Wardrobe
- Hair & Makeup
- Locations
- Transportation
- Visual Effects
- Post Production
- Music

Admins can add custom departments or remove ones not needed for a given project. Each department gets its own workspace page listing that department's tools.
