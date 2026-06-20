import { Router } from 'express'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { eq, asc, ne } from 'drizzle-orm'
import { requireAdmin } from '../middleware/auth.js'

const router = Router()

router.get('/', requireAdmin, async (_req, res) => {
  const all = await db.select({
    id: users.id,
    name: users.name,
    email: users.email,
    role: users.role,
    createdAt: users.createdAt,
  }).from(users).orderBy(asc(users.createdAt))
  res.json(all)
})

router.put('/:id/role', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id)
  const { role } = req.body

  if (!['admin', 'crew'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin or crew' })
  }
  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot change your own role' })
  }

  const [target] = await db.select().from(users).where(eq(users.id, id))
  if (!target) return res.status(404).json({ error: 'User not found' })

  if (target.role === 'admin' && role === 'crew') {
    const admins = await db.select().from(users).where(eq(users.role, 'admin'))
    if (admins.length <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last admin' })
    }
  }

  await db.update(users).set({ role }).where(eq(users.id, id))
  const [updated] = await db.select({
    id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt,
  }).from(users).where(eq(users.id, id))
  res.json(updated)
})

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id)

  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' })
  }

  const [target] = await db.select().from(users).where(eq(users.id, id))
  if (!target) return res.status(404).json({ error: 'User not found' })

  if (target.role === 'admin') {
    const admins = await db.select().from(users).where(eq(users.role, 'admin'))
    if (admins.length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin' })
    }
  }

  await db.delete(users).where(eq(users.id, id))
  res.json({ ok: true })
})

export default router
