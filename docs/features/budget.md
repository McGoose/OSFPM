# Budget

**Status:** Live  
**Route:** `/projects/:id/budget`  
**Scope:** Project-level

The Budget tool is a two-tab workspace for planning costs and tracking real spend against the plan.

---

## Budget Planning tab

A spreadsheet-style table for building a cost plan before spending begins. Lines are grouped into categories, which are grouped into sections.

### Sections

| Section | Description |
|---|---|
| Above the Line | Story, rights, producers, director, cast, stunts, ATL travel |
| Below the Line | All production crew and costs |
| Post Production | Editing, sound, grade, VFX, music, titles |
| Other | Insurance, contingency, publicity, tests |

### Line item fields

| Column | Description |
|---|---|
| Description | Line item name — editable inline, saves on blur |
| Qty | Quantity (numeric) |
| Unit | Label: `day`, `week`, `hour`, `flat`, etc. |
| Rate | Cost per unit |
| Total | Auto-computed: `qty × rate`, stored server-side |
| Notes | Optional free text |

Rows can be reordered by drag. New lines are added within a category. Categories can be added, renamed, or deleted by admins.

### Budget template

Admins manage a company-wide master list of categories at `/settings/budget-template`. When a project's budget is first opened, it seeds from this template. Template changes do **not** retroactively affect existing budgets.

---

## Invoice Tracking tab

Tracks actual spend. Each invoice is a record of money that has been or will be paid.

### Invoice fields

| Field | Description |
|---|---|
| Vendor | Who was paid |
| Invoice # | Reference number |
| Date | Invoice date |
| Amount | Invoice total |
| Status | `pending` / `approved` / `paid` / `rejected` |
| Description | What it was for |
| Budget line | Optional link to a planning line |
| Notes | Free text |

Invoices can be filtered by status. Summary cards at the top of the tab show:

- **Total Budget** — sum of all planning lines
- **Total Invoiced** — all pending + approved invoices
- **Paid** — invoices with `paid` status
- **Remaining** — budget minus paid

---

## Co-Production Split

Below the tabs, a panel manages co-production entities — companies or individuals sharing production costs. Each entry has:

- Name
- Share percentage
- Calculated amount (derived from total budget)
- Notes

An admin warning is shown if the percentages don't sum to 100%. Co-producers do not need OSFPM accounts.
