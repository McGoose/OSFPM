import { Router } from 'express'
import { db } from '../db/index.js'
import { fundingSources } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth.js'

const router = Router({ mergeParams: true })

router.get('/', requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId)
  const rows = await db.select().from(fundingSources)
    .where(eq(fundingSources.projectId, projectId))
  res.json(rows)
})

router.post('/', requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId)
  const { type = 'other', name = '', expectedAmount = 0, receivedAmount = 0, notes = '', coProducerId = null } = req.body
  const now = new Date()
  const rows = await db.insert(fundingSources).values({
    projectId,
    type,
    name,
    expectedAmount: parseFloat(expectedAmount) || 0,
    receivedAmount: parseFloat(receivedAmount) || 0,
    notes: notes ?? '',
    coProducerId: coProducerId ? Number(coProducerId) : null,
    sortOrder: 0,
    createdAt: now,
  })
  const created = await db.select().from(fundingSources)
    .where(and(eq(fundingSources.projectId, projectId), eq(fundingSources.name, name)))
  res.status(201).json(created[created.length - 1])
})

router.put('/:id', requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId)
  const id = Number(req.params.id)
  const allowed = ['type', 'name', 'expectedAmount', 'receivedAmount', 'notes', 'coProducerId']
  const updates = {}
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === 'expectedAmount' || key === 'receivedAmount') updates[key] = parseFloat(req.body[key]) || 0
      else if (key === 'coProducerId') updates[key] = req.body[key] ? Number(req.body[key]) : null
      else updates[key] = req.body[key]
    }
  }
  await db.update(fundingSources).set(updates)
    .where(and(eq(fundingSources.id, id), eq(fundingSources.projectId, projectId)))
  const [row] = await db.select().from(fundingSources).where(eq(fundingSources.id, id))
  res.json(row)
})

router.delete('/:id', requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId)
  const id = Number(req.params.id)
  await db.delete(fundingSources)
    .where(and(eq(fundingSources.id, id), eq(fundingSources.projectId, projectId)))
  res.json({ ok: true })
})

export default router
