import { Router } from 'express'
import { db } from '../db/index.js'
import { callSheets, events, eventAttendees, eventScenes, scenes, crewMembers, departments } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import { requireAdmin } from '../middleware/auth.js'

const router = Router({ mergeParams: true })

function pid(req) { return parseInt(req.params.projectId) }

async function getEventData(projectId, eventId) {
  const [event] = await db.select().from(events).where(eq(events.id, eventId))
  if (!event || event.projectId !== projectId) return null

  const attendees = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, eventId))
  const sceneLinks = await db.select().from(eventScenes).where(eq(eventScenes.eventId, eventId))
  return { ...event, attendees, sceneIds: sceneLinks.map(s => s.sceneId) }
}

// GET /api/projects/:projectId/call-sheets/:eventId
router.get('/:eventId', requireAdmin, async (req, res) => {
  const projectId = pid(req)
  const eventId = parseInt(req.params.eventId)

  const event = await getEventData(projectId, eventId)
  if (!event) return res.status(404).json({ error: 'Event not found' })
  if (event.type !== 'shoot_day') return res.status(400).json({ error: 'Call sheets are only for shoot days' })

  const [callSheet] = await db.select().from(callSheets)
    .where(and(eq(callSheets.eventId, eventId), eq(callSheets.projectId, projectId)))

  const crew = await db.select().from(crewMembers).where(eq(crewMembers.projectId, projectId))
  const allScenes = await db.select().from(scenes).where(eq(scenes.projectId, projectId))
  const depts = await db.select().from(departments).where(eq(departments.projectId, projectId))

  res.json({ callSheet: callSheet ?? null, event, crew, scenes: allScenes, departments: depts })
})

// PUT /api/projects/:projectId/call-sheets/:eventId
router.put('/:eventId', requireAdmin, async (req, res) => {
  const projectId = pid(req)
  const eventId = parseInt(req.params.eventId)
  const { data } = req.body
  if (!data) return res.status(400).json({ error: 'data is required' })

  const event = await getEventData(projectId, eventId)
  if (!event) return res.status(404).json({ error: 'Event not found' })

  const [existing] = await db.select().from(callSheets)
    .where(and(eq(callSheets.eventId, eventId), eq(callSheets.projectId, projectId)))

  const dataStr = typeof data === 'string' ? data : JSON.stringify(data)

  if (existing) {
    await db.update(callSheets)
      .set({ data: dataStr, updatedAt: new Date() })
      .where(eq(callSheets.id, existing.id))
  } else {
    await db.insert(callSheets).values({
      eventId, projectId, data: dataStr, createdAt: new Date(),
    })
  }

  const [saved] = await db.select().from(callSheets)
    .where(and(eq(callSheets.eventId, eventId), eq(callSheets.projectId, projectId)))

  res.json(saved)
})

export default router
