import { Router } from 'express'
import crypto from 'crypto'
import { db } from '../db/index.js'
import { potentialActors, actorEventAvailability, events } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { sendOnboardingEmail, emailConfigured } from '../utils/email.js'

const router = Router({ mergeParams: true })

function pid(req) { return parseInt(req.params.projectId) }

async function withAvailability(actor) {
  const avail = await db.select().from(actorEventAvailability).where(eq(actorEventAvailability.actorId, actor.id))
  return { ...actor, availability: avail }
}

// GET /api/projects/:projectId/potential-actors
router.get('/', async (req, res) => {
  const all = await db.select().from(potentialActors).where(eq(potentialActors.projectId, pid(req)))
  const enriched = await Promise.all(all.map(withAvailability))
  res.json(enriched)
})

// POST /api/projects/:projectId/potential-actors
router.post('/', async (req, res) => {
  const { name, email, phone, role, notes } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  await db.insert(potentialActors).values({
    projectId: pid(req),
    name: name.trim(),
    email: email?.trim() ?? '',
    phone: phone?.trim() ?? '',
    role: role?.trim() ?? '',
    notes: notes?.trim() ?? '',
    createdAt: new Date(),
  })
  const [newActor] = await db.select().from(potentialActors)
    .where(eq(potentialActors.projectId, pid(req)))
    .orderBy(desc(potentialActors.id))
    .limit(1)
  res.status(201).json(await withAvailability(newActor))
})

// PUT /api/projects/:projectId/potential-actors/:actorId
router.put('/:actorId', async (req, res) => {
  const actorId = parseInt(req.params.actorId)
  const [actor] = await db.select().from(potentialActors).where(eq(potentialActors.id, actorId))
  if (!actor || actor.projectId !== pid(req)) return res.status(404).json({ error: 'Not found' })

  const { name, email, phone, role, notes } = req.body
  const updates = {}
  if (name !== undefined) updates.name = name.trim()
  if (email !== undefined) updates.email = email.trim()
  if (phone !== undefined) updates.phone = phone.trim()
  if (role !== undefined) updates.role = role.trim()
  if (notes !== undefined) updates.notes = notes.trim()

  await db.update(potentialActors).set(updates).where(eq(potentialActors.id, actorId))
  const [updated] = await db.select().from(potentialActors).where(eq(potentialActors.id, actorId))
  res.json(await withAvailability(updated))
})

// DELETE /api/projects/:projectId/potential-actors/:actorId
router.delete('/:actorId', async (req, res) => {
  const actorId = parseInt(req.params.actorId)
  const [actor] = await db.select().from(potentialActors).where(eq(potentialActors.id, actorId))
  if (!actor || actor.projectId !== pid(req)) return res.status(404).json({ error: 'Not found' })
  await db.delete(actorEventAvailability).where(eq(actorEventAvailability.actorId, actorId))
  await db.delete(potentialActors).where(eq(potentialActors.id, actorId))
  res.json({ ok: true })
})

// POST /api/projects/:projectId/potential-actors/:actorId/availability-link
router.post('/:actorId/availability-link', async (req, res) => {
  const actorId = parseInt(req.params.actorId)
  const projectId = pid(req)
  const [actor] = await db.select().from(potentialActors).where(eq(potentialActors.id, actorId))
  if (!actor || actor.projectId !== projectId) return res.status(404).json({ error: 'Not found' })
  if (!actor.email?.trim()) return res.status(400).json({ error: 'An email address is required to send an availability link' })

  const token = crypto.randomBytes(32).toString('hex')
  const expires = Date.now() + 14 * 24 * 60 * 60 * 1000 // 14 days

  await db.update(potentialActors)
    .set({ availabilityToken: token, availabilityTokenExpires: expires })
    .where(eq(potentialActors.id, actorId))

  const appUrl = (process.env.APP_URL ?? 'http://localhost:3001').replace(/\/$/, '')
  const link = `${appUrl}/casting-availability/${token}`

  let emailSent = false
  if (emailConfigured()) {
    try {
      // Reuse the email utility with adapted content
      emailSent = await sendOnboardingEmail({
        to: actor.email.trim(),
        name: actor.name,
        projectTitle: req.body.projectTitle ?? 'the production',
        role: actor.role || 'casting',
        link,
        subject: `Casting availability — please indicate when you're free`,
        bodyText: `Please click the link below to tell us when you're available for casting.`,
        buttonLabel: 'Casting availability →',
      })
    } catch (e) {
      console.error('Availability email failed:', e.message)
    }
  }

  const [updated] = await db.select().from(potentialActors).where(eq(potentialActors.id, actorId))
  res.json({ link, emailSent, actor: await withAvailability(updated) })
})

export default router
