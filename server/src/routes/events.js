import { Router } from 'express'
import { db } from '../db/index.js'
import { events, eventAttendees, eventScenes, castingSlots, crewMembers } from '../db/schema.js'
import { eq, and, inArray } from 'drizzle-orm'
import { requireAdmin } from '../middleware/auth.js'

const router = Router({ mergeParams: true })

function pid(req) { return parseInt(req.params.projectId) }

function parseMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number)
  return h * 60 + m
}

function formatMinutes(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

function generateSlots(startTime, endTime, slotDuration, breakAfterSlots, breakDuration) {
  const slots = []
  let cur = parseMinutes(startTime)
  const end = parseMinutes(endTime)
  let count = 0
  let order = 0

  while (cur + slotDuration <= end) {
    slots.push({ startTime: formatMinutes(cur), endTime: formatMinutes(cur + slotDuration), isBreak: false, sortOrder: order++ })
    cur += slotDuration
    count++
    if (breakAfterSlots && breakDuration && count % breakAfterSlots === 0 && cur + breakDuration <= end) {
      slots.push({ startTime: formatMinutes(cur), endTime: formatMinutes(cur + breakDuration), isBreak: true, sortOrder: order++ })
      cur += breakDuration
    }
  }
  return slots
}

async function expandToMemberIds(projectId, attendees) {
  const ids = new Set()
  for (const a of attendees) {
    if (a.type === 'member' && a.memberId) {
      ids.add(a.memberId)
    } else if (a.type === 'department' && a.departmentId) {
      const members = await db.select({ id: crewMembers.id }).from(crewMembers)
        .where(and(eq(crewMembers.projectId, projectId), eq(crewMembers.departmentId, a.departmentId)))
      members.forEach(m => ids.add(m.id))
    }
  }
  return [...ids]
}

async function checkShootDayGap(projectId, date, startTime, endTime, attendees, excludeId) {
  const memberIds = await expandToMemberIds(projectId, attendees)
  if (memberIds.length === 0) return null

  const shootStart = new Date(`${date}T${startTime}:00`)
  const shootEnd = new Date(`${date}T${endTime}:00`)
  const windowStart = new Date(shootStart.getTime() - 12 * 60 * 60 * 1000)
  const windowEnd = new Date(shootEnd.getTime() + 12 * 60 * 60 * 1000)

  const allEvents = await db.select().from(events).where(eq(events.projectId, projectId))

  for (const other of allEvents) {
    if (excludeId && other.id === excludeId) continue
    const otherStart = new Date(`${other.date}T${other.startTime}:00`)
    const otherEnd = new Date(`${other.date}T${other.endTime}:00`)

    if (otherEnd <= windowStart || otherStart >= windowEnd) continue

    const otherAttendees = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, other.id))
    const otherMemberIds = await expandToMemberIds(projectId, otherAttendees)
    const conflict = memberIds.some(id => otherMemberIds.includes(id))
    if (conflict) return { id: other.id, title: other.title, type: other.type, date: other.date, startTime: other.startTime, endTime: other.endTime }
  }
  return null
}

async function enrichEvent(event) {
  const attendees = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, event.id))
  const sceneLinks = await db.select().from(eventScenes).where(eq(eventScenes.eventId, event.id))
  const slots = event.type === 'casting'
    ? await db.select().from(castingSlots).where(eq(castingSlots.eventId, event.id))
    : []
  return { ...event, attendees, sceneIds: sceneLinks.map(s => s.sceneId), slots }
}

// GET /api/projects/:projectId/events
router.get('/', async (req, res) => {
  const all = await db.select().from(events).where(eq(events.projectId, pid(req)))
  const enriched = await Promise.all(all.map(enrichEvent))
  res.json(enriched)
})

// GET /api/projects/:projectId/events/:eventId
router.get('/:eventId', async (req, res) => {
  const [event] = await db.select().from(events).where(eq(events.id, parseInt(req.params.eventId)))
  if (!event || event.projectId !== pid(req)) return res.status(404).json({ error: 'Not found' })
  res.json(await enrichEvent(event))
})

// POST /api/projects/:projectId/events
router.post('/', async (req, res) => {
  const projectId = pid(req)
  const { type, title, date, startTime, endTime, location, locationType, notes,
    slotDurationMinutes, breakAfterSlots, breakDurationMinutes,
    attendees = [], sceneIds = [] } = req.body

  if (!type || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'type, date, startTime, endTime are required' })
  }

  // Enforce recce is always in-person
  const resolvedLocationType = type === 'recce' ? 'in_person' : (locationType ?? 'in_person')

  // Enforce shoot day max 12h
  if (type === 'shoot_day') {
    const dur = parseMinutes(endTime) - parseMinutes(startTime)
    if (dur > 720) return res.status(400).json({ error: 'Shoot days cannot exceed 12 hours' })
  }

  // Shoot day gap check
  if (type === 'shoot_day') {
    const conflict = await checkShootDayGap(projectId, date, startTime, endTime, attendees, null)
    if (conflict) {
      return res.status(409).json({
        error: `This shoot day conflicts with "${conflict.title}" on ${conflict.date} (${conflict.startTime}–${conflict.endTime}). A 12-hour gap is required between shoot days for shared crew.`,
        conflict,
      })
    }
  }

  await db.insert(events).values({
    projectId, type, title: title?.trim() ?? '', date, startTime, endTime,
    location: location?.trim() ?? '',
    locationType: resolvedLocationType,
    notes: notes?.trim() ?? '',
    slotDurationMinutes: slotDurationMinutes ?? null,
    breakAfterSlots: breakAfterSlots ?? null,
    breakDurationMinutes: breakDurationMinutes ?? null,
    createdAt: new Date(),
  })

  const all = await db.select().from(events).where(eq(events.projectId, projectId))
  const newEvent = all[all.length - 1]

  // Save attendees
  for (const a of attendees) {
    await db.insert(eventAttendees).values({
      eventId: newEvent.id,
      type: a.type,
      memberId: a.memberId ?? null,
      departmentId: a.departmentId ?? null,
    })
  }

  // Save scenes
  for (const sceneId of sceneIds) {
    await db.insert(eventScenes).values({ eventId: newEvent.id, sceneId })
  }

  // Auto-generate casting slots
  if (type === 'casting' && slotDurationMinutes) {
    const slots = generateSlots(startTime, endTime, slotDurationMinutes, breakAfterSlots, breakDurationMinutes)
    for (const slot of slots) {
      await db.insert(castingSlots).values({ eventId: newEvent.id, ...slot })
    }
  }

  res.status(201).json(await enrichEvent(newEvent))
})

// PUT /api/projects/:projectId/events/:eventId
router.put('/:eventId', async (req, res) => {
  const projectId = pid(req)
  const eventId = parseInt(req.params.eventId)
  const [existing] = await db.select().from(events).where(eq(events.id, eventId))
  if (!existing || existing.projectId !== projectId) return res.status(404).json({ error: 'Not found' })

  const { title, date, startTime, endTime, location, locationType, notes,
    slotDurationMinutes, breakAfterSlots, breakDurationMinutes,
    attendees, sceneIds, regenerateSlots } = req.body

  const newDate = date ?? existing.date
  const newStart = startTime ?? existing.startTime
  const newEnd = endTime ?? existing.endTime
  const newType = existing.type

  if (newType === 'shoot_day') {
    const dur = parseMinutes(newEnd) - parseMinutes(newStart)
    if (dur > 720) return res.status(400).json({ error: 'Shoot days cannot exceed 12 hours' })
  }

  if (newType === 'shoot_day' && attendees) {
    const conflict = await checkShootDayGap(projectId, newDate, newStart, newEnd, attendees, eventId)
    if (conflict) {
      return res.status(409).json({
        error: `This shoot day conflicts with "${conflict.title}" on ${conflict.date} (${conflict.startTime}–${conflict.endTime}). A 12-hour gap is required.`,
        conflict,
      })
    }
  }

  const updates = {}
  if (title !== undefined) updates.title = title.trim()
  if (date !== undefined) updates.date = date
  if (startTime !== undefined) updates.startTime = startTime
  if (endTime !== undefined) updates.endTime = endTime
  if (location !== undefined) updates.location = location.trim()
  if (locationType !== undefined && newType !== 'recce') updates.locationType = locationType
  if (notes !== undefined) updates.notes = notes.trim()
  if (slotDurationMinutes !== undefined) updates.slotDurationMinutes = slotDurationMinutes
  if (breakAfterSlots !== undefined) updates.breakAfterSlots = breakAfterSlots
  if (breakDurationMinutes !== undefined) updates.breakDurationMinutes = breakDurationMinutes

  if (Object.keys(updates).length > 0) {
    await db.update(events).set(updates).where(eq(events.id, eventId))
  }

  if (attendees !== undefined) {
    await db.delete(eventAttendees).where(eq(eventAttendees.eventId, eventId))
    for (const a of attendees) {
      await db.insert(eventAttendees).values({
        eventId, type: a.type, memberId: a.memberId ?? null, departmentId: a.departmentId ?? null,
      })
    }
  }

  if (sceneIds !== undefined) {
    await db.delete(eventScenes).where(eq(eventScenes.eventId, eventId))
    for (const sceneId of sceneIds) {
      await db.insert(eventScenes).values({ eventId, sceneId })
    }
  }

  if (regenerateSlots && existing.type === 'casting') {
    const sd = updates.slotDurationMinutes ?? existing.slotDurationMinutes
    const bas = updates.breakAfterSlots ?? existing.breakAfterSlots
    const bd = updates.breakDurationMinutes ?? existing.breakDurationMinutes
    if (sd) {
      await db.delete(castingSlots).where(eq(castingSlots.eventId, eventId))
      const slots = generateSlots(newStart, newEnd, sd, bas, bd)
      for (const slot of slots) {
        await db.insert(castingSlots).values({ eventId, ...slot })
      }
    }
  }

  const [updated] = await db.select().from(events).where(eq(events.id, eventId))
  res.json(await enrichEvent(updated))
})

// PATCH /api/projects/:projectId/events/:eventId/slots/:slotId — assign actor to slot
router.patch('/:eventId/slots/:slotId', async (req, res) => {
  const slotId = parseInt(req.params.slotId)
  const { actorId, notes, isBreak } = req.body
  const updates = {}
  if (actorId !== undefined) updates.actorId = actorId
  if (notes !== undefined) updates.notes = notes
  if (isBreak !== undefined) updates.isBreak = isBreak
  await db.update(castingSlots).set(updates).where(eq(castingSlots.id, slotId))
  const [slot] = await db.select().from(castingSlots).where(eq(castingSlots.id, slotId))
  res.json(slot)
})

// DELETE /api/projects/:projectId/events/:eventId
router.delete('/:eventId', requireAdmin, async (req, res) => {
  const eventId = parseInt(req.params.eventId)
  const [existing] = await db.select().from(events).where(eq(events.id, eventId))
  if (!existing || existing.projectId !== pid(req)) return res.status(404).json({ error: 'Not found' })
  await db.delete(eventAttendees).where(eq(eventAttendees.eventId, eventId))
  await db.delete(eventScenes).where(eq(eventScenes.eventId, eventId))
  await db.delete(castingSlots).where(eq(castingSlots.eventId, eventId))
  await db.delete(events).where(eq(events.id, eventId))
  res.json({ ok: true })
})

export default router
