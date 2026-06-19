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

export const db = drizzle(client, { schema })
