import { Router } from 'express'
import { db } from '../db/index.js'
import { invoices, budgetLines } from '../db/schema.js'
import { eq, asc } from 'drizzle-orm'
import { requireAdmin } from '../middleware/auth.js'

const router = Router({ mergeParams: true })

const VALID_STATUSES = ['pending', 'approved', 'paid', 'rejected']

function getProjectId(req) {
  return parseInt(req.params.projectId)
}

// GET /api/projects/:projectId/invoices
router.get('/', async (req, res) => {
  const projectId = getProjectId(req)
  const rows = await db.select().from(invoices)
    .where(eq(invoices.projectId, projectId))
    .orderBy(asc(invoices.createdAt))
  res.json(rows)
})

// POST /api/projects/:projectId/invoices
router.post('/', async (req, res) => {
  const projectId = getProjectId(req)
  const { vendor, invoiceNumber, invoiceDate, amount, status, description, notes, budgetLineId } = req.body

  if (amount === undefined || amount === '') return res.status(400).json({ error: 'Amount is required' })
  if (status && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' })

  // Validate budget line belongs to this project
  if (budgetLineId) {
    const [bl] = await db.select().from(budgetLines).where(eq(budgetLines.id, parseInt(budgetLineId)))
    if (!bl || bl.projectId !== projectId) return res.status(400).json({ error: 'Invalid budget line' })
  }

  await db.insert(invoices).values({
    projectId,
    budgetLineId: budgetLineId ? parseInt(budgetLineId) : null,
    vendor: vendor?.trim() || '',
    invoiceNumber: invoiceNumber?.trim() || '',
    invoiceDate: invoiceDate?.trim() || '',
    amount: parseFloat(amount) || 0,
    status: status || 'pending',
    description: description?.trim() || '',
    notes: notes?.trim() || null,
    createdAt: new Date(),
  })

  const all = await db.select().from(invoices)
    .where(eq(invoices.projectId, projectId))
    .orderBy(asc(invoices.createdAt))
  res.status(201).json(all[all.length - 1])
})

// PUT /api/projects/:projectId/invoices/:id
router.put('/:id', async (req, res) => {
  const projectId = getProjectId(req)
  const id = parseInt(req.params.id)
  const [existing] = await db.select().from(invoices).where(eq(invoices.id, id))
  if (!existing || existing.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  const { vendor, invoiceNumber, invoiceDate, amount, status, description, notes, budgetLineId } = req.body
  const updates = {}

  if (vendor !== undefined) updates.vendor = vendor.trim()
  if (invoiceNumber !== undefined) updates.invoiceNumber = invoiceNumber.trim()
  if (invoiceDate !== undefined) updates.invoiceDate = invoiceDate.trim()
  if (amount !== undefined) updates.amount = parseFloat(amount) || 0
  if (description !== undefined) updates.description = description.trim()
  if (notes !== undefined) updates.notes = notes?.trim() || null
  if (status !== undefined) {
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' })
    updates.status = status
  }
  if (budgetLineId !== undefined) {
    if (budgetLineId === null || budgetLineId === '') {
      updates.budgetLineId = null
    } else {
      const [bl] = await db.select().from(budgetLines).where(eq(budgetLines.id, parseInt(budgetLineId)))
      if (!bl || bl.projectId !== projectId) return res.status(400).json({ error: 'Invalid budget line' })
      updates.budgetLineId = parseInt(budgetLineId)
    }
  }

  await db.update(invoices).set(updates).where(eq(invoices.id, id))
  const [updated] = await db.select().from(invoices).where(eq(invoices.id, id))
  res.json(updated)
})

// DELETE /api/projects/:projectId/invoices/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  const projectId = getProjectId(req)
  const id = parseInt(req.params.id)
  const [existing] = await db.select().from(invoices).where(eq(invoices.id, id))
  if (!existing || existing.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  await db.delete(invoices).where(eq(invoices.id, id))
  res.json({ ok: true })
})

export default router
