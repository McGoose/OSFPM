import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema.js'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '../../../data')

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const client = createClient({
  url: `file:${path.join(dataDir, 'osfpm.db')}`,
})

await client.execute('PRAGMA journal_mode = WAL')

await client.execute(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'crew',
    created_at INTEGER NOT NULL
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    genre TEXT,
    format TEXT,
    status TEXT NOT NULL DEFAULT 'development',
    description TEXT,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '📁',
    sort_order INTEGER NOT NULL DEFAULT 0
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS coproducers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    share_percent REAL NOT NULL DEFAULT 0,
    notes TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS budget_template_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT 'below_the_line',
    sort_order INTEGER NOT NULL DEFAULT 0
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS budget_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT 'below_the_line',
    sort_order INTEGER NOT NULL DEFAULT 0
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS budget_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    qty REAL NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT 'flat',
    rate REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    notes TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  )
`)

// Migrate older budget_lines tables that pre-date the qty/unit/rate columns
const tryAlter = async (sql) => { try { await client.execute(sql) } catch {} }
await tryAlter("ALTER TABLE budget_lines ADD COLUMN qty   REAL NOT NULL DEFAULT 1")
await tryAlter("ALTER TABLE budget_lines ADD COLUMN unit  TEXT NOT NULL DEFAULT 'flat'")
await tryAlter("ALTER TABLE budget_lines ADD COLUMN rate  REAL NOT NULL DEFAULT 0")
await tryAlter("ALTER TABLE budget_lines ADD COLUMN total REAL NOT NULL DEFAULT 0")

await client.execute(`
  CREATE TABLE IF NOT EXISTS funding_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'other',
    name TEXT NOT NULL DEFAULT '',
    expected_amount REAL NOT NULL DEFAULT 0,
    received_amount REAL NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    co_producer_id INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    budget_line_id INTEGER,
    vendor TEXT NOT NULL DEFAULT '',
    invoice_number TEXT DEFAULT '',
    invoice_date TEXT DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    description TEXT DEFAULT '',
    notes TEXT,
    created_at INTEGER NOT NULL
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS crew_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'crew',
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    character_name TEXT DEFAULT '',
    department_id INTEGER,
    agent_name TEXT DEFAULT '',
    agent_email TEXT DEFAULT '',
    agent_phone TEXT DEFAULT '',
    emergency_name TEXT DEFAULT '',
    emergency_phone TEXT DEFAULT '',
    emergency_relation TEXT DEFAULT '',
    start_date TEXT DEFAULT '',
    end_date TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    user_id INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`)

await tryAlter("ALTER TABLE crew_members ADD COLUMN pronouns TEXT DEFAULT ''")
await tryAlter("ALTER TABLE crew_members ADD COLUMN dietary_needs TEXT DEFAULT ''")
await tryAlter("ALTER TABLE crew_members ADD COLUMN medical_needs TEXT DEFAULT ''")
await tryAlter("ALTER TABLE crew_members ADD COLUMN accessibility_needs TEXT DEFAULT ''")
await tryAlter("ALTER TABLE crew_members ADD COLUMN onboarding_token TEXT")
await tryAlter("ALTER TABLE crew_members ADD COLUMN onboarding_token_expires INTEGER")
await tryAlter("ALTER TABLE crew_members ADD COLUMN onboarding_completed_at INTEGER")

await client.execute(`
  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    filename TEXT NOT NULL DEFAULT '',
    raw_content TEXT NOT NULL DEFAULT '',
    uploaded_at INTEGER NOT NULL
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    scene_number TEXT NOT NULL,
    int_ext TEXT NOT NULL DEFAULT 'INT',
    location TEXT NOT NULL DEFAULT '',
    time_of_day TEXT NOT NULL DEFAULT 'DAY',
    description TEXT NOT NULL DEFAULT '',
    pages REAL NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  )
`)

await tryAlter("ALTER TABLE scenes ADD COLUMN content TEXT DEFAULT ''")

await client.execute(`
  CREATE TABLE IF NOT EXISTS breakdown_elements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    start_time TEXT NOT NULL DEFAULT '09:00',
    end_time TEXT NOT NULL DEFAULT '17:00',
    location TEXT DEFAULT '',
    location_type TEXT DEFAULT 'in_person',
    notes TEXT DEFAULT '',
    slot_duration_minutes INTEGER,
    break_after_slots INTEGER,
    break_duration_minutes INTEGER,
    created_at INTEGER NOT NULL
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS event_attendees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    member_id INTEGER,
    department_id INTEGER
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS event_scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    scene_id INTEGER NOT NULL
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS potential_actors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    role TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    availability_token TEXT,
    availability_token_expires INTEGER,
    availability_submitted_at INTEGER,
    created_at INTEGER NOT NULL
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS actor_event_availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    available INTEGER NOT NULL DEFAULT 1
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS casting_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    actor_id INTEGER,
    is_break INTEGER NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  )
`)

await client.execute(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    user_id INTEGER,
    department_id INTEGER,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    priority TEXT DEFAULT 'medium',
    due_date TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`)

await tryAlter("ALTER TABLE departments ADD COLUMN task_permission TEXT DEFAULT 'all'")

await client.execute(`
  CREATE TABLE IF NOT EXISTS call_sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL UNIQUE,
    project_id INTEGER NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  )
`)

// Auto-seed global budget template if empty
const { rows } = await client.execute('SELECT COUNT(*) as count FROM budget_template_categories')
if (Number(rows[0].count) === 0) {
  const defaults = [
    // Above-the-Line
    ['Story, Rights & Continuity', 'above_the_line', 10],
    ['Producers Unit', 'above_the_line', 20],
    ['Director', 'above_the_line', 30],
    ['Cast', 'above_the_line', 40],
    ['Stunts', 'above_the_line', 50],
    ['ATL Travel & Living', 'above_the_line', 60],
    // Below-the-Line
    ['Production Staff', 'below_the_line', 10],
    ['Extra Talent', 'below_the_line', 20],
    ['Set Design', 'below_the_line', 30],
    ['Set Construction', 'below_the_line', 40],
    ['Set Striking', 'below_the_line', 50],
    ['Set Operations', 'below_the_line', 60],
    ['Special Effects', 'below_the_line', 70],
    ['Set Dressing', 'below_the_line', 80],
    ['Property', 'below_the_line', 90],
    ['Wardrobe', 'below_the_line', 100],
    ['Picture Vehicles', 'below_the_line', 110],
    ['Makeup & Hairdressing', 'below_the_line', 120],
    ['Lighting', 'below_the_line', 130],
    ['Camera', 'below_the_line', 140],
    ['Production Sound', 'below_the_line', 150],
    ['Transportation', 'below_the_line', 160],
    ['Location', 'below_the_line', 170],
    ['Production Film & Lab', 'below_the_line', 180],
    ['BTL Travel & Living', 'below_the_line', 190],
    ['Facilities', 'below_the_line', 200],
    ['Animals', 'below_the_line', 210],
    ['Second Unit', 'below_the_line', 220],
    // Post Production
    ['Post Production Staff & Facilities', 'post_production', 10],
    ['Editing', 'post_production', 20],
    ['Music', 'post_production', 30],
    ['Sound Post Production', 'post_production', 40],
    ['Visual Effects', 'post_production', 50],
    ['Picture Post Production', 'post_production', 60],
    ['Titles', 'post_production', 70],
    ['Stock Footage', 'post_production', 80],
    ['Post Travel & Living', 'post_production', 90],
    // Other
    ['Tests', 'other', 10],
    ['Publicity', 'other', 20],
    ['Insurance', 'other', 30],
    ['General Expense', 'other', 40],
    ['Contingency', 'other', 50],
  ]
  for (const [name, section, sortOrder] of defaults) {
    await client.execute({
      sql: 'INSERT INTO budget_template_categories (name, section, sort_order) VALUES (?, ?, ?)',
      args: [name, section, sortOrder],
    })
  }
}

export const db = drizzle(client, { schema })
