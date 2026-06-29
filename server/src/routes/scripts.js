import { Router } from 'express'
import { db } from '../db/index.js'
import { scripts, scenes, breakdownElements } from '../db/schema.js'
import { eq, asc, and } from 'drizzle-orm'
import { requireAdmin } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
function pid(req) { return parseInt(req.params.projectId) }

const DGA_COLORS = [
  'white', 'blue', 'pink', 'yellow', 'green',
  'goldenrod', 'buff', 'salmon', 'cherry', 'tan', 'ivory',
]

function nextColorRevision(existingShootingScripts) {
  const maxIdx = existingShootingScripts.reduce(
    (m, s) => Math.max(m, DGA_COLORS.indexOf(s.colorRevision)),
    -1
  )
  const nextIdx = maxIdx + 1
  const cycle = Math.floor(nextIdx / DGA_COLORS.length)
  const colorIdx = nextIdx % DGA_COLORS.length
  // After ivory, prepend cycle indicator: '2x-white', '2x-blue', etc.
  return cycle === 0 ? DGA_COLORS[colorIdx] : `${cycle + 1}x-${DGA_COLORS[colorIdx]}`
}

function stripContent(row) {
  const { rawContent, scenesData, ...rest } = row
  return {
    ...rest,
    sceneCount: (() => { try { return JSON.parse(scenesData).length } catch { return 0 } })(),
  }
}

// GET /api/projects/:projectId/scripts
router.get('/', async (req, res) => {
  const projectId = pid(req)
  const rows = await db.select().from(scripts)
    .where(eq(scripts.projectId, projectId))
    .orderBy(asc(scripts.uploadedAt))
  res.json(rows.map(stripContent))
})

// GET /api/projects/:projectId/scripts/:scriptId  (includes scenesData for diff)
router.get('/:scriptId', async (req, res) => {
  const projectId = pid(req)
  const scriptId = parseInt(req.params.scriptId)
  const [row] = await db.select().from(scripts)
    .where(and(eq(scripts.id, scriptId), eq(scripts.projectId, projectId)))
  if (!row) return res.status(404).json({ error: 'Not found' })
  // Return scenesData but not rawContent (large)
  const { rawContent, ...rest } = row
  res.json(rest)
})

// POST /api/projects/:projectId/scripts
router.post('/', requireAdmin, async (req, res) => {
  const projectId = pid(req)
  const { type, title, filename, format, rawContent, scenesData, notes } = req.body

  if (!rawContent) return res.status(400).json({ error: 'rawContent is required' })
  if (!['scriptment', 'draft', 'shooting_script'].includes(type)) {
    return res.status(400).json({ error: 'type must be scriptment, draft, or shooting_script' })
  }

  const allForProject = await db.select().from(scripts)
    .where(eq(scripts.projectId, projectId))
  const ofSameType = allForProject.filter(s => s.type === type)
  const versionNumber = ofSameType.length + 1

  const shootingScripts = allForProject.filter(s => s.type === 'shooting_script')
  const colorRevision = type === 'shooting_script'
    ? nextColorRevision(shootingScripts)
    : 'white'

  await db.insert(scripts).values({
    projectId,
    type,
    versionNumber,
    colorRevision,
    title: title?.trim() ?? '',
    filename: filename ?? 'script',
    format: format ?? 'fountain',
    rawContent,
    scenesData: typeof scenesData === 'string' ? scenesData : JSON.stringify(scenesData ?? []),
    notes: notes?.trim() ?? '',
    uploadedAt: new Date(),
  })

  const inserted = await db.select().from(scripts)
    .where(eq(scripts.projectId, projectId))
    .orderBy(asc(scripts.uploadedAt))
  const newRow = inserted[inserted.length - 1]
  res.status(201).json(stripContent(newRow))
})

// PATCH /api/projects/:projectId/scripts/:scriptId
router.patch('/:scriptId', requireAdmin, async (req, res) => {
  const projectId = pid(req)
  const scriptId = parseInt(req.params.scriptId)
  const [row] = await db.select().from(scripts)
    .where(and(eq(scripts.id, scriptId), eq(scripts.projectId, projectId)))
  if (!row) return res.status(404).json({ error: 'Not found' })

  const updates = {}
  if (req.body.notes !== undefined) updates.notes = req.body.notes?.trim() ?? ''
  if (req.body.title !== undefined) updates.title = req.body.title?.trim() ?? ''

  if (Object.keys(updates).length === 0) return res.json(stripContent(row))

  await db.update(scripts).set(updates).where(eq(scripts.id, scriptId))
  const [updated] = await db.select().from(scripts).where(eq(scripts.id, scriptId))
  res.json(stripContent(updated))
})

// DELETE /api/projects/:projectId/scripts/:scriptId
router.delete('/:scriptId', requireAdmin, async (req, res) => {
  const projectId = pid(req)
  const scriptId = parseInt(req.params.scriptId)
  const [row] = await db.select().from(scripts)
    .where(and(eq(scripts.id, scriptId), eq(scripts.projectId, projectId)))
  if (!row) return res.status(404).json({ error: 'Not found' })

  const linked = await db.select().from(scenes)
    .where(and(eq(scenes.projectId, projectId), eq(scenes.scriptVersionId, scriptId)))
  if (linked.length > 0) {
    return res.status(409).json({
      error: `Cannot delete: ${linked.length} breakdown scene(s) are linked to this version. Send a different version to breakdown first.`,
    })
  }

  await db.delete(scripts).where(eq(scripts.id, scriptId))
  res.json({ ok: true })
})

// POST /api/projects/:projectId/scripts/:scriptId/apply-to-breakdown
// body: { merge: boolean }
// merge=true  → smart update: match by sceneNumber, keep elements for unchanged/modified, add new, remove deleted
// merge=false → replace all: wipe breakdown and re-import
router.post('/:scriptId/apply-to-breakdown', requireAdmin, async (req, res) => {
  const projectId = pid(req)
  const scriptId = parseInt(req.params.scriptId)
  const { merge = true } = req.body

  const [script] = await db.select().from(scripts)
    .where(and(eq(scripts.id, scriptId), eq(scripts.projectId, projectId)))
  if (!script) return res.status(404).json({ error: 'Script not found' })
  if (script.type !== 'shooting_script') {
    return res.status(400).json({ error: 'Only shooting scripts can be sent to breakdown' })
  }

  let incoming
  try { incoming = JSON.parse(script.scenesData) } catch { incoming = [] }
  if (!incoming.length) return res.status(400).json({ error: 'Script has no parsed scenes stored' })

  const currentScenes = await db.select().from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.sortOrder))
  const currentElements = await db.select().from(breakdownElements)
    .where(eq(breakdownElements.projectId, projectId))

  if (!merge || currentScenes.length === 0) {
    // Full replace
    await db.delete(breakdownElements).where(eq(breakdownElements.projectId, projectId))
    await db.delete(scenes).where(eq(scenes.projectId, projectId))

    for (let i = 0; i < incoming.length; i++) {
      const s = incoming[i]
      await db.insert(scenes).values({
        projectId,
        sceneNumber: String(s.sceneNumber),
        intExt: s.intExt ?? 'INT',
        location: s.location ?? '',
        timeOfDay: s.timeOfDay ?? 'DAY',
        description: s.description ?? '',
        content: s.content ?? '',
        pages: Number(s.pages) || 1,
        scriptVersionId: scriptId,
        sortOrder: (i + 1) * 10,
      })
    }

    const newScenes = await db.select().from(scenes)
      .where(eq(scenes.projectId, projectId))
      .orderBy(asc(scenes.sortOrder))

    for (let i = 0; i < incoming.length; i++) {
      const chars = incoming[i].characters ?? []
      let order = 10
      for (const name of chars) {
        await db.insert(breakdownElements).values({
          sceneId: newScenes[i].id,
          projectId,
          category: 'cast',
          description: name,
          sortOrder: order,
        })
        order += 10
      }
    }
  } else {
    // Smart merge: match by sceneNumber
    const currentByNum = new Map(currentScenes.map(s => [s.sceneNumber, s]))
    const incomingNums = new Set(incoming.map(s => String(s.sceneNumber)))

    // Remove scenes no longer in the script (and their elements)
    for (const curr of currentScenes) {
      if (!incomingNums.has(curr.sceneNumber)) {
        await db.delete(breakdownElements).where(eq(breakdownElements.sceneId, curr.id))
        await db.delete(scenes).where(eq(scenes.id, curr.id))
      }
    }

    // Update existing / insert new
    for (let i = 0; i < incoming.length; i++) {
      const s = incoming[i]
      const numStr = String(s.sceneNumber)
      const existing = currentByNum.get(numStr)

      if (existing) {
        await db.update(scenes).set({
          intExt: s.intExt ?? 'INT',
          location: s.location ?? '',
          timeOfDay: s.timeOfDay ?? 'DAY',
          description: s.description ?? '',
          content: s.content ?? '',
          pages: Number(s.pages) || 1,
          scriptVersionId: scriptId,
          sortOrder: (i + 1) * 10,
        }).where(eq(scenes.id, existing.id))
      } else {
        await db.insert(scenes).values({
          projectId,
          sceneNumber: numStr,
          intExt: s.intExt ?? 'INT',
          location: s.location ?? '',
          timeOfDay: s.timeOfDay ?? 'DAY',
          description: s.description ?? '',
          content: s.content ?? '',
          pages: Number(s.pages) || 1,
          scriptVersionId: scriptId,
          sortOrder: (i + 1) * 10,
        })
        // Auto-add characters for new scenes only
        const [inserted] = await db.select().from(scenes)
          .where(and(eq(scenes.projectId, projectId), eq(scenes.sceneNumber, numStr)))
        if (inserted) {
          let order = 10
          for (const name of (s.characters ?? [])) {
            await db.insert(breakdownElements).values({
              sceneId: inserted.id,
              projectId,
              category: 'cast',
              description: name,
              sortOrder: order,
            })
            order += 10
          }
        }
      }
    }
  }

  // Return full updated breakdown
  const finalScenes = await db.select().from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.sortOrder))
  const allElements = await db.select().from(breakdownElements)
    .where(eq(breakdownElements.projectId, projectId))
    .orderBy(asc(breakdownElements.sortOrder))

  res.json(finalScenes.map(s => ({
    ...s,
    elements: allElements.filter(e => e.sceneId === s.id),
  })))
})

export default router
