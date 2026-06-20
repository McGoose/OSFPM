import { Router } from 'express'
import crypto from 'crypto'
import { db } from '../db/index.js'
import { crewMembers, projects } from '../db/schema.js'
import { eq, asc } from 'drizzle-orm'
import { requireAdmin } from '../middleware/auth.js'
import { sendOnboardingEmail, emailConfigured } from '../utils/email.js'

const router = Router({ mergeParams: true })

const UPDATABLE = [
  'type', 'name', 'email', 'phone', 'role', 'characterName', 'departmentId',
  'pronouns', 'dietaryNeeds', 'medicalNeeds', 'accessibilityNeeds',
  'agentName', 'agentEmail', 'agentPhone',
  'emergencyName', 'emergencyPhone', 'emergencyRelation',
  'startDate', 'endDate', 'notes', 'status',
]

function pid(req) { return parseInt(req.params.projectId) }

function clean(fields, body) {
  const updates = {}
  for (const f of fields) {
    if (body[f] === undefined) continue
    if (f === 'departmentId') {
      updates[f] = body[f] ? parseInt(body[f]) : null
    } else {
      updates[f] = typeof body[f] === 'string' ? body[f].trim() : body[f]
    }
  }
  return updates
}

// GET /api/projects/:projectId/crew
router.get('/', async (req, res) => {
  const projectId = pid(req)
  const members = await db.select().from(crewMembers)
    .where(eq(crewMembers.projectId, projectId))
    .orderBy(asc(crewMembers.sortOrder), asc(crewMembers.createdAt))
  res.json(members)
})

// POST /api/projects/:projectId/crew
router.post('/', async (req, res) => {
  const projectId = pid(req)
  const { name, type, email, phone, role, characterName, departmentId, status } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })

  const existing = await db.select().from(crewMembers).where(eq(crewMembers.projectId, projectId))
  const maxOrder = existing.reduce((m, c) => Math.max(m, c.sortOrder), 0)

  await db.insert(crewMembers).values({
    projectId,
    type: type ?? 'crew',
    name: name.trim(),
    email: email?.trim() ?? '',
    phone: phone?.trim() ?? '',
    role: role?.trim() ?? '',
    characterName: characterName?.trim() ?? '',
    departmentId: departmentId ? parseInt(departmentId) : null,
    status: status ?? 'pending',
    sortOrder: maxOrder + 10,
    createdAt: new Date(),
  })

  const all = await db.select().from(crewMembers)
    .where(eq(crewMembers.projectId, projectId))
    .orderBy(asc(crewMembers.sortOrder), asc(crewMembers.createdAt))
  res.status(201).json(all[all.length - 1])
})

// GET /api/projects/:projectId/crew/:memberId
router.get('/:memberId', async (req, res) => {
  const projectId = pid(req)
  const memberId = parseInt(req.params.memberId)
  const [member] = await db.select().from(crewMembers).where(eq(crewMembers.id, memberId))
  if (!member || member.projectId !== projectId) return res.status(404).json({ error: 'Not found' })
  res.json(member)
})

// PUT /api/projects/:projectId/crew/:memberId
router.put('/:memberId', async (req, res) => {
  const projectId = pid(req)
  const memberId = parseInt(req.params.memberId)
  const [member] = await db.select().from(crewMembers).where(eq(crewMembers.id, memberId))
  if (!member || member.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  const updates = clean(UPDATABLE, req.body)
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields to update' })

  await db.update(crewMembers).set(updates).where(eq(crewMembers.id, memberId))
  const [updated] = await db.select().from(crewMembers).where(eq(crewMembers.id, memberId))
  res.json(updated)
})

// DELETE /api/projects/:projectId/crew/:memberId
router.delete('/:memberId', requireAdmin, async (req, res) => {
  const projectId = pid(req)
  const memberId = parseInt(req.params.memberId)
  const [member] = await db.select().from(crewMembers).where(eq(crewMembers.id, memberId))
  if (!member || member.projectId !== projectId) return res.status(404).json({ error: 'Not found' })
  await db.delete(crewMembers).where(eq(crewMembers.id, memberId))
  res.json({ ok: true })
})

// POST /api/projects/:projectId/crew/:memberId/onboarding-link
router.post('/:memberId/onboarding-link', async (req, res) => {
  const projectId = pid(req)
  const memberId = parseInt(req.params.memberId)

  const [member] = await db.select().from(crewMembers).where(eq(crewMembers.id, memberId))
  if (!member || member.projectId !== projectId) return res.status(404).json({ error: 'Not found' })
  if (!member.email?.trim()) {
    return res.status(400).json({ error: 'An email address is required to send an onboarding link' })
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))

  const token = crypto.randomBytes(32).toString('hex')
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days in ms

  await db.update(crewMembers)
    .set({ onboardingToken: token, onboardingTokenExpires: expires })
    .where(eq(crewMembers.id, memberId))

  const appUrl = (process.env.APP_URL ?? 'http://localhost:3001').replace(/\/$/, '')
  const link = `${appUrl}/onboard/${token}`

  const role = member.type === 'cast'
    ? (member.characterName ? `${member.role} (${member.characterName})` : member.role || 'Cast')
    : (member.role || 'Crew')

  let emailSent = false
  if (emailConfigured()) {
    try {
      emailSent = await sendOnboardingEmail({
        to: member.email.trim(),
        name: member.name,
        projectTitle: project?.title ?? 'your production',
        role,
        link,
      })
    } catch (e) {
      console.error('Onboarding email failed:', e.message)
    }
  }

  const [updated] = await db.select().from(crewMembers).where(eq(crewMembers.id, memberId))
  res.json({ link, emailSent, member: updated })
})

export default router
