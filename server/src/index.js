import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import 'dotenv/config'
import { requireAuth } from './middleware/auth.js'
import authRouter from './routes/auth.js'
import settingsRouter from './routes/settings.js'
import usersRouter from './routes/users.js'
import projectsRouter from './routes/projects.js'
import budgetRouter from './routes/budget.js'
import budgetTemplateRouter from './routes/budgetTemplate.js'
import coproducersRouter from './routes/coproducers.js'
import invoicesRouter from './routes/invoices.js'
import departmentsRouter from './routes/departments.js'
import breakdownRouter from './routes/breakdown.js'
import crewRouter from './routes/crew.js'
import onboardingRouter from './routes/onboarding.js'
import preproductionRouter from './routes/preproduction.js'
import productionRouter from './routes/production.js'
import postproductionRouter from './routes/postproduction.js'

const app = express()
const PORT = process.env.PORT ?? 5000

app.use(cors({ origin: process.env.CLIENT_URL ?? 'http://localhost:3000', credentials: true }))
app.use(express.json())
app.use(cookieParser())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' })
})

app.use('/api/auth', authRouter)
app.use('/api/onboarding', onboardingRouter) // public — no auth
app.use('/api/settings', settingsRouter)
app.use('/api/settings/budget-template', requireAuth, budgetTemplateRouter)
app.use('/api/users', usersRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/projects/:projectId/budget', requireAuth, budgetRouter)
app.use('/api/projects/:projectId/departments', requireAuth, departmentsRouter)
app.use('/api/projects/:projectId/coproducers', requireAuth, coproducersRouter)
app.use('/api/projects/:projectId/invoices', requireAuth, invoicesRouter)
app.use('/api/projects/:projectId/breakdown', requireAuth, breakdownRouter)
app.use('/api/projects/:projectId/crew', requireAuth, crewRouter)
app.use('/api/preproduction', requireAuth, preproductionRouter)
app.use('/api/production', requireAuth, productionRouter)
app.use('/api/postproduction', requireAuth, postproductionRouter)

app.listen(PORT, () => {
  console.log(`OSFPM server running on http://localhost:${PORT}`)
})
