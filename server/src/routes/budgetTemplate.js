import { Router } from 'express'
import { db } from '../db/index.js'
import { budgetTemplateCategories } from '../db/schema.js'
import { eq, asc } from 'drizzle-orm'
import { requireAdmin } from '../middleware/auth.js'

const router = Router()

const VALID_SECTIONS = ['above_the_line', 'below_the_line', 'post_production', 'other']

router.get('/', requireAdmin, async (_req, res) => {
  const cats = await db.select().from(budgetTemplateCategories).orderBy(asc(budgetTemplateCategories.sortOrder))
  res.json(cats)
})

router.post('/', requireAdmin, async (req, res) => {
  const { name, section } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  if (!VALID_SECTIONS.includes(section)) return res.status(400).json({ error: 'Invalid section' })

  const existing = await db.select().from(budgetTemplateCategories)
  const maxOrder = existing.filter(c => c.section === section).reduce((m, c) => Math.max(m, c.sortOrder), 0)

  await db.insert(budgetTemplateCategories).values({ name: name.trim(), section, sortOrder: maxOrder + 10 })

  const all = await db.select().from(budgetTemplateCategories).orderBy(asc(budgetTemplateCategories.sortOrder))
  res.status(201).json(all[all.length - 1])
})

router.put('/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id)
  const [existing] = await db.select().from(budgetTemplateCategories).where(eq(budgetTemplateCategories.id, id))
  if (!existing) return res.status(404).json({ error: 'Not found' })

  const { name, section } = req.body
  const updates = {}
  if (name !== undefined) updates.name = name.trim()
  if (section !== undefined) {
    if (!VALID_SECTIONS.includes(section)) return res.status(400).json({ error: 'Invalid section' })
    updates.section = section
  }

  await db.update(budgetTemplateCategories).set(updates).where(eq(budgetTemplateCategories.id, id))
  const [updated] = await db.select().from(budgetTemplateCategories).where(eq(budgetTemplateCategories.id, id))
  res.json(updated)
})

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id)
  const [existing] = await db.select().from(budgetTemplateCategories).where(eq(budgetTemplateCategories.id, id))
  if (!existing) return res.status(404).json({ error: 'Not found' })

  await db.delete(budgetTemplateCategories).where(eq(budgetTemplateCategories.id, id))
  res.json({ ok: true })
})

export default router
