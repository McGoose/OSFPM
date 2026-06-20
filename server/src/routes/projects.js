import { Router } from 'express'
import { db } from '../db/index.js'
import { projects } from '../db/schema.js'
import { eq, desc } from 'drizzle-orm'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

const VALID_STATUSES = ['development', 'pre-production', 'production', 'post-production', 'completed']

router.get('/', requireAuth, async (_req, res) => {
  const all = await db.select().from(projects).orderBy(desc(projects.createdAt))
  res.json(all)
})

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { title, genre, format, status, description } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' })
  }

  await db.insert(projects).values({
    title: title.trim(),
    genre: genre?.trim() || null,
    format: format?.trim() || null,
    status: status || 'development',
    description: description?.trim() || null,
    createdBy: req.user.id,
    createdAt: new Date(),
  })

  const all = await db.select().from(projects).orderBy(desc(projects.createdAt))
  res.status(201).json(all[0])
})

router.get('/:id', requireAuth, async (req, res) => {
  const [project] = await db.select().from(projects).where(eq(projects.id, parseInt(req.params.id)))
  if (!project) return res.status(404).json({ error: 'Project not found' })
  res.json(project)
})

router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id)
  const [existing] = await db.select().from(projects).where(eq(projects.id, id))
  if (!existing) return res.status(404).json({ error: 'Project not found' })

  const { title, genre, format, status, description } = req.body
  if (title !== undefined && !title?.trim()) return res.status(400).json({ error: 'Title is required' })
  if (status && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' })

  await db.update(projects).set({
    ...(title !== undefined && { title: title.trim() }),
    ...(genre !== undefined && { genre: genre?.trim() || null }),
    ...(format !== undefined && { format: format?.trim() || null }),
    ...(status !== undefined && { status }),
    ...(description !== undefined && { description: description?.trim() || null }),
  }).where(eq(projects.id, id))

  const [updated] = await db.select().from(projects).where(eq(projects.id, id))
  res.json(updated)
})

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id)
  const [existing] = await db.select().from(projects).where(eq(projects.id, id))
  if (!existing) return res.status(404).json({ error: 'Project not found' })

  await db.delete(projects).where(eq(projects.id, id))
  res.json({ ok: true })
})

export default router
