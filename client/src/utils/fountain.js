// Fountain screenplay format parser
// Spec: https://fountain.io/syntax

const SCENE_RE = /^(int\.?\/ext\.?|ext\.?\/int\.?|int\.?|ext\.?|i\/e\.?|est\.?)\b/i

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a .fountain string into an array of scene objects:
 * { sceneNumber, intExt, location, timeOfDay, content, pages, pageEighths }
 */
export function parseFountain(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const scenes = []
  let current = null
  let body = []
  let autoIdx = 1

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (isHeading(trimmed)) {
      if (current) {
        const content = body.join('\n').trim()
        scenes.push({ ...current, content, ...pageCount(content) })
      }
      current = parseHeading(trimmed, autoIdx++)
      body = []
    } else if (current !== null) {
      body.push(raw)
    }
  }
  if (current) {
    const content = body.join('\n').trim()
    scenes.push({ ...current, content, ...pageCount(content) })
  }

  return scenes
}

/**
 * Extract character names from a scene body.
 * Returns an array of unique ALL-CAPS names (stripped of V.O./O.S. suffixes).
 */
export function extractCharacters(content) {
  const lines = content.split('\n')
  const chars = new Set()
  for (let i = 0; i < lines.length - 1; i++) {
    const t = lines[i].trim()
    const next = lines[i + 1]?.trim()
    if (
      t &&
      /^[A-Z][A-Z0-9 '.,\-]*(\s*\([^)]*\))?$/.test(t) &&
      t.length >= 2 &&
      t.length <= 50 &&
      !t.endsWith(':') &&
      next
    ) {
      chars.add(t.replace(/\s*\([^)]*\)$/, '').trim())
    }
  }
  return [...chars]
}

/**
 * Annotate scene content lines into typed objects for rendering.
 * Types: 'action' | 'character' | 'dialogue' | 'parenthetical' | 'transition' | 'note' | 'empty'
 */
export function annotateLines(content) {
  if (!content) return []
  const lines = content.split('\n')
  const result = []
  let prev = 'empty'

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()

    if (!t) {
      result.push({ text: '', type: 'empty' })
      prev = 'empty'
      continue
    }

    // Fountain notes [[...]]
    if (t.startsWith('[[') && t.endsWith(']]')) {
      result.push({ text: t.slice(2, -2), type: 'note' })
      continue
    }

    // Centered text ^text^ (rare in scene body, treat as action)
    if (t.startsWith('^') && t.endsWith('^')) {
      result.push({ text: t.slice(1, -1), type: 'centered' })
      prev = 'action'
      continue
    }

    // Parenthetical: (text) following character / dialogue
    if (
      /^\([^)]*\)$/.test(t) &&
      (prev === 'character' || prev === 'parenthetical' || prev === 'dialogue')
    ) {
      result.push({ text: t, type: 'parenthetical' })
      prev = 'parenthetical'
      continue
    }

    // Character name: ALL CAPS, after blank/action, followed by more text
    const isAllCaps = /^[A-Z][A-Z0-9 '.,\-]*(\s*\([^)]*\))?$/.test(t)
    if (
      isAllCaps &&
      t.length >= 2 &&
      t.length <= 50 &&
      !t.endsWith(':') &&
      (prev === 'empty' || prev === 'action' || prev === 'transition' || prev === 'centered')
    ) {
      result.push({ text: t, type: 'character' })
      prev = 'character'
      continue
    }

    // Dialogue: after character or parenthetical
    if (prev === 'character' || prev === 'parenthetical' || prev === 'dialogue') {
      result.push({ text: t, type: 'dialogue' })
      prev = 'dialogue'
      continue
    }

    // Transition
    if (
      (t.endsWith('TO:') || t === 'FADE OUT.' || t === 'FADE IN.' || t === 'SMASH CUT:') &&
      t === t.toUpperCase()
    ) {
      result.push({ text: t, type: 'transition' })
      prev = 'transition'
      continue
    }

    result.push({ text: t, type: 'action' })
    prev = 'action'
  }

  return result
}

// ── Internals ────────────────────────────────────────────────────────────────

function isHeading(line) {
  if (SCENE_RE.test(line)) return true
  // Forced heading: starts with a single dot
  if (line.startsWith('.') && !line.startsWith('..') && line.length > 1) return true
  return false
}

function parseHeading(line, autoIdx) {
  const clean = line.startsWith('.') ? line.slice(1).trim() : line

  // Extract optional scene number  #42# at the end
  let sceneNumber = String(autoIdx)
  const numMatch = clean.match(/#([A-Z0-9]+)#\s*$/i)
  if (numMatch) sceneNumber = numMatch[1]
  const noNum = clean.replace(/#[A-Z0-9]+#\s*$/i, '').trim()

  // INT/EXT prefix
  const ieMatch = noNum.match(/^(int\.?\/ext\.?|ext\.?\/int\.?|int\.?|ext\.?|i\/e\.?|est\.?)\s*/i)
  const intExt = ieMatch ? normaliseIE(ieMatch[1]) : 'INT'
  const rest = noNum.slice(ieMatch ? ieMatch[0].length : 0).trim()

  // Split on last " - " to separate location from time-of-day
  const dashIdx = rest.lastIndexOf(' - ')
  const location = dashIdx !== -1 ? rest.slice(0, dashIdx).trim() : rest
  const timeStr = dashIdx !== -1 ? rest.slice(dashIdx + 3).trim() : 'DAY'

  return { sceneNumber, intExt, location, timeOfDay: normaliseTime(timeStr) }
}

function normaliseIE(str) {
  const s = str.replace(/\./g, '').toUpperCase().replace(/\s/g, '')
  if (['INT/EXT', 'EXT/INT', 'I/E', 'INTEXT', 'EXTINT', 'IE'].includes(s.replace('/', ''))) return 'INT/EXT'
  return s === 'EXT' ? 'EXT' : 'INT'
}

function normaliseTime(str) {
  const s = str.toUpperCase()
  if (s.includes('NIGHT')) return 'NIGHT'
  if (s.includes('DAWN')) return 'DAWN'
  if (s.includes('DUSK')) return 'DUSK'
  return 'DAY'
}

/**
 * Estimate page length from scene content.
 * Fountain standard: 55 lines per page (including blanks).
 * Returns { pages: number, pageEighths: number } where pageEighths is 1–8+ (1/8 increments).
 */
function pageCount(content) {
  if (!content) return { pages: 0.125, pageEighths: 1 }
  const totalLines = content.split('\n').length
  // Round to nearest 1/8 page, minimum 1/8
  const eighths = Math.max(1, Math.round((totalLines / 55) * 8))
  return {
    pages: eighths / 8,
    pageEighths: eighths,
  }
}
