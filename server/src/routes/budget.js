import { Router } from 'express'
import { db } from '../db/index.js'
import { budgetCategories, budgetLines, budgetTemplateCategories } from '../db/schema.js'
import { eq, asc } from 'drizzle-orm'
import { requireAdmin } from '../middleware/auth.js'

// mergeParams allows access to :projectId from parent router
const router = Router({ mergeParams: true })

const VALID_SECTIONS = ['above_the_line', 'below_the_line', 'post_production', 'other']

function getProjectId(req) {
  return parseInt(req.params.projectId)
}

// GET /api/projects/:projectId/budget
router.get('/', async (req, res) => {
  const projectId = getProjectId(req)
  const cats = await db.select().from(budgetCategories)
    .where(eq(budgetCategories.projectId, projectId))
    .orderBy(asc(budgetCategories.sortOrder))
  const lines = await db.select().from(budgetLines)
    .where(eq(budgetLines.projectId, projectId))
    .orderBy(asc(budgetLines.sortOrder))

  res.json(cats.map(cat => ({ ...cat, lines: lines.filter(l => l.categoryId === cat.id) })))
})

// POST /api/projects/:projectId/budget/seed
// Copies the current global template into this project's budget
router.post('/seed', requireAdmin, async (req, res) => {
  const projectId = getProjectId(req)
  const existing = await db.select().from(budgetCategories).where(eq(budgetCategories.projectId, projectId))
  if (existing.length > 0) return res.status(400).json({ error: 'Budget already has categories' })

  const template = await db.select().from(budgetTemplateCategories).orderBy(asc(budgetTemplateCategories.sortOrder))
  for (const t of template) {
    await db.insert(budgetCategories).values({ projectId, name: t.name, section: t.section, sortOrder: t.sortOrder })
  }

  const cats = await db.select().from(budgetCategories)
    .where(eq(budgetCategories.projectId, projectId))
    .orderBy(asc(budgetCategories.sortOrder))
  res.json(cats.map(cat => ({ ...cat, lines: [] })))
})

// POST /api/projects/:projectId/budget/categories
router.post('/categories', requireAdmin, async (req, res) => {
  const projectId = getProjectId(req)
  const { name, section } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  if (!VALID_SECTIONS.includes(section)) return res.status(400).json({ error: 'Invalid section' })

  const existing = await db.select().from(budgetCategories).where(eq(budgetCategories.projectId, projectId))
  const maxOrder = existing.filter(c => c.section === section).reduce((m, c) => Math.max(m, c.sortOrder), 0)

  await db.insert(budgetCategories).values({ projectId, name: name.trim(), section, sortOrder: maxOrder + 10 })

  const all = await db.select().from(budgetCategories)
    .where(eq(budgetCategories.projectId, projectId))
    .orderBy(asc(budgetCategories.sortOrder))
  res.status(201).json({ ...all[all.length - 1], lines: [] })
})

// PUT /api/projects/:projectId/budget/categories/:catId
router.put('/categories/:catId', requireAdmin, async (req, res) => {
  const projectId = getProjectId(req)
  const catId = parseInt(req.params.catId)
  const [cat] = await db.select().from(budgetCategories).where(eq(budgetCategories.id, catId))
  if (!cat || cat.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  const { name, section } = req.body
  const updates = {}
  if (name !== undefined) updates.name = name.trim()
  if (section !== undefined) {
    if (!VALID_SECTIONS.includes(section)) return res.status(400).json({ error: 'Invalid section' })
    updates.section = section
  }

  await db.update(budgetCategories).set(updates).where(eq(budgetCategories.id, catId))
  const [updated] = await db.select().from(budgetCategories).where(eq(budgetCategories.id, catId))
  res.json(updated)
})

// DELETE /api/projects/:projectId/budget/categories/:catId
router.delete('/categories/:catId', requireAdmin, async (req, res) => {
  const projectId = getProjectId(req)
  const catId = parseInt(req.params.catId)
  const [cat] = await db.select().from(budgetCategories).where(eq(budgetCategories.id, catId))
  if (!cat || cat.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  await db.delete(budgetLines).where(eq(budgetLines.categoryId, catId))
  await db.delete(budgetCategories).where(eq(budgetCategories.id, catId))
  res.json({ ok: true })
})

// POST /api/projects/:projectId/budget/lines
router.post('/lines', async (req, res) => {
  const projectId = getProjectId(req)
  const { categoryId } = req.body
  if (!categoryId) return res.status(400).json({ error: 'categoryId is required' })

  const [cat] = await db.select().from(budgetCategories).where(eq(budgetCategories.id, parseInt(categoryId)))
  if (!cat || cat.projectId !== projectId) return res.status(404).json({ error: 'Category not found' })

  const existing = await db.select().from(budgetLines).where(eq(budgetLines.categoryId, parseInt(categoryId)))
  const maxOrder = existing.reduce((m, l) => Math.max(m, l.sortOrder), 0)

  await db.insert(budgetLines).values({
    categoryId: parseInt(categoryId),
    projectId,
    description: 'New line',
    qty: 1,
    unit: 'flat',
    rate: 0,
    total: 0,
    sortOrder: maxOrder + 10,
  })

  const all = await db.select().from(budgetLines)
    .where(eq(budgetLines.categoryId, parseInt(categoryId)))
    .orderBy(asc(budgetLines.sortOrder))
  res.status(201).json(all[all.length - 1])
})

// PUT /api/projects/:projectId/budget/lines/:lineId
router.put('/lines/:lineId', async (req, res) => {
  const projectId = getProjectId(req)
  const lineId = parseInt(req.params.lineId)
  const [line] = await db.select().from(budgetLines).where(eq(budgetLines.id, lineId))
  if (!line || line.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  const { description, qty, unit, rate, notes } = req.body
  const updates = {}
  if (description !== undefined) updates.description = description.trim()
  if (unit !== undefined) updates.unit = unit
  if (notes !== undefined) updates.notes = notes?.trim() || null

  const newQty  = qty  !== undefined ? (parseFloat(qty)  || 0) : line.qty
  const newRate = rate !== undefined ? (parseFloat(rate) || 0) : line.rate
  if (qty  !== undefined) updates.qty  = newQty
  if (rate !== undefined) updates.rate = newRate
  if (qty !== undefined || rate !== undefined) updates.total = newQty * newRate

  await db.update(budgetLines).set(updates).where(eq(budgetLines.id, lineId))
  const [updated] = await db.select().from(budgetLines).where(eq(budgetLines.id, lineId))
  res.json(updated)
})

// DELETE /api/projects/:projectId/budget/lines/:lineId
router.delete('/lines/:lineId', async (req, res) => {
  const projectId = getProjectId(req)
  const lineId = parseInt(req.params.lineId)
  const [line] = await db.select().from(budgetLines).where(eq(budgetLines.id, lineId))
  if (!line || line.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  await db.delete(budgetLines).where(eq(budgetLines.id, lineId))
  res.json({ ok: true })
})

export default router
