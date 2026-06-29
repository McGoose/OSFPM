// Multi-format script parser.
// Returns the same scene shape as parseFountain: { sceneNumber, intExt, location, timeOfDay, content, pages, pageEighths, characters[] }
// Supported formats: .fountain, .fdx (Final Draft), .fadein (Fade In), .xml (auto-detected)

import { parseFountain, extractCharacters } from './fountain.js'

// ── Shared heading utilities ──────────────────────────────────────────────────

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

const SCENE_RE = /^(int\.?\/ext\.?|ext\.?\/int\.?|int\.?|ext\.?|i\/e\.?|est\.?)\b/i

function parseHeadingText(raw, fallbackNum) {
  const clean = raw.trim()
  const numMatch = clean.match(/#([A-Z0-9]+)#\s*$/i)
  const sceneNumber = numMatch ? numMatch[1] : String(fallbackNum)
  const noNum = clean.replace(/#[A-Z0-9]+#\s*$/i, '').trim()

  const ieMatch = noNum.match(/^(int\.?\/ext\.?|ext\.?\/int\.?|int\.?|ext\.?|i\/e\.?|est\.?)\s*/i)
  const intExt = ieMatch ? normaliseIE(ieMatch[1]) : 'INT'
  const rest = noNum.slice(ieMatch ? ieMatch[0].length : 0).trim()

  const dashIdx = rest.lastIndexOf(' - ')
  const location = dashIdx !== -1 ? rest.slice(0, dashIdx).trim() : rest
  const timeStr = dashIdx !== -1 ? rest.slice(dashIdx + 3).trim() : 'DAY'

  return { sceneNumber, intExt, location, timeOfDay: normaliseTime(timeStr) }
}

function pageCount(content) {
  if (!content) return { pages: 0.125, pageEighths: 1 }
  const totalLines = content.split('\n').length
  const eighths = Math.max(1, Math.round((totalLines / 55) * 8))
  return { pages: eighths / 8, pageEighths: eighths }
}

function withCharacters(scenes) {
  return scenes.map(s => ({ ...s, characters: extractCharacters(s.content ?? '') }))
}

// ── Final Draft .fdx parser ───────────────────────────────────────────────────
// FDX is XML with <Paragraph Type="Scene Heading"> elements.

function parseFdx(text) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(text, 'application/xml')
  if (doc.querySelector('parseerror, parsererror')) {
    throw new Error('Could not parse Final Draft file — the XML appears to be corrupt.')
  }

  const paragraphs = Array.from(doc.querySelectorAll('Paragraph'))
  const sceneList = []
  let current = null
  let body = []
  let autoIdx = 1

  for (const para of paragraphs) {
    const type = para.getAttribute('Type')
    // Text content may be split across multiple <Text> children
    const rawText = Array.from(para.querySelectorAll('Text'))
      .map(t => t.textContent)
      .join('')
      .trim()

    if (type === 'Scene Heading' && rawText) {
      if (current) {
        const content = body.join('\n').trim()
        sceneList.push({ ...current, content, ...pageCount(content) })
      }
      // Number may come from attribute or from scene properties child
      const numAttr = para.getAttribute('Number') ||
        para.querySelector('SceneProperties')?.getAttribute('Number') ||
        null
      current = parseHeadingText(rawText, numAttr ?? autoIdx++)
      body = []
    } else if (current !== null && rawText) {
      if (type === 'Character') body.push(rawText)
      else if (type === 'Dialogue') body.push(rawText)
      else if (type === 'Parenthetical') body.push(rawText)
      else if (type === 'Action') body.push(rawText)
      else if (type === 'Transition') body.push(rawText)
    }
  }

  if (current) {
    const content = body.join('\n').trim()
    sceneList.push({ ...current, content, ...pageCount(content) })
  }

  return sceneList
}

// ── Fade In .fadein / Fade In XML parser ──────────────────────────────────────
// Modern Fade In .fadein files are ZIP archives — we can't read those without
// a ZIP library. Plain-XML Fade In exports use <paragraphs><para style="...">

function parseFadeIn(text) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(text, 'application/xml')
  if (doc.querySelector('parseerror, parsererror')) {
    throw new Error('Could not parse Fade In file. If your .fadein file is not opening, please export it as .fountain or .fdx from Fade In and import that instead.')
  }

  const paras = Array.from(doc.querySelectorAll('para'))
  const sceneList = []
  let current = null
  let body = []
  let autoIdx = 1

  for (const para of paras) {
    const style = para.getAttribute('style') ?? ''
    const textEl = para.querySelector('text')
    const rawText = textEl?.textContent?.trim() ?? ''

    if (/scene heading/i.test(style) && rawText) {
      if (current) {
        const content = body.join('\n').trim()
        sceneList.push({ ...current, content, ...pageCount(content) })
      }
      current = parseHeadingText(rawText, autoIdx++)
      body = []
    } else if (current !== null && rawText) {
      body.push(rawText)
    }
  }

  if (current) {
    const content = body.join('\n').trim()
    sceneList.push({ ...current, content, ...pageCount(content) })
  }

  return sceneList
}

// ── Format detection ──────────────────────────────────────────────────────────

export function detectFormat(filename, content) {
  const ext = filename.split('.').pop().toLowerCase()
  if (ext === 'fountain' || ext === 'txt') return 'fountain'
  if (ext === 'fdx') return 'fdx'
  if (ext === 'fadein') return 'fadein'
  if (ext === 'xml') {
    if (content.includes('FinalDraft') || content.includes('<Paragraph')) return 'fdx'
    if (content.includes('<paragraphs>') || content.includes('<para ')) return 'fadein'
    return 'fdx' // best guess for unknown XML
  }
  return 'unknown'
}

// ── Main dispatch ─────────────────────────────────────────────────────────────

/**
 * Parse a script file into a scene array.
 * @param {string} filename
 * @param {string} content  file text (read as UTF-8)
 * @returns {{ scenes: object[], format: string }}
 */
export function parseScript(filename, content) {
  // ZIP magic bytes — Fade In 3.x zipped format
  if (content.charCodeAt(0) === 0x50 && content.charCodeAt(1) === 0x4B) {
    throw new Error(
      'This .fadein file is in zip format and cannot be read directly. ' +
      'In Fade In, go to File → Export and choose .fountain or .fdx, then import that file.'
    )
  }

  const format = detectFormat(filename, content)

  switch (format) {
    case 'fountain':
      return { scenes: withCharacters(parseFountain(content)), format: 'fountain' }
    case 'fdx':
      return { scenes: withCharacters(parseFdx(content)), format: 'fdx' }
    case 'fadein':
      return { scenes: withCharacters(parseFadeIn(content)), format: 'fadein' }
    default:
      throw new Error(
        `Unrecognised format for "${filename}". Supported formats: .fountain, .fdx, .fadein, .xml`
      )
  }
}
