import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import 'dotenv/config'
import { requireAuth } from './middleware/auth.js'
import authRouter from './routes/auth.js'
import settingsRouter from './routes/settings.js'
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
app.use('/api/settings', settingsRouter)
app.use('/api/preproduction', requireAuth, preproductionRouter)
app.use('/api/production', requireAuth, productionRouter)
app.use('/api/postproduction', requireAuth, postproductionRouter)

app.listen(PORT, () => {
  console.log(`OSFPM server running on http://localhost:${PORT}`)
})
