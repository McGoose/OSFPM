# Architecture

## Stack

| Layer      | Technology          | Notes                                              |
|------------|---------------------|----------------------------------------------------|
| Frontend   | React 18 + Vite 6   | `client/` directory. React Router v6 for routing.  |
| Backend    | Node.js + Express 4 | `server/` directory. ES modules (`"type":"module"`).|
| Database   | TBD (PostgreSQL planned) | Relational. To be added in v0.2.0.            |
| Email      | TBD (Nodemailer planned) | For call sheet distribution in v0.3.0.        |

## Monorepo Structure

```
OSFPM/
├── client/                  # React + Vite frontend
│   ├── src/
│   │   ├── main.jsx         # Entry point
│   │   ├── App.jsx          # Router setup
│   │   ├── App.css          # Global styles + CSS variables
│   │   ├── modules/
│   │   │   ├── Home/        # Dashboard
│   │   │   ├── PreProduction/
│   │   │   ├── Production/
│   │   │   └── PostProduction/
│   │   └── shared/
│   │       ├── Layout/      # Header, Sidebar, Layout wrapper
│   │       ├── Calendar/
│   │       ├── Contacts/
│   │       └── Todo/
│   ├── index.html
│   └── vite.config.js       # Dev server on :3000, proxies /api → :5000
│
├── server/                  # Express API
│   ├── src/
│   │   ├── index.js         # App entry, middleware, route mounting
│   │   └── routes/
│   │       ├── preproduction.js
│   │       ├── production.js
│   │       └── postproduction.js
│   └── .env.example
│
├── docs/
└── package.json             # npm workspaces root
```

## Dev Setup

```bash
npm install          # installs all workspace dependencies
npm run dev          # starts client (:3000) and server (:5000) concurrently
```

## Data Flow

The Vite dev server proxies `/api/*` requests to the Express server, so there are no CORS issues in development. In production, Express will serve the built `client/dist/` as static files.

## Routing

| Path             | Component         |
|------------------|-------------------|
| `/`              | Home (Dashboard)  |
| `/preproduction` | PreProduction     |
| `/production`    | Production        |
| `/postproduction`| PostProduction    |
| `/calendar`      | Calendar          |
| `/contacts`      | Contacts          |
| `/todo`          | Todo              |

## API Endpoints (v0.1.0 stubs)

| Method | Path                   | Description    |
|--------|------------------------|----------------|
| GET    | `/api/health`          | Health check   |
| GET    | `/api/preproduction`   | Module stub    |
| GET    | `/api/production`      | Module stub    |
| GET    | `/api/postproduction`  | Module stub    |
