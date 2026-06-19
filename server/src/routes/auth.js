import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { initSettings, DEFAULTS } from './settings.js'

const router = Router()

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  secure: process.env.NODE_ENV === 'production',
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' },
  )
}

router.get('/status', async (_req, res) => {
  const all = await db.select().from(users)
  res.json({ hasUsers: all.length > 0 })
})

router.post('/register', async (req, res) => {
  const { name, email, password, orgName, currency, timezone } = req.body
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' })
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }

  const existing = await db.select().from(users).where(eq(users.email, email))
  if (existing.length > 0) return res.status(409).json({ error: 'Email already in use' })

  const allUsers = await db.select().from(users)
  const role = allUsers.length === 0 ? 'admin' : 'crew'
  const passwordHash = await bcrypt.hash(password, 12)

  await db.insert(users).values({ name, email, passwordHash, role, createdAt: new Date() })

  if (role === 'admin') {
    await initSettings({
      org_name: orgName || DEFAULTS.org_name,
      currency: currency || DEFAULTS.currency,
      timezone: timezone || DEFAULTS.timezone,
      accent_color: DEFAULTS.accent_color,
    })
  }

  const [user] = await db.select().from(users).where(eq(users.email, email))

  res.cookie('token', signToken(user), COOKIE_OPTS)
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } })
})

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' })
  }

  const [user] = await db.select().from(users).where(eq(users.email, email))
  if (!user) return res.status(401).json({ error: 'Invalid credentials' })

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

  res.cookie('token', signToken(user), COOKIE_OPTS)
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } })
})

router.post('/logout', (_req, res) => {
  res.clearCookie('token')
  res.json({ ok: true })
})

router.get('/me', (req, res) => {
  const token = req.cookies?.token
  if (!token) return res.status(401).json({ error: 'Not authenticated' })
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET)
    res.json({ user })
  } catch {
    res.status(401).json({ error: 'Invalid session' })
  }
})

export default router
