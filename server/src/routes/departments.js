import { Router } from 'express'
import { db } from '../db/index.js'
import { departments } from '../db/schema.js'
import { eq, asc } from 'drizzle-orm'
import { requireAdmin } from '../middleware/auth.js'

const router = Router({ mergeParams: true })

const DEFAULT_DEPARTMENTS = [
  { name: 'Production Office', icon: '🎬', sortOrder: 10 },
  { name: 'Direction',         icon: '🎯', sortOrder: 20 },
  { name: 'Camera',            icon: '📷', sortOrder: 30 },
  { name: 'Lighting & Grip',   icon: '💡', sortOrder: 40 },
  { name: 'Sound',             icon: '🎙️', sortOrder: 50 },
  { name: 'Art Department',    icon: '🎨', sortOrder: 60 },
  { name: 'Props',             icon: '📦', sortOrder: 70 },
  { name: 'Costume & Wardrobe',icon: '👗', sortOrder: 80 },
  { name: 'Hair & Makeup',     icon: '💄', sortOrder: 90 },
  { name: 'Locations',         icon: '📍', sortOrder: 100 },
  { name: 'Transportation',    icon: '🚌', sortOrder: 110 },
  { name: 'Visual Effects',    icon: '✨', sortOrder: 120 },
  { name: 'Post Production',   icon: '🖥️', sortOrder: 130 },
  { name: 'Music',             icon: '🎵', sortOrder: 140 },
]

function getProjectId(req) {
  return parseInt(req.params.projectId)
}

router.get('/', async (req, res) => {
  const projectId = getProjectId(req)
  const rows = await db.select().from(departments)
    .where(eq(departments.projectId, projectId))
    .orderBy(asc(departments.sortOrder))
  res.json(rows)
})

router.post('/seed', requireAdmin, async (req, res) => {
  const projectId = getProjectId(req)
  const existing = await db.select().from(departments).where(eq(departments.projectId, projectId))
  if (existing.length > 0) return res.status(400).json({ error: 'Departments already set up' })

  for (const d of DEFAULT_DEPARTMENTS) {
    await db.insert(departments).values({ projectId, ...d })
  }

  const rows = await db.select().from(departments)
    .where(eq(departments.projectId, projectId))
    .orderBy(asc(departments.sortOrder))
  res.json(rows)
})

router.post('/', requireAdmin, async (req, res) => {
  const projectId = getProjectId(req)
  const { name, icon } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })

  const existing = await db.select().from(departments).where(eq(departments.projectId, projectId))
  const maxOrder = existing.reduce((m, d) => Math.max(m, d.sortOrder), 0)

  await db.insert(departments).values({ projectId, name: name.trim(), icon: icon?.trim() || '📁', sortOrder: maxOrder + 10 })

  const all = await db.select().from(departments).where(eq(departments.projectId, projectId)).orderBy(asc(departments.sortOrder))
  res.status(201).json(all[all.length - 1])
})

router.put('/:deptId', requireAdmin, async (req, res) => {
  const projectId = getProjectId(req)
  const deptId = parseInt(req.params.deptId)
  const [existing] = await db.select().from(departments).where(eq(departments.id, deptId))
  if (!existing || existing.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  const { name, icon, taskPermission } = req.body
  const updates = {}
  if (name !== undefined) updates.name = name.trim()
  if (icon !== undefined) updates.icon = icon.trim()
  if (taskPermission !== undefined) updates.taskPermission = taskPermission

  await db.update(departments).set(updates).where(eq(departments.id, deptId))
  const [updated] = await db.select().from(departments).where(eq(departments.id, deptId))
  res.json(updated)
})

router.delete('/:deptId', requireAdmin, async (req, res) => {
  const projectId = getProjectId(req)
  const deptId = parseInt(req.params.deptId)
  const [existing] = await db.select().from(departments).where(eq(departments.id, deptId))
  if (!existing || existing.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  await db.delete(departments).where(eq(departments.id, deptId))
  res.json({ ok: true })
})

export default router
export { DEFAULT_DEPARTMENTS }
