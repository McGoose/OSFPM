// Central tool registry.
// Add new tools here — components read from this list, not from local arrays.
// 'scope' controls where a tool can appear:
//   'project'    → project-level (Budget, Schedule, etc.)
//   'department' → inside a department workspace
// 'status': 'live' | 'planned'
// 'route': function that returns the URL path given context

export const TOOLS = [
  // ── Project-level tools ──────────────────────────────────────────────────
  {
    id: 'budget',
    name: 'Money',
    icon: '💰',
    description: 'Budget plan, invoices, co-production splits, and funding income tracking.',
    route: ({ projectId }) => `/projects/${projectId}/budget`,
    scope: 'project',
    status: 'live',
  },
  {
    id: 'breakdown',
    name: 'Breakdown',
    icon: '📋',
    description: 'Scene-by-scene script breakdown — cast, props, costume, VFX, and all department elements.',
    route: ({ projectId }) => `/projects/${projectId}/breakdown`,
    scope: 'project',
    status: 'live',
  },
  {
    id: 'calendar',
    name: 'Calendar',
    icon: '📅',
    description: 'Schedule meetings, recces, casting sessions, rehearsals, and shoot days.',
    route: ({ projectId }) => `/projects/${projectId}/calendar`,
    scope: 'project',
    status: 'live',
  },
  {
    id: 'crew',
    name: 'Crew & Cast',
    icon: '👥',
    description: 'Onboard cast and crew — collect contact details, emergency info, and create OSFPM accounts.',
    route: ({ projectId }) => `/projects/${projectId}/crew`,
    scope: 'project',
    status: 'live',
  },
  {
    id: 'meetings',
    name: 'Meetings',
    icon: '📝',
    description: 'Meeting notes, action items, and follow-ups.',
    route: ({ projectId }) => `/projects/${projectId}/meetings`,
    scope: 'project',
    status: 'planned',
    plannedVersion: 'v0.3.0',
  },

  // ── Department-level tools ────────────────────────────────────────────────
  {
    id: 'dept-breakdown',
    name: 'Breakdown',
    icon: '📄',
    description: 'Scene-by-scene breakdown — props, costume, special requirements.',
    route: ({ projectId, deptId }) => `/projects/${projectId}/departments/${deptId}/breakdown`,
    scope: 'department',
    status: 'planned',
    plannedVersion: 'v0.3.0',
  },
  {
    id: 'dept-budget',
    name: 'Department Budget',
    icon: '💸',
    description: 'Budget lines and invoices filtered to this department.',
    route: ({ projectId, deptId }) => `/projects/${projectId}/departments/${deptId}/budget`,
    scope: 'department',
    status: 'planned',
    plannedVersion: 'v0.3.0',
  },
  {
    id: 'dept-reports',
    name: 'Reports',
    icon: '📑',
    description: 'Daily and weekly department reports and sign-off sheets.',
    route: ({ projectId, deptId }) => `/projects/${projectId}/departments/${deptId}/reports`,
    scope: 'department',
    status: 'planned',
    plannedVersion: 'v0.3.0',
  },
  {
    id: 'dept-crew',
    name: 'Crew',
    icon: '👤',
    description: 'Contacts and roles for this department\'s team.',
    route: ({ projectId, deptId }) => `/projects/${projectId}/departments/${deptId}/crew`,
    scope: 'department',
    status: 'planned',
    plannedVersion: 'v0.3.0',
  },
]

export const projectTools     = () => TOOLS.filter(t => t.scope === 'project')
export const departmentTools  = () => TOOLS.filter(t => t.scope === 'department')
export const liveTools        = () => TOOLS.filter(t => t.status === 'live')
export const toolById         = (id) => TOOLS.find(t => t.id === id)
