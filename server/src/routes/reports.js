import { Router } from 'express'
import { db } from '../db/index.js'
import {
  soundReports, cameraReports, dailyProgressReports,
  events, eventAttendees, eventScenes, scenes, crewMembers,
  callSheets, budgetLines, budgetCategories, invoices,
} from '../db/schema.js'
import { eq, and, asc, desc, like, inArray, sql } from 'drizzle-orm'

const router = Router({ mergeParams: true })

function pid(req) { return parseInt(req.params.projectId) }

async function getEventData(projectId, eventId) {
  const [event] = await db.select().from(events).where(eq(events.id, eventId))
  if (!event || event.projectId !== projectId) return null
  const attendees = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, eventId))
  const sceneLinks = await db.select().from(eventScenes).where(eq(eventScenes.eventId, eventId))
  return { ...event, attendees, sceneIds: sceneLinks.map(s => s.sceneId) }
}

function upsert(table, eventId, projectId, values) {
  return db.select().from(table)
    .where(and(eq(table.eventId, eventId), eq(table.projectId, projectId)))
    .then(async ([existing]) => {
      if (existing) {
        await db.update(table).set({ ...values, updatedAt: new Date() }).where(eq(table.id, existing.id))
      } else {
        await db.insert(table).values({ eventId, projectId, ...values, createdAt: new Date() })
      }
      const [saved] = await db.select().from(table)
        .where(and(eq(table.eventId, eventId), eq(table.projectId, projectId)))
      return saved
    })
}

// GET /api/projects/:projectId/reports — list all shoot days with report status
router.get('/', async (req, res) => {
  const projectId = pid(req)
  const shootDays = await db.select().from(events)
    .where(and(eq(events.projectId, projectId), eq(events.type, 'shoot_day')))
    .orderBy(asc(events.date))

  if (!shootDays.length) return res.json([])

  const eventIds = shootDays.map(e => e.id)
  const [sReps, cReps, pReps] = await Promise.all([
    db.select({ eventId: soundReports.eventId }).from(soundReports)
      .where(inArray(soundReports.eventId, eventIds)),
    db.select({ eventId: cameraReports.eventId }).from(cameraReports)
      .where(inArray(cameraReports.eventId, eventIds)),
    db.select({ eventId: dailyProgressReports.eventId }).from(dailyProgressReports)
      .where(inArray(dailyProgressReports.eventId, eventIds)),
  ])

  const soundSet = new Set(sReps.map(r => r.eventId))
  const camSet = new Set(cReps.map(r => r.eventId))
  const progSet = new Set(pReps.map(r => r.eventId))

  res.json(shootDays.map(event => ({
    event,
    hasSoundReport: soundSet.has(event.id),
    hasCameraReport: camSet.has(event.id),
    hasProgressReport: progSet.has(event.id),
  })))
})

// GET /api/projects/:projectId/reports/:eventId — full day data
router.get('/:eventId', async (req, res) => {
  const projectId = pid(req)
  const eventId = parseInt(req.params.eventId)

  const event = await getEventData(projectId, eventId)
  if (!event) return res.status(404).json({ error: 'Event not found' })
  if (event.type !== 'shoot_day') return res.status(400).json({ error: 'Reports are only for shoot days' })

  const [
    [soundReport],
    [cameraReport],
    [dailyProgressReport],
    crew,
    allScenes,
    [callSheet],
  ] = await Promise.all([
    db.select().from(soundReports).where(and(eq(soundReports.eventId, eventId), eq(soundReports.projectId, projectId))),
    db.select().from(cameraReports).where(and(eq(cameraReports.eventId, eventId), eq(cameraReports.projectId, projectId))),
    db.select().from(dailyProgressReports).where(and(eq(dailyProgressReports.eventId, eventId), eq(dailyProgressReports.projectId, projectId))),
    db.select().from(crewMembers).where(eq(crewMembers.projectId, projectId)),
    db.select().from(scenes).where(eq(scenes.projectId, projectId)),
    db.select().from(callSheets).where(and(eq(callSheets.eventId, eventId), eq(callSheets.projectId, projectId))),
  ])

  // Previous camera setup: most recent camera report for this project (excluding today)
  const prevCamRows = await db.select({ setup: cameraReports.setup, date: events.date })
    .from(cameraReports)
    .innerJoin(events, eq(cameraReports.eventId, events.id))
    .where(and(eq(cameraReports.projectId, projectId), sql`${cameraReports.eventId} != ${eventId}`))
    .orderBy(desc(events.date))
    .limit(1)
  const previousCameraSetup = prevCamRows[0]?.setup ?? null

  // Petty cash: sum of approved/paid invoices linked to budget categories with 'petty' in name
  const pettyCatRows = await db.select({ id: budgetCategories.id }).from(budgetCategories)
    .where(and(eq(budgetCategories.projectId, projectId), like(budgetCategories.name, '%petty%')))
  let pettyCash = 0
  if (pettyCatRows.length > 0) {
    const catIds = pettyCatRows.map(r => r.id)
    const pettyLines = await db.select({ id: budgetLines.id }).from(budgetLines)
      .where(inArray(budgetLines.categoryId, catIds))
    if (pettyLines.length > 0) {
      const lineIds = pettyLines.map(r => r.id)
      const pettyInvRows = await db.select({ amount: invoices.amount }).from(invoices)
        .where(and(
          eq(invoices.projectId, projectId),
          inArray(invoices.budgetLineId, lineIds),
          inArray(invoices.status, ['approved', 'paid']),
        ))
      pettyCash = pettyInvRows.reduce((sum, r) => sum + (r.amount ?? 0), 0)
    }
  }

  res.json({
    event,
    soundReport: soundReport ?? null,
    cameraReport: cameraReport ?? null,
    dailyProgressReport: dailyProgressReport ?? null,
    crew,
    scenes: allScenes,
    callSheet: callSheet ?? null,
    previousCameraSetup,
    pettyCash,
  })
})

// PUT /api/projects/:projectId/reports/:eventId/sound
router.put('/:eventId/sound', async (req, res) => {
  const projectId = pid(req)
  const eventId = parseInt(req.params.eventId)
  const ev = await getEventData(projectId, eventId)
  if (!ev) return res.status(404).json({ error: 'Event not found' })
  const { csvData } = req.body
  if (!csvData) return res.status(400).json({ error: 'csvData is required' })
  const saved = await upsert(soundReports, eventId, projectId, {
    csvData: typeof csvData === 'string' ? csvData : JSON.stringify(csvData),
  })
  res.json(saved)
})

// PUT /api/projects/:projectId/reports/:eventId/camera
router.put('/:eventId/camera', async (req, res) => {
  const projectId = pid(req)
  const eventId = parseInt(req.params.eventId)
  const ev = await getEventData(projectId, eventId)
  if (!ev) return res.status(404).json({ error: 'Event not found' })
  const { setup, takes } = req.body
  const saved = await upsert(cameraReports, eventId, projectId, {
    setup: typeof setup === 'string' ? setup : JSON.stringify(setup ?? {}),
    takes: typeof takes === 'string' ? takes : JSON.stringify(takes ?? []),
  })
  res.json(saved)
})

// PUT /api/projects/:projectId/reports/:eventId/progress
router.put('/:eventId/progress', async (req, res) => {
  const projectId = pid(req)
  const eventId = parseInt(req.params.eventId)
  const ev = await getEventData(projectId, eventId)
  if (!ev) return res.status(404).json({ error: 'Event not found' })
  const { data } = req.body
  if (!data) return res.status(400).json({ error: 'data is required' })
  const saved = await upsert(dailyProgressReports, eventId, projectId, {
    data: typeof data === 'string' ? data : JSON.stringify(data),
  })
  res.json(saved)
})

export default router
