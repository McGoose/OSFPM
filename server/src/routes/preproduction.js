import { Router } from 'express'

const router = Router()

router.get('/', (_req, res) => {
  res.json({ module: 'preproduction', status: 'stub' })
})

export default router
