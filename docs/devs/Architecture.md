# Architecture

## Stack

| Layer      | Technology               | Notes                                                        |
|------------|--------------------------|--------------------------------------------------------------|
| Frontend   | React 18 + Vite 6        | `client/` directory. React Router v6 for routing.            |
| Backend    | Node.js + Express 4      | `server/` directory. ES modules (`"type": "module"`).        |
| Database   | SQLite via `@libsql/client` | File-based. Drizzle ORM v0.45.2 for schema and queries.   |
| Auth       | JWT in HttpOnly cookies  | `bcryptjs` for password hashing. Role-based: `admin`/`crew`. |
| Email      | TBD (Nodemailer planned) | For call sheet distribution in a future version.             |

## Monorepo Structure

```
OSFPM/
├── client/                        # React + Vite frontend
│   ├── src/
│   │   ├── main.jsx               # Entry point
│   │   ├── App.jsx                # Router setup + all routes
│   │   ├── App.css                # Global styles + CSS variables
│   │   ├── tools.js               # Central tool registry (single source of truth)
│   │   ├── components/
│   │   │   ├── ProtectedRoute.jsx # Redirects unauthenticated users to /login
│   │   │   └── ToolCard.jsx       # Renders any tool from the registry
│   │   ├── context/
│   │   │   ├── AuthContext.jsx    # Current user, login/logout
│   │   │   ├── SettingsContext.jsx # App name, branding
│   │   │   └── ProjectContext.jsx  # currentProject, departments, reloadDepartments
│   │   ├── modules/
│   │   │   ├── Auth/              # Login, Setup (first-run admin creation)
│   │   │   ├── Budget/            # Budget planning + invoice tracking
│   │   │   ├── Departments/       # Department workspace
│   │   │   ├── Projects/          # Project list, dashboard, create/edit
│   │   │   ├── Settings/          # App settings, budget template editor
│   │   │   └── Users/             # User management (admin only)
│   │   └── shared/
│   │       ├── Layout/            # Layout, Header, Sidebar
│   │       ├── Calendar/          # Placeholder
│   │       ├── Contacts/          # Placeholder
│   │       └── Todo/              # Placeholder
│   ├── index.html
│   └── vite.config.js             # Dev server on :3000, proxies /api → :5000
│
├── server/                        # Express API
│   ├── src/
│   │   ├── index.js               # App entry, middleware, route mounting
│   │   ├── db/
│   │   │   ├── index.js           # DB init, CREATE TABLE, migrations, template seed
│   │   │   └── schema.js          # Drizzle ORM table definitions
│   │   ├── middleware/
│   │   │   └── auth.js            # requireAuth, requireAdmin middleware
│   │   └── routes/
│   │       ├── auth.js            # POST /login, POST /logout, GET /me
│   │       ├── budget.js          # Budget categories + lines (per project)
│   │       ├── budgetTemplate.js  # Company-wide budget template (admin)
│   │       ├── coproducers.js     # Co-production entities (per project)
│   │       ├── departments.js     # Departments (per project)
│   │       ├── invoices.js        # Invoice tracking (per project)
│   │       ├── projects.js        # Project CRUD
│   │       ├── settings.js        # App-level settings (name, etc.)
│   │       └── users.js           # User CRUD (admin only)
│   └── .env.example
│
├── docs/
│   ├── devs/
│   │   └── Architecture.md        # This file
│   └── features/
│       ├── PreProduction_module.md
│       ├── Production_module.md
│       └── PostProduction_module.md
└── package.json                   # npm workspaces root
```

## Dev Setup

```bash
npm install          # installs all workspace dependencies
npm run dev          # starts client (:3000) and server (:5000) concurrently
```

Server uses `node --watch` for hot-reload. If you hit an `EADDRINUSE :5000` error after rapid file changes, kill the leftover node process and restart `npm run dev`.

## Database

SQLite database file lives at `server/osfpm.db`. Schema is managed via Drizzle ORM definitions in `server/src/db/schema.js`. The DB is initialised (tables created, template seeded) automatically on server start via `server/src/db/index.js`.

### Tables

| Table                       | Purpose                                                      |
|-----------------------------|--------------------------------------------------------------|
| `users`                     | Accounts with email, hashed password, name, role            |
| `settings`                  | Key/value store for app-wide config (app name, etc.)         |
| `projects`                  | Projects: title, genre, format, status, description          |
| `departments`               | Per-project departments with icon and sort order             |
| `coproducers`               | Co-production entities with share % per project              |
| `budget_template_categories`| Company-wide budget category template (admin managed)        |
| `budget_categories`         | Per-project budget categories (copied from template on seed) |
| `budget_lines`              | Per-project budget lines: qty × rate = total                 |
| `invoices`                  | Invoice tracker; optionally linked to a budget line          |

### Migration pattern

New columns are added safely using `tryAlter()` — wraps `ALTER TABLE ADD COLUMN` in try/catch so it's idempotent and won't break on re-run against an existing database.

## Authentication & Roles

- JWT stored in an HttpOnly cookie (`osfpm_token`). Cookie is cleared on logout.
- Two roles: `admin` (full access including user management, template editing, project admin) and `crew` (read/write access to project data, no admin controls).
- First run: no users exist → `/setup` page creates the first admin account.
- `requireAuth` and `requireAdmin` middleware guard all API routes.

## Data Flow

Vite dev server proxies `/api/*` to Express on port 5000 — no CORS issues in development. In production, Express will serve the built `client/dist/` as static files.

## Frontend Conventions

### Tool Registry

All tools are defined in `client/src/tools.js` as a single `TOOLS` array. Components must never maintain their own tool arrays. Each tool entry has:

```js
{
  id: string,
  name: string,
  icon: string,            // emoji
  description: string,
  scope: 'project' | 'department',
  status: 'live' | 'planned',
  plannedVersion: string,  // e.g. 'v0.3.0' — only needed when status is 'planned'
  route: (ctx) => string,  // ctx is { projectId } or { projectId, deptId }
}
```

Helper exports: `projectTools()`, `departmentTools()`, `liveTools()`, `toolById(id)`.

To add a new tool: add one entry to `TOOLS`, add its route in `App.jsx`, and build the component. Nothing else needs changing.

### Inline Editing

The budget module uses a **save-on-blur** pattern (spreadsheet feel, no explicit save button). Fields commit to the API when the user tabs away or clicks out.

### Contexts

- `AuthContext` — always available; provides `user`, `login()`, `logout()`, `loading`.
- `SettingsContext` — provides `appName` and `reloadSettings()`.
- `ProjectContext` — provides `projects`, `currentProject`, `currentProjectId`, `loadProjects`, `departments`, `reloadDepartments`. Loaded when the URL contains a `:id` project param.

## API Reference

### Auth

| Method | Path             | Auth     | Description                        |
|--------|------------------|----------|------------------------------------|
| POST   | `/api/auth/login`  | —      | Login; sets JWT cookie             |
| POST   | `/api/auth/logout` | —      | Clears JWT cookie                  |
| GET    | `/api/auth/me`     | cookie | Returns current user               |
| POST   | `/api/auth/setup`  | —      | Creates first admin (first-run only)|

### Settings

| Method | Path                                    | Auth  | Description                      |
|--------|-----------------------------------------|-------|----------------------------------|
| GET    | `/api/settings`                         | —     | Returns all settings             |
| PUT    | `/api/settings`                         | admin | Updates settings                 |
| GET    | `/api/settings/budget-template`         | auth  | Lists template categories        |
| POST   | `/api/settings/budget-template`         | admin | Creates template category        |
| PUT    | `/api/settings/budget-template/:id`     | admin | Updates template category        |
| DELETE | `/api/settings/budget-template/:id`     | admin | Deletes template category        |

### Users

| Method | Path             | Auth  | Description          |
|--------|------------------|-------|----------------------|
| GET    | `/api/users`     | admin | List all users       |
| POST   | `/api/users`     | admin | Create user          |
| PUT    | `/api/users/:id` | admin | Update user          |
| DELETE | `/api/users/:id` | admin | Delete user          |

### Projects

| Method | Path                | Auth | Description          |
|--------|---------------------|------|----------------------|
| GET    | `/api/projects`     | auth | List all projects    |
| POST   | `/api/projects`     | auth | Create project       |
| GET    | `/api/projects/:id` | auth | Get project          |
| PUT    | `/api/projects/:id` | auth | Update project       |
| DELETE | `/api/projects/:id` | admin| Delete project       |

### Budget (per project — prefix: `/api/projects/:projectId`)

| Method | Path                      | Auth  | Description                                    |
|--------|---------------------------|-------|------------------------------------------------|
| GET    | `/budget`                 | auth  | All categories with nested lines               |
| POST   | `/budget/seed`            | admin | Copy template categories to this project       |
| POST   | `/budget/categories`      | admin | Add category                                   |
| PUT    | `/budget/categories/:id`  | admin | Update category                                |
| DELETE | `/budget/categories/:id`  | admin | Delete category + its lines                    |
| POST   | `/budget/lines`           | auth  | Add line (qty=1, unit=flat, rate=0)            |
| PUT    | `/budget/lines/:id`       | auth  | Update line; auto-computes total = qty × rate  |
| DELETE | `/budget/lines/:id`       | auth  | Delete line                                    |

### Invoices (per project — prefix: `/api/projects/:projectId`)

| Method | Path              | Auth  | Description                            |
|--------|-------------------|-------|----------------------------------------|
| GET    | `/invoices`       | auth  | List all invoices                      |
| POST   | `/invoices`       | auth  | Create invoice (optionally link to line)|
| PUT    | `/invoices/:id`   | auth  | Update invoice                         |
| DELETE | `/invoices/:id`   | admin | Delete invoice                         |

### Departments (per project — prefix: `/api/projects/:projectId`)

| Method | Path                    | Auth  | Description                        |
|--------|-------------------------|-------|------------------------------------|
| GET    | `/departments`          | auth  | List departments                   |
| POST   | `/departments/seed`     | admin | Seed 14 standard departments       |
| POST   | `/departments`          | admin | Add department                     |
| PUT    | `/departments/:id`      | admin | Update department                  |
| DELETE | `/departments/:id`      | admin | Delete department                  |

### Co-producers (per project — prefix: `/api/projects/:projectId`)

| Method | Path                  | Auth  | Description               |
|--------|-----------------------|-------|---------------------------|
| GET    | `/coproducers`        | auth  | List co-producers         |
| POST   | `/coproducers`        | admin | Add co-producer           |
| PUT    | `/coproducers/:id`    | admin | Update co-producer        |
| DELETE | `/coproducers/:id`    | admin | Delete co-producer        |

## Routing (Frontend)

| Path                                          | Component          | Notes                              |
|-----------------------------------------------|--------------------|------------------------------------|
| `/login`                                      | Login              | Unauthenticated                    |
| `/setup`                                      | Setup              | First-run admin creation           |
| `/projects`                                   | Projects           | Project list                       |
| `/projects/new`                               | CreateProject      |                                    |
| `/projects/:id`                               | ProjectDashboard   | Hub with tools strip + departments |
| `/projects/:id/edit`                          | EditProject        |                                    |
| `/projects/:id/budget`                        | Budget             | Budget planning + invoices         |
| `/projects/:id/departments/:deptId`           | Department         | Department workspace               |
| `/calendar`                                   | Calendar           | Placeholder                        |
| `/contacts`                                   | Contacts           | Placeholder                        |
| `/todo`                                       | Todo               | Placeholder                        |
| `/users`                                      | Users              | Admin only                         |
| `/settings`                                   | Settings           | Admin only                         |
| `/settings/budget-template`                   | BudgetTemplate     | Admin only                         |
| `/projects/:id/preproduction`                 | → `/projects/:id`  | Legacy redirect                    |
| `/projects/:id/production`                    | → `/projects/:id`  | Legacy redirect                    |
| `/projects/:id/postproduction`                | → `/projects/:id`  | Legacy redirect                    |
| `/projects/:id/preproduction/budget`          | → `budget`         | Legacy redirect                    |
