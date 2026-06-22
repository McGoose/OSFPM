import { Router } from 'express'
import { db } from '../db/index.js'
import { tasks, crewMembers, departments } from '../db/schema.js'
import { eq, and, desc, inArray, isNotNull } from 'drizzle-orm'

const router = Router({ mergeParams: true })

function pid(req) { return parseInt(req.params.projectId) }

async function getUserDeptIds(projectId, userId) {
  const records = await db.select({ departmentId: crewMembers.departmentId })
    .from(crewMembers)
    .where(and(eq(crewMembers.projectId, projectId), eq(crewMembers.userId, userId)))
  return [...new Set(records.map(r => r.departmentId).filter(Boolean))]
}

async function canEditTask(task, req) {
  if (req.user.role === 'admin') return true
  if (task.userId === req.user.id) return true
  if (task.departmentId) {
    const myDeptIds = await getUserDeptIds(pid(req), req.user.id)
    return myDeptIds.includes(task.departmentId)
  }
  return false
}

// GET /api/projects/:projectId/tasks
router.get('/', async (req, res) => {
  const projectId = pid(req)
  const userId = req.user.id
  const isAdmin = req.user.role === 'admin'

  const myDeptIds = await getUserDeptIds(projectId, userId)

  const personal = await db.select().from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.userId, userId)))
    .orderBy(tasks.sortOrder, tasks.id)

  let department = []
  if (isAdmin) {
    department = await db.select().from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNotNull(tasks.departmentId)))
      .orderBy(tasks.sortOrder, tasks.id)
  } else if (myDeptIds.length > 0) {
    department = await db.select().from(tasks)
      .where(and(eq(tasks.projectId, projectId), inArray(tasks.departmentId, myDeptIds)))
      .orderBy(tasks.sortOrder, tasks.id)
  }

  res.json({ personal, department, userDeptIds: myDeptIds })
})

// POST /api/projects/:projectId/tasks
router.post('/', async (req, res) => {
  const projectId = pid(req)
  const { title, priority, dueDate, departmentId } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })

  const isAdmin = req.user.role === 'admin'

  if (departmentId) {
    // Check dept task permission
    const [dept] = await db.select().from(departments).where(eq(departments.id, departmentId))
    if (!dept || dept.projectId !== projectId) return res.status(404).json({ error: 'Department not found' })
    if (!isAdmin && dept.taskPermission === 'admin_only') {
      return res.status(403).json({ error: 'Only admins can add tasks to this department' })
    }
    // Non-admin: must be in this department
    if (!isAdmin) {
      const myDeptIds = await getUserDeptIds(projectId, req.user.id)
      if (!myDeptIds.includes(departmentId)) {
        return res.status(403).json({ error: 'You are not a member of this department' })
      }
    }
  }

  await db.insert(tasks).values({
    projectId,
    userId: departmentId ? null : req.user.id,
    departmentId: departmentId ?? null,
    title: title.trim(),
    done: false,
    priority: priority ?? 'medium',
    dueDate: dueDate ?? null,
    sortOrder: 0,
    createdAt: new Date(),
  })

  const [newTask] = await db.select().from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(desc(tasks.id))
    .limit(1)

  res.status(201).json(newTask)
})

// PATCH /api/projects/:projectId/tasks/:taskId
router.patch('/:taskId', async (req, res) => {
  const taskId = parseInt(req.params.taskId)
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  if (!task || task.projectId !== pid(req)) return res.status(404).json({ error: 'Not found' })

  if (!await canEditTask(task, req)) {
    return res.status(403).json({ error: 'Not authorised' })
  }

  const { done, title, priority, dueDate } = req.body
  const updates = {}
  if (done !== undefined) updates.done = done
  if (title !== undefined) updates.title = title.trim()
  if (priority !== undefined) updates.priority = priority
  if (dueDate !== undefined) updates.dueDate = dueDate

  if (Object.keys(updates).length > 0) {
    await db.update(tasks).set(updates).where(eq(tasks.id, taskId))
  }

  const [updated] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  res.json(updated)
})

// DELETE /api/projects/:projectId/tasks/:taskId
router.delete('/:taskId', async (req, res) => {
  const taskId = parseInt(req.params.taskId)
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  if (!task || task.projectId !== pid(req)) return res.status(404).json({ error: 'Not found' })

  if (!await canEditTask(task, req)) {
    return res.status(403).json({ error: 'Not authorised' })
  }

  await db.delete(tasks).where(eq(tasks.id, taskId))
  res.json({ ok: true })
})

export default router
