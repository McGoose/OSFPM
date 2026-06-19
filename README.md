# Open Source Film Production Manager

![Contributors](https://img.shields.io/github/contributors/McGoose/OSFPM)
![Issues](https://img.shields.io/github/issues/McGoose/OSFPM)
![Version](https://img.shields.io/badge/version-0.1.0-blue)

A self-hosted, web-based application for managing all phases of film production — from script breakdown to final delivery.

## Table of Contents

1. [Introduction](#introduction)
2. [Features](#features)
3. [Tech Stack](#tech-stack)
4. [Installation](#installation)
5. [Development](#development)
6. [Contributing](#contributing)
7. [License](#license)

---

## Introduction

OSFPM is a free, open-source alternative to expensive production management tools. It runs entirely on your own server — no subscriptions, no cloud lock-in, and no per-seat fees. Designed for indie productions, film schools, and anyone who wants full control over their production data.

---

## Features

### Pre-Production *(v0.2.0)*
- Script breakdown — scenes, characters, locations, props, costumes
- Budget tracker with local currency support
- Scheduling with calendar integration
- Department reports
- Crew management
- Meeting tracker

### Production *(v0.3.0)*
- Call sheet creation and distribution
- Dailies tracking (footage, metadata, backups)
- Filming reports
- Gear tracking
- Crew monitoring and schedule adherence

### Post-Production *(v0.4.0)*
- Review note management
- Media data organization and delivery scheduling
- Collaboration tools for editors and VFX supervisors

### Shared Tools *(v0.5.0)*
- Centralized calendar
- Contact book
- To-do lists


### Workspace Customization
- Custom accent color and organization branding
- Per-workspace currency and timezone settings

---

## Tech Stack

| Layer    | Technology                        |
|----------|-----------------------------------|
| Frontend | React 18, Vite 6, React Router v6 |
| Backend  | Node.js, Express 4                |
| Database | SQLite via better-sqlite3         |
| ORM      | Drizzle ORM                       |
| Auth     | JWT (httpOnly cookies), bcryptjs  |

---

## Installation

Requirements: [Node.js](https://nodejs.org/) v18+

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

Start the app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The first time you visit, you'll be guided through creating an admin account and configuring your workspace.

---

## Development

```
OSFPM/
├── client/          # React + Vite frontend
│   └── src/
│       ├── modules/ # Feature pages (Auth, Home, PreProduction, etc.)
│       ├── shared/  # Layout, Calendar, Contacts, Todo
│       └── context/ # AuthContext, SettingsContext
├── server/          # Express backend
│   └── src/
│       ├── db/      # SQLite schema and Drizzle setup
│       ├── middleware/
│       └── routes/
└── data/            # SQLite database file (gitignored)
```

Run both servers simultaneously:
```bash
npm run dev          # client :3000 + server :5000
```

See [docs/devs/Architecture.md](docs/devs/Architecture.md) for the full architecture reference.

---

## Contributing

Contributions are welcome.

1. Fork the repository
2. Create a branch: `git checkout -b feature/<name>`
3. Commit your changes: `git commit -m "Add <feature>"`
4. Push and open a pull request

Please follow existing code style and keep commits focused.

---

## License

TBD

---

## Contact

- **Email**: peter.berberih@gmail.com
- **Issues**: [GitHub Issues](https://github.com/McGoose/OSFPM/issues)

Happy filming! 🎬
