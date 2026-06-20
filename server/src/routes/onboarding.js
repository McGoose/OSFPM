import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { db } from '../db/index.js'
import { crewMembers, projects, users } from '../db/schema.js'
import { eq } from 'drizzle-orm'

const router = Router()

const SELF_FIELDS = [
  'name', 'phone', 'pronouns',
  'dietaryNeeds', 'medicalNeeds', 'accessibilityNeeds',
  'emergencyName', 'emergencyPhone', 'emergencyRelation',
  'agentName', 'agentEmail', 'agentPhone',
]

function tokenValid(member) {
  return !!(
    member.onboardingToken &&
    member.onboardingTokenExpires &&
    Date.now() < member.onboardingTokenExpires
  )
}

// GET /api/onboarding/:token — no auth required
router.get('/:token', async (req, res) => {
  const [member] = await db.select().from(crewMembers)
    .where(eq(crewMembers.onboardingToken, req.params.token))

  if (!member || !tokenValid(member)) {
    return res.status(404).json({ error: 'This onboarding link is invalid or has expired.' })
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, member.projectId))

  res.json({
    member: {
      name: member.name,
      type: member.type,
      role: member.role,
      characterName: member.characterName,
      email: member.email,
      phone: member.phone,
      pronouns: member.pronouns,
      dietaryNeeds: member.dietaryNeeds,
      medicalNeeds: member.medicalNeeds,
      accessibilityNeeds: member.accessibilityNeeds,
      emergencyName: member.emergencyName,
      emergencyPhone: member.emergencyPhone,
      emergencyRelation: member.emergencyRelation,
      agentName: member.agentName,
      agentEmail: member.agentEmail,
      agentPhone: member.agentPhone,
      onboardingCompletedAt: member.onboardingCompletedAt,
      hasAccount: !!member.userId,
    },
    project: project
      ? { title: project.title, genre: project.genre, format: project.format }
      : null,
  })
})

// PUT /api/onboarding/:token — no auth required
router.put('/:token', async (req, res) => {
  const [member] = await db.select().from(crewMembers)
    .where(eq(crewMembers.onboardingToken, req.params.token))

  if (!member || !tokenValid(member)) {
    return res.status(404).json({ error: 'This onboarding link is invalid or has expired.' })
  }

  const { password, ...body } = req.body

  // Validate password if provided
  if (password !== undefined && password !== '') {
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' })
    }
  }

  // Must set a password on first-time account creation
  const isFirstTime = !member.userId
  if (isFirstTime && !password) {
    return res.status(400).json({ error: 'Please choose a password to create your account.' })
  }

  // Build member field updates
  const updates = {}
  for (const f of SELF_FIELDS) {
    if (body[f] !== undefined) {
      updates[f] = typeof body[f] === 'string' ? body[f].trim() : body[f]
    }
  }
  updates.onboardingCompletedAt = new Date()

  // Create or update OSFPM account
  if (password) {
    const passwordHash = await bcrypt.hash(password, 10)
    const memberName = updates.name ?? member.name
    const email = member.email?.trim()

    if (member.userId) {
      // Reset password on existing account
      await db.update(users).set({ passwordHash }).where(eq(users.id, member.userId))
    } else if (email) {
      // Check if an account with this email already exists (e.g. admin added them manually)
      const [existing] = await db.select().from(users).where(eq(users.email, email))
      if (existing) {
        await db.update(users).set({ passwordHash }).where(eq(users.id, existing.id))
        updates.userId = existing.id
      } else {
        await db.insert(users).values({
          email,
          passwordHash,
          name: memberName,
          role: 'crew',
          createdAt: new Date(),
        })
        const [newUser] = await db.select().from(users).where(eq(users.email, email))
        if (newUser) updates.userId = newUser.id
      }
    }
  }

  await db.update(crewMembers).set(updates).where(eq(crewMembers.id, member.id))
  res.json({ ok: true })
})

export default router
