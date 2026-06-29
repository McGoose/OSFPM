import { Router } from 'express'
import { db } from '../db/index.js'
import { scenes, breakdownElements } from '../db/schema.js'
import { eq, asc } from 'drizzle-orm'
import { requireAdmin } from '../middleware/auth.js'

const router = Router({ mergeParams: true })

function pid(req) { return parseInt(req.params.projectId) }

// GET /api/projects/:projectId/breakdown
// Returns all scenes with nested elements
router.get('/', async (req, res) => {
  const projectId = pid(req)
  const sceneRows = await db.select().from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.sortOrder))
  const elementRows = await db.select().from(breakdownElements)
    .where(eq(breakdownElements.projectId, projectId))
    .orderBy(asc(breakdownElements.sortOrder))

  res.json(sceneRows.map(s => ({
    ...s,
    elements: elementRows.filter(e => e.sceneId === s.id),
  })))
})

// POST /api/projects/:projectId/breakdown/scenes
router.post('/scenes', requireAdmin, async (req, res) => {
  const projectId = pid(req)
  const { sceneNumber, intExt, location, timeOfDay, description, pages } = req.body
  if (!sceneNumber?.trim()) return res.status(400).json({ error: 'Scene number is required' })

  const existing = await db.select().from(scenes).where(eq(scenes.projectId, projectId))
  const maxOrder = existing.reduce((m, s) => Math.max(m, s.sortOrder), 0)

  await db.insert(scenes).values({
    projectId,
    sceneNumber: sceneNumber.trim(),
    intExt: intExt ?? 'INT',
    location: location?.trim() ?? '',
    timeOfDay: timeOfDay ?? 'DAY',
    description: description?.trim() ?? '',
    pages: parseFloat(pages) || 1,
    sortOrder: maxOrder + 10,
  })

  const all = await db.select().from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.sortOrder))
  res.status(201).json({ ...all[all.length - 1], elements: [] })
})

// PUT /api/projects/:projectId/breakdown/scenes/:sceneId
router.put('/scenes/:sceneId', requireAdmin, async (req, res) => {
  const projectId = pid(req)
  const sceneId = parseInt(req.params.sceneId)
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId))
  if (!scene || scene.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  const { sceneNumber, intExt, location, timeOfDay, description, content, pages } = req.body
  const updates = {}
  if (sceneNumber !== undefined) updates.sceneNumber = sceneNumber.trim()
  if (intExt !== undefined) updates.intExt = intExt
  if (location !== undefined) updates.location = location.trim()
  if (timeOfDay !== undefined) updates.timeOfDay = timeOfDay
  if (description !== undefined) updates.description = description.trim()
  if (content !== undefined) updates.content = content
  if (pages !== undefined) updates.pages = parseFloat(pages) || 1

  await db.update(scenes).set(updates).where(eq(scenes.id, sceneId))
  const [updated] = await db.select().from(scenes).where(eq(scenes.id, sceneId))
  res.json(updated)
})

// DELETE /api/projects/:projectId/breakdown/scenes/:sceneId
router.delete('/scenes/:sceneId', requireAdmin, async (req, res) => {
  const projectId = pid(req)
  const sceneId = parseInt(req.params.sceneId)
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId))
  if (!scene || scene.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  await db.delete(breakdownElements).where(eq(breakdownElements.sceneId, sceneId))
  await db.delete(scenes).where(eq(scenes.id, sceneId))
  res.json({ ok: true })
})

// POST /api/projects/:projectId/breakdown/elements
router.post('/elements', async (req, res) => {
  const projectId = pid(req)
  const { sceneId, category, description } = req.body
  if (!sceneId || !category?.trim() || !description?.trim()) {
    return res.status(400).json({ error: 'sceneId, category, and description are required' })
  }

  const [scene] = await db.select().from(scenes).where(eq(scenes.id, parseInt(sceneId)))
  if (!scene || scene.projectId !== projectId) return res.status(404).json({ error: 'Scene not found' })

  const existing = await db.select().from(breakdownElements)
    .where(eq(breakdownElements.sceneId, parseInt(sceneId)))
  const maxOrder = existing.filter(e => e.category === category).reduce((m, e) => Math.max(m, e.sortOrder), 0)

  await db.insert(breakdownElements).values({
    sceneId: parseInt(sceneId),
    projectId,
    category: category.trim(),
    description: description.trim(),
    sortOrder: maxOrder + 10,
  })

  const all = await db.select().from(breakdownElements)
    .where(eq(breakdownElements.sceneId, parseInt(sceneId)))
    .orderBy(asc(breakdownElements.sortOrder))
  res.status(201).json(all[all.length - 1])
})

// PUT /api/projects/:projectId/breakdown/elements/:elementId
router.put('/elements/:elementId', async (req, res) => {
  const projectId = pid(req)
  const elementId = parseInt(req.params.elementId)
  const [element] = await db.select().from(breakdownElements).where(eq(breakdownElements.id, elementId))
  if (!element || element.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  const { description, notes } = req.body
  const updates = {}
  if (description !== undefined) updates.description = description.trim()
  if (notes !== undefined) updates.notes = notes?.trim() || null

  await db.update(breakdownElements).set(updates).where(eq(breakdownElements.id, elementId))
  const [updated] = await db.select().from(breakdownElements).where(eq(breakdownElements.id, elementId))
  res.json(updated)
})

// DELETE /api/projects/:projectId/breakdown/elements/:elementId
router.delete('/elements/:elementId', async (req, res) => {
  const projectId = pid(req)
  const elementId = parseInt(req.params.elementId)
  const [element] = await db.select().from(breakdownElements).where(eq(breakdownElements.id, elementId))
  if (!element || element.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  await db.delete(breakdownElements).where(eq(breakdownElements.id, elementId))
  res.json({ ok: true })
})

export default router
