/**
 * Relative-coordinate geometry for a RIVALS Tab scoreboard, ported from
 * `ocr/rivals_ocr/layout.py`.
 *
 * Rows are found from the team-colour stripes, never from fixed pixels, so any
 * resolution works. A row's team comes from which colour dominates its stripe.
 * The DMG column is located from the header text; when the header cannot be read
 * the damage is reported as missing instead of guessed.
 *
 * The thresholds below are the server's, unchanged: the port exists so the same
 * rules run on the user's device instead of on a server.
 */

import type { Bitmap, Box } from './image'

// OpenCV hue is 0-179: gold sits near 21, purple near 130.
const GOLD_LOW = [8, 70, 90] as const
const GOLD_HIGH = [38, 255, 255] as const
const PURPLE_LOW = [115, 60, 60] as const
const PURPLE_HIGH = [165, 255, 255] as const
// The score strip prints its numerals in white; nothing else above the table is
// both that bright and that unsaturated.
const SCORE_INK_VALUE = 190
const SCORE_INK_SATURATION = 70

const FULL_NUMBER = /^\d{1,6}$/
const SCORE_NUMBER = /^\d{1,3}$/
const RANK_NUMBER = /^\d{1,2}$/
// Icons and colour blocks beside a number are often merged into its detection
// ("▣5"); non-word noise around the digits is ignored, letters are not.
const NUMBER_NOISE = /^[^\w]*(\d[\d,\s.]*)[^\w]*$/

/** A final row cut down to less than this share of a normal row is off screen. */
const CLIPPED_ROW_RATIO = 0.7

export type TeamColor = 'gold' | 'purple'
export type Mask = Uint8Array

export type TextLine = {
  text: string
  confidence: number
  /** x0, y0, x1, y1 in the screenshot's coordinates. */
  box: Box
}

export type Row = {
  index: number
  y0: number
  y1: number
  x0: number
  x1: number
  color: TeamColor | null
  colorConfidence: number
}

export type Layout = {
  rows: Row[]
  panel: Box
  header: Box | null
  score: Box | null
  rowHeight: number
  table: Box
}

export type DamageColumn = {
  center: number
  tolerance: number
  confidence: number
  /** x where the damage column ends: nothing right of it is needed. */
  right: number | null
}

export type RowText = {
  username: string | null
  usernameConfidence: number
  damage: number | null
  damageConfidence: number
  rawDamage: string | null
  empty: boolean
}

export class ScoreboardError extends Error {
  readonly code = 'scoreboard_not_found'
  readonly status = 422
}

export type Hsv = { h: Uint8Array; s: Uint8Array; v: Uint8Array; width: number; height: number }

/** RGBA → OpenCV-style HSV (H 0-179, S 0-255, V 0-255). */
export function toHsv(image: Bitmap): Hsv {
  const { width, height, data } = image
  const h = new Uint8Array(width * height)
  const s = new Uint8Array(width * height)
  const v = new Uint8Array(width * height)
  for (let index = 0, p = 0; index < h.length; index += 1, p += 4) {
    const r = data[p]!
    const g = data[p + 1]!
    const b = data[p + 2]!
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const delta = max - min
    v[index] = max
    s[index] = max === 0 ? 0 : Math.round((delta / max) * 255)
    if (delta === 0) {
      h[index] = 0
      continue
    }
    // Standard HSV sector angles: red 0, green 120, blue 240. A blue-dominant
    // pixel is 240 and up, not 180: with the wrong sector every purple stripe in
    // a RIVALS board (hue ~128 here) would land near 98 and vanish.
    let degrees: number
    if (max === r) degrees = 60 * ((g - b) / delta)
    else if (max === g) degrees = 120 + 60 * ((b - r) / delta)
    else degrees = 240 + 60 * ((r - g) / delta)
    const opencv = ((Math.round(degrees / 2) % 180) + 180) % 180
    h[index] = opencv
  }
  return { h, s, v, width, height }
}

function inRange(hsv: Hsv, low: readonly number[], high: readonly number[]): Mask {
  const mask = new Uint8Array(hsv.width * hsv.height)
  for (let index = 0; index < mask.length; index += 1) {
    const hue = hsv.h[index]!
    const sat = hsv.s[index]!
    const val = hsv.v[index]!
    if (
      hue >= low[0]! && hue <= high[0]! &&
      sat >= low[1]! && sat <= high[1]! &&
      val >= low[2]! && val <= high[2]!
    )
      mask[index] = 255
  }
  return mask
}

/** 3×3 dilate (or erode) with edge replication — `MORPH_CLOSE` in two passes. */
function morph(mask: Mask, width: number, height: number, dilate: boolean): Mask {
  const out = new Uint8Array(mask.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = dilate ? 0 : 255
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = Math.min(height - 1, Math.max(0, y + dy))
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = Math.min(width - 1, Math.max(0, x + dx))
          const sample = mask[yy * width + xx]!
          value = dilate ? (sample > value ? sample : value) : sample < value ? sample : value
        }
      }
      out[y * width + x] = value
    }
  }
  return out
}

/** `MORPH_CLOSE` on each colour mask, then their union. */
export function masks(hsv: Hsv): { gold: Mask; purple: Mask; combined: Mask } {
  const close = (low: readonly number[], high: readonly number[]): Mask =>
    morph(
      morph(inRange(hsv, low, high), hsv.width, hsv.height, true),
      hsv.width,
      hsv.height,
      false,
    )
  const gold = close(GOLD_LOW, GOLD_HIGH)
  const purple = close(PURPLE_LOW, PURPLE_HIGH)
  const combined = new Uint8Array(gold.length)
  for (let index = 0; index < combined.length; index += 1)
    combined[index] = gold[index]! | purple[index]!
  return { gold, purple, combined }
}

type Run = [number, number]

function runs(flags: Uint8Array | boolean[]): Run[] {
  const found: Run[] = []
  let start: number | null = null
  for (let index = 0; index < flags.length; index += 1) {
    const value = Boolean(flags[index])
    if (value && start === null) start = index
    else if (!value && start !== null) {
      found.push([start, index])
      start = null
    }
  }
  if (start !== null) found.push([start, flags.length])
  return found
}

function merge(list: Run[], gap: number): Run[] {
  const merged: Run[] = []
  for (const [y0, y1] of list) {
    const last = merged[merged.length - 1]
    if (last && y0 - last[1] <= gap) last[1] = y1
    else merged.push([y0, y1])
  }
  return merged
}

/** Groups coloured columns, tolerating gaps of up to `gap` pixels. */
function columnSpans(columns: number[], gap: number): Run[] {
  const spans: Run[] = []
  let start: number | null = null
  let last = 0
  for (const index of columns) {
    if (start === null) start = last = index
    else if (index - last <= gap) last = index
    else {
      spans.push([start, last + 1])
      start = last = index
    }
  }
  if (start !== null) spans.push([start, last + 1])
  return spans
}

/** Per-row count of set pixels inside a horizontal slice. */
function rowCounts(mask: Mask, width: number, x0: number, x1: number, y0: number, y1: number): number[] {
  const counts: number[] = new Array(Math.max(0, y1 - y0)).fill(0)
  for (let y = y0; y < y1; y += 1) {
    let count = 0
    for (let x = x0; x < x1; x += 1) if (mask[y * width + x]) count += 1
    counts[y - y0] = count
  }
  return counts
}

function bands(combined: Mask, width: number, height: number): Box[] {
  const counts = rowCounts(combined, width, 0, width, 0, height)
  const flags = new Uint8Array(height)
  const floor = Math.max(6, width * 0.12)
  for (let y = 0; y < height; y += 1) flags[y] = counts[y]! >= floor ? 1 : 0

  const found: Box[] = []
  for (const [y0, y1] of merge(runs(flags), Math.max(1, Math.round(height * 0.003)))) {
    if (y1 - y0 < Math.max(6, Math.round(height * 0.01))) continue
    const columns: number[] = []
    const need = Math.max(2, (y1 - y0) * 0.3)
    for (let x = 0; x < width; x += 1) {
      let count = 0
      for (let y = y0; y < y1; y += 1) if (combined[y * width + x]) count += 1
      if (count >= need) columns.push(x)
    }
    if (!columns.length) continue
    const x0 = columns[0]!
    const x1 = columns[columns.length - 1]! + 1
    if (x1 - x0 < width * 0.25) continue
    // A player row is one continuous stripe. The HUD score boxes sit on the same
    // line but far apart, so a band made of separated blobs is not a row.
    const widest = Math.max(
      ...columnSpans(columns, Math.max(2, Math.round(width * 0.01))).map(([a, b]) => b - a),
    )
    if (widest < (x1 - x0) * 0.8) continue
    found.push([x0, y0, x1, y1])
  }
  return found
}

/** Splits a striped band where the team colour changes. */
function colorRuns(gold: Mask, purple: Mask, band: Box, width: number): Run[] {
  const [x0, y0, x1, y1] = band
  const goldCounts = rowCounts(gold, width, x0, x1, y0, y1)
  const purpleCounts = rowCounts(purple, width, x0, x1, y0, y1)
  const joinGap = Math.max(2, Math.round((y1 - y0) * 0.04))
  const found: [number, number, 0 | 1][] = []
  for (let offset = 0; offset < goldCounts.length; offset += 1) {
    const goldCount = goldCounts[offset]!
    const purpleCount = purpleCounts[offset]!
    let label: 0 | 1 | null = null
    if (goldCount > 0 && goldCount >= purpleCount * 1.6) label = 0
    else if (purpleCount > 0 && purpleCount >= goldCount * 1.6) label = 1
    if (label === null) continue
    const top = y0 + offset
    const last = found[found.length - 1]
    if (last && last[2] === label && top - last[1] <= joinGap) last[1] = top + 1
    else found.push([top, top + 1, label])
  }
  return found.filter(([start, end]) => end - start >= 6).map(([start, end]) => [start, end])
}

function classify(
  gold: Mask,
  purple: Mask,
  width: number,
  y0: number,
  y1: number,
  x0: number,
  x1: number,
): { color: TeamColor | null; confidence: number } {
  const area = Math.max(1, (y1 - y0) * (x1 - x0))
  let goldCount = 0
  let purpleCount = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = y * width + x
      if (gold[index]) goldCount += 1
      if (purple[index]) purpleCount += 1
    }
  }
  const total = goldCount + purpleCount
  if (total < area * 0.08) return { color: null, confidence: 0 }
  if (goldCount >= purpleCount * 1.6) return { color: 'gold', confidence: goldCount / total }
  if (purpleCount >= goldCount * 1.6) return { color: 'purple', confidence: purpleCount / total }
  return { color: null, confidence: Math.max(goldCount, purpleCount) / total }
}

type Component = { x: number; y: number; w: number; h: number; area: number }

/** 8-connected components of a binary mask inside `rows` (top of the screen). */
function components(mask: Mask, width: number, height: number, rows: number): Component[] {
  const seen = new Uint8Array(width * rows)
  const found: Component[] = []
  const stack: number[] = []
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x
      if (!mask[start] || seen[start]) continue
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      let area = 0
      stack.push(start)
      seen[start] = 1
      while (stack.length) {
        const index = stack.pop()!
        const cy = Math.floor(index / width)
        const cx = index - cy * width
        area += 1
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = cy + dy
          if (yy < 0 || yy >= rows) continue
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = cx + dx
            if (xx < 0 || xx >= width) continue
            const next = yy * width + xx
            if (mask[next] && !seen[next]) {
              seen[next] = 1
              stack.push(next)
            }
          }
        }
      }
      found.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area })
    }
  }
  void height
  return found
}

/**
 * The strip that holds the two team scores, when the screenshot has one.
 *
 * The scores are printed in white and are the largest thing printed above the
 * table, so the first band of white text above it is the score strip. Finding it
 * by its colour instead does not work on a real 4v4 capture: the map behind the
 * HUD is gold there too, and the search swallowed the whole upper screen.
 */
function scoreHud(hsv: Hsv, tableTop: number, width: number): Box | null {
  if (tableTop < 8) return null
  const limit = Math.max(8, Math.round(tableTop * 0.4))
  const ink = new Uint8Array(width * hsv.height)
  for (let y = 0; y < limit; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (hsv.v[index]! >= SCORE_INK_VALUE && hsv.s[index]! <= SCORE_INK_SATURATION) ink[index] = 255
    }
  }
  const boxes = components(ink, width, hsv.height, limit)
    // A score is a tall, narrow glyph. A bright sky is neither.
    .filter((entry) => entry.h >= 24 && entry.w >= 8 && entry.w <= width * 0.15 && entry.area >= 200)
    .map((entry) => [entry.x, entry.y, entry.x + entry.w, entry.y + entry.h] as Box)
  if (!boxes.length) return null
  const x0 = Math.min(...boxes.map((box) => box[0]))
  const y0 = Math.min(...boxes.map((box) => box[1]))
  const x1 = Math.max(...boxes.map((box) => box[2]))
  const y1 = Math.max(...boxes.map((box) => box[3]))
  const pad = Math.max(6, Math.round((y1 - y0) * 0.2))
  return [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(width, x1 + pad), Math.min(hsv.height, y1 + pad)]
}

/** Each team's coloured score box, read on its own. */
export function scoreRegions(
  gold: Mask,
  purple: Mask,
  band: Box | null,
  width: number,
): Partial<Record<TeamColor, Box>> {
  if (band === null) return {}
  const [x0, y0, x1, y1] = band
  const regions: Partial<Record<TeamColor, Box>> = {}
  for (const [color, mask] of [
    ['gold', gold],
    ['purple', purple],
  ] as const) {
    // A box is at least ~40 px tall; capping the share keeps a plain box found
    // when the band also caught something else, like a bright sky.
    const minimum = Math.max(2, Math.min((y1 - y0) * 0.2, 25))
    // Columns are stored relative to the band, then offset once below: the band
    // does not start at x=0, and adding its left edge twice moves every score box
    // onto the round timer.
    const columns: number[] = []
    for (let x = x0; x < x1; x += 1) {
      let count = 0
      for (let y = y0; y < y1; y += 1) if (mask[y * width + x]) count += 1
      if (count >= minimum) columns.push(x - x0)
    }
    if (!columns.length) continue
    // A score numeral is drawn over its box, so the box's columns have a hole in
    // them; the gap is bridged here instead of splitting the box in two.
    const spans = columnSpans(columns, Math.max(4, Math.round(width * 0.04)))
    const widest = spans.reduce((best, span) => (span[1] - span[0] > best[1] - best[0] ? span : best), spans[0]!)
    const [start, end] = widest
    if (end - start < Math.max(12, width * 0.02)) continue
    const pad = Math.max(3, Math.round((y1 - y0) * 0.08))
    regions[color] = [
      Math.max(0, x0 + start - pad),
      Math.max(0, y0 - pad),
      Math.min(width, x0 + end + pad),
      Math.min(gold.length / width, y1 + pad),
    ]
  }
  return regions
}

export function analyze(hsv: Hsv): Layout {
  const { width, height } = hsv
  const { gold, purple, combined } = masks(hsv)
  const found = bands(combined, width, height)
  if (!found.length) throw new ScoreboardError('No RIVALS scoreboard was found in that screenshot.')

  const rows: Row[] = []
  for (const band of found) {
    const parts = colorRuns(gold, purple, band, width)
    for (const [runY0, runY1] of parts.length ? parts : [[band[1], band[3]] as Run]) {
      const { color, confidence } = classify(gold, purple, width, runY0, runY1, band[0], band[2])
      rows.push({
        index: rows.length,
        y0: runY0,
        y1: runY1,
        x0: band[0],
        x1: band[2],
        color,
        colorConfidence: confidence,
      })
    }
  }

  // Every row crop starts at the same x, so the DMG column located in the header
  // lines up with the numbers in a row crop.
  const x0 = Math.min(...rows.map((row) => row.x0))
  const x1 = Math.max(...rows.map((row) => row.x1))
  for (const row of rows) {
    row.x0 = x0
    row.x1 = x1
  }

  const heights = rows.map((row) => row.y1 - row.y0).sort((a, b) => a - b)
  const rowHeight = Math.max(1, Math.round(heights[Math.floor(heights.length / 2)]!))

  const first = rows[0]!
  // The score strip sits somewhere above the table; everything above the first
  // row is searched, because on a 4v4 capture it floats well down the screen.
  let score = scoreHud(hsv, first.y0, width)
  // The header labels sit just above the first row, below the score strip. The
  // row height is only an estimate here (a colour band can hold several rows), so
  // the strip's own bottom is what keeps the header band small.
  let headerTop = Math.max(0, first.y0 - rowHeight)
  if (score !== null) headerTop = Math.max(headerTop, score[3])
  const header: Box | null = first.y0 - headerTop >= 8 ? [x0, headerTop, x1, first.y0] : null
  if (score === null) score = headerTop >= 8 ? [x0, 0, x1, headerTop] : null

  return {
    rows,
    panel: [x0, 0, x1, rows[rows.length - 1]!.y1],
    header,
    score,
    rowHeight,
    table: [x0, rows[0]!.y0, x1, rows[rows.length - 1]!.y1],
  }
}

function centreY(line: TextLine): number {
  return (line.box[1] + line.box[3]) / 2
}

function clusterCentre(cluster: TextLine[]): number {
  return (Math.min(...cluster.map((line) => line.box[1])) + Math.max(...cluster.map((line) => line.box[3]))) / 2
}

/**
 * Groups recognised lines into one cluster per row of text.
 *
 * A player row prints the display name above its @handle; those two lines sit a
 * couple of pixels apart, while the next player's text starts far below. The gap
 * between lines is what separates rows, not the height of any one line.
 */
function textClusters(lines: TextLine[]): TextLine[][] {
  const tokens = lines.filter((line) => line.text.trim().length > 0)
  if (!tokens.length) return []
  tokens.sort((a, b) => centreY(a) - centreY(b))
  const heights = tokens.map((line) => Math.max(1, line.box[3] - line.box[1])).sort((a, b) => a - b)
  const join = Math.max(4, heights[Math.floor(heights.length / 2)]! * 0.5)
  const clusters: TextLine[][] = []
  for (const line of tokens) {
    const last = clusters[clusters.length - 1]
    if (last && line.box[1] - Math.max(...last.map((entry) => entry.box[3])) <= join) last.push(line)
    else clusters.push([line])
  }
  return clusters
}

/** The smallest distance between two rows of text: one row's height. */
function rowPitch(centres: number[]): number | null {
  const gaps: number[] = []
  for (let index = 0; index + 1 < centres.length; index += 1) {
    const gap = centres[index + 1]! - centres[index]!
    if (gap >= 12) gaps.push(gap)
  }
  return gaps.length ? Math.min(...gaps) : null
}

/**
 * Splits a row band that holds several players, one row per player.
 *
 * Two players on the same team sit on the same colour with no seam between them,
 * so their stripes merge into one tall band: a 4v4 board can show four gold
 * players as a single block. Their text does not merge, because each player has
 * their own name and damage line, so the text decides where one player ends and
 * the next begins.
 */
export function refineRows(rows: Row[], lines: TextLine[]): Row[] {
  const clusters = textClusters(lines)
  const centres = clusters.map(clusterCentre)
  let pitch = rowPitch(centres)
  if (pitch === null) {
    const heights = rows.map((row) => row.y1 - row.y0).sort((a, b) => a - b)
    pitch = heights[Math.floor(heights.length / 2)] ?? 1
  }

  const refined: Row[] = []
  for (const row of rows) {
    const inside = centres.filter((centre) => row.y0 <= centre && centre < row.y1)
    let edges: number[]
    if (inside.length > 1) {
      edges = [row.y0]
      for (let index = 0; index + 1 < inside.length; index += 1)
        edges.push(Math.round((inside[index]! + inside[index + 1]!) / 2))
      edges.push(row.y1)
    } else {
      const span = row.y1 - row.y0
      const parts = Math.max(1, Math.min(Math.round(span / Math.max(1, pitch)), Math.floor(span / 12)))
      const step = span / parts
      edges = Array.from({ length: parts }, (_value, index) => Math.round(row.y0 + index * step))
      edges.push(row.y1)
    }
    for (let index = 0; index + 1 < edges.length; index += 1) {
      const top = edges[index]!
      const bottom = edges[index + 1]!
      if (bottom - top < 6) continue
      refined.push({
        index: refined.length,
        y0: top,
        y1: bottom,
        x0: row.x0,
        x1: row.x1,
        color: row.color,
        colorConfidence: row.colorConfidence,
      })
    }
  }
  return dropClipped(refined)
}

/**
 * A last row cut off by the bottom of the panel is not fully on screen.
 *
 * The list scrolls, so the player at the bottom edge is only half drawn, and half
 * of a row is not a result. It is ignored rather than measured or guessed.
 */
function dropClipped(rows: Row[]): Row[] {
  if (rows.length < 2) return rows
  const heights = rows.map((row) => row.y1 - row.y0).sort((a, b) => a - b)
  const typical = heights[Math.floor(heights.length / 2)]!
  const last = rows[rows.length - 1]!
  return last.y1 - last.y0 < typical * CLIPPED_ROW_RATIO ? rows.slice(0, -1) : rows
}

/** Locates the DMG column from its header label, rejecting EDA and PING. */
export function damageColumn(lines: TextLine[], rowHeight: number): DamageColumn | null {
  for (const line of lines) {
    const key = line.text.toLowerCase().replace(/[^a-z]/g, '')
    if (key !== 'dmg' && key !== 'damage') continue
    const [left, , right] = line.box
    const center = (left + right) / 2
    const half = Math.max((right - left) / 2, rowHeight * 0.3)
    // The next column's label marks where damage ends; everything right of it
    // (EDA, PING) is noise for the rows and is left out of their crop.
    let boundary: number | null = null
    for (const other of lines) {
      const otherKey = other.text.toLowerCase().replace(/[^a-z]/g, '')
      if (!['eda', 'ping', 'kills', 'assists'].includes(otherKey)) continue
      if (other.box[0] <= right) continue
      boundary = boundary === null ? other.box[0] : Math.min(boundary, other.box[0])
    }
    return {
      center,
      tolerance: Math.max(rowHeight * 0.6, half + 4),
      confidence: line.confidence,
      right: boundary === null ? null : boundary - 4,
    }
  }
  return null
}

function digits(text: string): string | null {
  const match = NUMBER_NOISE.exec(text.trim())
  if (!match) return null
  return match[1]!.replace(/[,\s.]/g, '')
}

function cleanNumber(text: string): number | null {
  const compact = digits(text)
  return compact !== null && FULL_NUMBER.test(compact) ? Number(compact) : null
}

function cluster(lines: TextLine[], gap: number): TextLine[][] {
  const ordered = [...lines].sort((a, b) => a.box[0] - b.box[0])
  const groups: TextLine[][] = []
  for (const line of ordered) {
    const last = groups[groups.length - 1]
    const previous = last?.[last.length - 1]
    if (previous && line.box[0] - previous.box[2] <= gap) last!.push(line)
    else groups.push([line])
  }
  return groups
}

/** The widest cluster on the name side: badges and rank columns are narrower. */
function widestGroup(lines: TextLine[], gap: number): TextLine[] {
  const groups = cluster(lines, gap)
  if (!groups.length) return []
  let best = groups[0]!
  let bestWidth = -1
  for (const group of groups) {
    const width = group.reduce((total, line) => total + (line.box[2] - line.box[0]), 0)
    if (width > bestWidth) {
      best = group
      bestWidth = width
    }
  }
  return best
}

/** Joins the tokens of one name, spacing them only at a real word gap. */
function join(lines: TextLine[], prefix = ''): string {
  const parts: string[] = []
  let previous: TextLine | null = null
  for (const line of lines) {
    let text = line.text.trim()
    if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length).trim()
    if (!text) continue
    if (previous) {
      const gap = line.box[0] - previous.box[2]
      const height = Math.max(1, previous.box[3] - previous.box[1])
      if (gap > height * 0.5) parts.push(' ')
    }
    parts.push(text)
    previous = line
  }
  return parts.join('').trim()
}

/**
 * The tokens a recogniser split off the end of a handle.
 *
 * A handle is one word, but the detector can cut it at a glyph it is unsure of:
 * `@destruction_lord9` comes back as `@destruction_` and `lord9`. Only the
 * `@`-prefixed token used to be read, so the rest of the name was dropped and the
 * row carried a truncated handle. Anything on the handle's own printed line,
 * immediately after it, belongs to the handle; the display name above it and any
 * number (the damage column) do not.
 */
function handleTail(head: TextLine[], left: TextLine[], gap: number): TextLine[] {
  const last = head[head.length - 1]
  if (!last) return []
  const height = Math.max(1, last.box[3] - last.box[1])
  const reach = Math.max(gap, height * 2)
  const middle = (line: TextLine) => (line.box[1] + line.box[3]) / 2
  const rest = left
    .filter(
      (line) =>
        !head.includes(line) &&
        !line.text.trim().startsWith('@') &&
        cleanNumber(line.text) === null,
    )
    .sort((a, b) => a.box[0] - b.box[0])
  const tail: TextLine[] = []
  let edge = last.box[2]
  for (const line of rest) {
    if (line.box[0] < edge - 2) continue
    if (line.box[0] - edge > reach) break
    // The same printed line, not merely an overlapping box: the display name
    // above a handle overlaps it by a pixel or two.
    if (Math.abs(middle(line) - middle(last)) > height * 0.6) continue
    tail.push(line)
    edge = line.box[2]
  }
  return tail
}

export function parseRow(lines: TextLine[], column: DamageColumn | null, rowHeight: number): RowText {
  const tokens = lines.filter((line) => line.text.trim().length > 0)
  if (!tokens.length) return { username: null, usernameConfidence: 0, damage: null, damageConfidence: 0, rawDamage: null, empty: true }

  let damage: number | null = null
  let raw: string | null = null
  let damageConfidence = 0
  if (column) {
    const candidates: { confidence: number; value: number; text: string }[] = []
    for (const line of tokens) {
      const value = cleanNumber(line.text)
      if (value === null) continue
      const center = (line.box[0] + line.box[2]) / 2
      if (Math.abs(center - column.center) <= column.tolerance)
        candidates.push({ confidence: line.confidence, value, text: line.text.trim() })
    }
    if (candidates.length) {
      candidates.sort((a, b) => b.confidence - a.confidence)
      damageConfidence = candidates[0]!.confidence
      damage = candidates[0]!.value
      raw = candidates[0]!.text
    }
  }

  // Usernames sit left of the damage column. A rank column is a short integer.
  const limit = column ? column.center - column.tolerance * 0.5 : Number.POSITIVE_INFINITY
  let left = tokens.filter(
    (line) => (line.box[0] + line.box[2]) / 2 < limit && !RANK_NUMBER.test(line.text.trim()),
  )
  if (!left.length) left = tokens.filter((line) => cleanNumber(line.text) === null)

  // The board prints the display name above the player's Roblox @handle. The
  // roster is indexed by the handle, so the @ line is the username when it is
  // printed; the display name is only used for players who have no handle line.
  const gap = Math.max(rowHeight * 0.6, 8)
  const handles = left.filter((line) => line.text.trim().startsWith('@'))
  let group: TextLine[] = []
  let username: string | null = null
  if (handles.length) {
    const head = widestGroup(handles, gap)
    group = [...head, ...handleTail(head, left, gap)]
    username = join(group, '@') || null
  } else if (left.length) {
    const tallest = Math.max(...left.map((line) => line.box[3] - line.box[1]))
    const primary = left.filter((line) => line.box[3] - line.box[1] >= tallest * 0.75)
    group = widestGroup(primary.length ? primary : left, gap)
    username = join(group) || null
  }

  const usernameConfidence = group.length
    ? group.reduce((total, line) => total + line.confidence, 0) / group.length
    : 0

  return {
    username,
    usernameConfidence: Math.min(1, Math.max(0, usernameConfidence)),
    damage,
    damageConfidence: damage === null ? 0 : Math.min(1, Math.max(0, damageConfidence)),
    rawDamage: raw,
    empty: false,
  }
}

/**
 * The one score in a team's box: its largest numeral.
 *
 * A box can also hold a coin badge, a level or its team-mates' avatars. Those are
 * drawn smaller than the score, so the tallest numeral wins; a box with no
 * numeral is missing, never zero.
 */
export function readScoreNumber(lines: TextLine[], minHeight = 0): { value: number | null; confidence: number } {
  let best: { height: number; value: number; confidence: number } | null = null
  for (const line of lines) {
    const value = digits(line.text)
    if (value === null || !SCORE_NUMBER.test(value)) continue
    if (line.confidence < 0.4) continue
    const height = line.box[3] - line.box[1]
    if (height < minHeight) continue
    if (!best || height > best.height || (height === best.height && line.confidence > best.confidence))
      best = { height, value: Number(value), confidence: line.confidence }
  }
  if (!best) return { value: null, confidence: 0 }
  return { value: best.value, confidence: Math.min(1, Math.max(0, best.confidence)) }
}
