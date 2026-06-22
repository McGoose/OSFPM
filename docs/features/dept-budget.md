# Department Budget

**Status:** Planned — v0.3.0  
**Route:** `/projects/:id/departments/:deptId/budget`  
**Scope:** Department-level

The Department Budget is a filtered view of the project-level budget, showing only the budget lines and invoices that belong to a specific department. Department heads can monitor their own spend without access to the full project budget.

---

## Planned features

### Filtered budget view

The project budget is organised into categories and sections. Each budget category will be mappable to a department. The department budget view shows only:

- Budget lines in categories assigned to this department
- Invoices linked to those budget lines

### Summary

At the top of the page, summary cards showing:

- Department budget total (sum of lines assigned to this dept)
- Total invoiced against those lines
- Paid
- Remaining

### Invoice submission

Department heads (or crew members with appropriate access) will be able to submit invoices for their department directly from this view, rather than going through the main budget tool. Submitted invoices follow the same approval flow: `pending → approved → paid`.

### Budget alerts

If a department's total invoiced approaches or exceeds their allocated budget, an alert is shown to both the department head and project admins.

---

## Relationship to project budget

The project-level Budget tool is the source of truth. Department budget views read from the same data. Admins manage the category-to-department mapping from the project settings. Department heads cannot add or remove budget categories — only admins can.
