import { Router } from 'express'
import { db } from '../db/index.js'
import { potentialActors, actorEventAvailability, events } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'

const router = Router()

function tokenValid(actor) {
  return !!(actor.availabilityToken && actor.availabilityTokenExpires && Date.now() < actor.availabilityTokenExpires)
}

// GET /api/casting-availability/:token
router.get('/:token', async (req, res) => {
  const [actor] = await db.select().from(potentialActors)
    .where(eq(potentialActors.availabilityToken, req.params.token))

  if (!actor || !tokenValid(actor)) {
    return res.status(404).json({ error: 'This availability link is invalid or has expired.' })
  }

  // Return all casting events for this project
  const castingEvents = await db.select().from(events)
    .where(and(eq(events.projectId, actor.projectId), eq(events.type, 'casting')))

  // Get this actor's current availability selections
  const existing = await db.select().from(actorEventAvailability)
    .where(eq(actorEventAvailability.actorId, actor.id))

  const availabilityMap = {}
  for (const a of existing) availabilityMap[a.eventId] = a.available

  res.json({
    actor: {
      name: actor.name,
      email: actor.email,
      phone: actor.phone,
      role: actor.role,
      availabilitySubmittedAt: actor.availabilitySubmittedAt,
    },
    castingEvents: castingEvents.map(e => ({
      id: e.id,
      title: e.title,
      date: e.date,
      startTime: e.startTime,
      endTime: e.endTime,
      location: e.location,
      locationType: e.locationType,
      available: availabilityMap[e.id] ?? null,
    })),
  })
})

// PUT /api/casting-availability/:token
router.put('/:token', async (req, res) => {
  const [actor] = await db.select().from(potentialActors)
    .where(eq(potentialActors.availabilityToken, req.params.token))

  if (!actor || !tokenValid(actor)) {
    return res.status(404).json({ error: 'This availability link is invalid or has expired.' })
  }

  const { name, phone, availability = {} } = req.body
  // availability = { [eventId]: true | false }

  const updates = { availabilitySubmittedAt: new Date() }
  if (name?.trim()) updates.name = name.trim()
  if (phone !== undefined) updates.phone = phone.trim()

  await db.update(potentialActors).set(updates).where(eq(potentialActors.id, actor.id))

  // Upsert availability entries
  for (const [eventIdStr, available] of Object.entries(availability)) {
    const eventId = parseInt(eventIdStr)
    const [existing] = await db.select().from(actorEventAvailability)
      .where(and(eq(actorEventAvailability.actorId, actor.id), eq(actorEventAvailability.eventId, eventId)))

    if (existing) {
      await db.update(actorEventAvailability)
        .set({ available: available ? 1 : 0 })
        .where(and(eq(actorEventAvailability.actorId, actor.id), eq(actorEventAvailability.eventId, eventId)))
    } else {
      await db.insert(actorEventAvailability).values({
        actorId: actor.id, eventId, available: available ? 1 : 0,
      })
    }
  }

  res.json({ ok: true })
})

export default router
