# Open Source Film Production Manager

![Version](https://img.shields.io/badge/version-0.2.x-blue)
![License](https://img.shields.io/badge/license-MIT-green)

A self-hosted, web-based application for managing all phases of film production — from script breakdown to final delivery. No subscriptions, no cloud lock-in, no per-seat fees.

---

## What's live

### App-level
- Auth — login, first-run setup, JWT (httpOnly cookies), 7-day sessions
- Role-based access control (`admin` / `crew`)
- User management (admin CRUD)
- Settings — org name, accent color, currency, timezone

### Project tools
| Tool | Description |
|---|---|
| **Script** | Multi-version script management — scriptments, drafts, shooting scripts with DGA revision colours; send to Breakdown |
| **Money** | Budget planning (categories + lines), invoice tracker, co-production splits, funding tracker |
| **Crew & Cast** | Full roster with roles, departments, character names, status |
| **Calendar** | Project calendar — events, shoot days, attendees |
| **Call Sheet** | Per-shoot-day multi-tab form + PDF download |
| **Script Breakdown** | Scene list, per-scene element tagging (cast, props, vehicles, etc.), annotation view |
| **Reports** | Sound report (MixPre CSV import), camera report (per-take log), daily progress report — one set per shoot day |
| **To-Do** | Personal + per-department task lists with permission control |
| **Meetings** | Meeting notes per project |

### Department workspaces
Each department has its own workspace with department-level tools.

### Mobile
Fully responsive — sidebar becomes a slide-in drawer on phones, all grids and tables adapt to small screens.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite 6, React Router v6 |
| Backend | Node.js + Express 4 (ES modules) |
| Database | SQLite via `@libsql/client`, Drizzle ORM v0.45.2 |
| Auth | JWT in HttpOnly cookies, bcryptjs |
| PDF | `@react-pdf/renderer` (client-side) |

---

## Quick start

**Requirements:** Node.js 18+, npm 9+

```bash
git clone https://github.com/McGoose/OSFPM.git
cd OSFPM
npm install
```

Create `server/.env`:

```env
PORT=5000
NODE_ENV=development
JWT_SECRET=your-secret-here
CLIENT_URL=http://localhost:3000
```

```bash
npm run dev    # client :3000  +  server :5000
```

Open [http://localhost:3000](http://localhost:3000). The first visit takes you to the Setup page to create your admin account.

### Seed demo data

```bash
cd server
node seed.js
```

Seeds *The Last Withdrawal* — a retired-pensioner heist comedy — with 20 fully written scenes, breakdown elements, cast, crew, and shoot days. Safe to re-run; deletes and recreates the project each time.

---

## Project structure

```
OSFPM/
├── client/            # React + Vite frontend
│   └── src/
│       ├── App.jsx        # All routes
│       ├── tools.js       # Central tool registry (single source of truth)
│       └── modules/       # One directory per feature
├── server/            # Express API
│   ├── src/
│   │   ├── db/schema.js   # Drizzle ORM table definitions
│   │   ├── db/index.js    # DB init + migrations
│   │   └── routes/        # One file per resource
│   └── seed.js            # Demo data seeder
├── docs/
│   ├── user/User_guide.md
│   ├── devs/Architecture.md
│   └── features/
├── data/              # SQLite database (git-ignored)
│   └── osfpm.db
├── README.md
├── ROADMAP.md
└── CHANGELOG.md
```

---

## Docs

- [User Guide](docs/user/User_guide.md)
- [Architecture](docs/devs/Architecture.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)

---

## Contributing

1. Fork the repo
2. Create a branch: `git checkout -b feature/<name>`
3. Commit: `git commit -m "Add <feature>"`
4. Push and open a pull request

Follow existing code style. Keep commits focused.

---

## Contact

- **Email**: peter.berberih@gmail.com
- **Issues**: [GitHub Issues](https://github.com/McGoose/OSFPM/issues)

---

## License

MIT — Happy filming!
