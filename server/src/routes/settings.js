import { Router } from 'express'
import { db } from '../db/index.js'
import { settings } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

const PUBLIC_KEYS = ['org_name', 'accent_color', 'currency']
const ALL_KEYS = ['org_name', 'currency', 'timezone', 'accent_color']

export const DEFAULTS = {
  org_name: 'My Production',
  currency: 'USD',
  timezone: 'UTC',
  accent_color: '#e8a100',
}

async function getAllSettings() {
  const rows = await db.select().from(settings)
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))
  return Object.fromEntries(ALL_KEYS.map(k => [k, map[k] ?? DEFAULTS[k]]))
}

router.get('/public', async (_req, res) => {
  const all = await getAllSettings()
  res.json(Object.fromEntries(PUBLIC_KEYS.map(k => [k, all[k]])))
})

router.get('/', requireAuth, requireAdmin, async (_req, res) => {
  res.json(await getAllSettings())
})

router.put('/', requireAuth, requireAdmin, async (req, res) => {
  for (const key of ALL_KEYS) {
    if (req.body[key] !== undefined) {
      const existing = await db.select().from(settings).where(eq(settings.key, key))
      if (existing.length > 0) {
        await db.update(settings).set({ value: req.body[key] }).where(eq(settings.key, key))
      } else {
        await db.insert(settings).values({ key, value: req.body[key] })
      }
    }
  }
  res.json(await getAllSettings())
})

export async function initSettings(initial) {
  for (const [key, value] of Object.entries(initial)) {
    const existing = await db.select().from(settings).where(eq(settings.key, key))
    if (existing.length === 0) await db.insert(settings).values({ key, value })
  }
}

export default router
