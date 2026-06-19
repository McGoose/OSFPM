import { Router } from 'express'

const router = Router()

router.get('/', (_req, res) => {
  res.json({ module: 'production', status: 'stub' })
})

export default router
