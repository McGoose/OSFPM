import { Router } from 'express'
import { db } from '../db/index.js'
import { coproducers } from '../db/schema.js'
import { eq, asc } from 'drizzle-orm'
import { requireAdmin } from '../middleware/auth.js'

const router = Router({ mergeParams: true })

function getProjectId(req) {
  return parseInt(req.params.projectId)
}

// GET /api/projects/:projectId/coproducers
router.get('/', async (req, res) => {
  const projectId = getProjectId(req)
  const rows = await db.select().from(coproducers)
    .where(eq(coproducers.projectId, projectId))
    .orderBy(asc(coproducers.sortOrder))
  res.json(rows)
})

// POST /api/projects/:projectId/coproducers
router.post('/', requireAdmin, async (req, res) => {
  const projectId = getProjectId(req)
  const { name, sharePercent, notes } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })

  const existing = await db.select().from(coproducers).where(eq(coproducers.projectId, projectId))
  const maxOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder), 0)

  await db.insert(coproducers).values({
    projectId,
    name: name.trim(),
    sharePercent: parseFloat(sharePercent) || 0,
    notes: notes?.trim() || null,
    sortOrder: maxOrder + 10,
  })

  const all = await db.select().from(coproducers)
    .where(eq(coproducers.projectId, projectId))
    .orderBy(asc(coproducers.sortOrder))
  res.status(201).json(all[all.length - 1])
})

// PUT /api/projects/:projectId/coproducers/:id
router.put('/:id', requireAdmin, async (req, res) => {
  const projectId = getProjectId(req)
  const id = parseInt(req.params.id)
  const [existing] = await db.select().from(coproducers).where(eq(coproducers.id, id))
  if (!existing || existing.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  const { name, sharePercent, notes } = req.body
  const updates = {}
  if (name !== undefined) updates.name = name.trim()
  if (sharePercent !== undefined) updates.sharePercent = parseFloat(sharePercent) || 0
  if (notes !== undefined) updates.notes = notes?.trim() || null

  await db.update(coproducers).set(updates).where(eq(coproducers.id, id))
  const [updated] = await db.select().from(coproducers).where(eq(coproducers.id, id))
  res.json(updated)
})

// DELETE /api/projects/:projectId/coproducers/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  const projectId = getProjectId(req)
  const id = parseInt(req.params.id)
  const [existing] = await db.select().from(coproducers).where(eq(coproducers.id, id))
  if (!existing || existing.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  await db.delete(coproducers).where(eq(coproducers.id, id))
  res.json({ ok: true })
})

export default router
