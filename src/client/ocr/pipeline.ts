/**
 * Stage order for the in-browser scan, ported from `ocr/rivals_ocr/pipeline.py`.
 *
 * The pipeline never talks to a model directly: it asks a `TextReader` for lines,
 * so the geometry is verified with a fixture reader and the engine stays
 * replaceable. On the client the only reader is the browser PaddleOCR.
 */

import { cropBitmap, upscaleBitmap, type Bitmap, type Box } from './image'
import {
  analyze,
  damageColumn,
  masks,
  parseRow,
  readScoreNumber,
  refineRows,
  scoreRegions,
  toHsv,
  type DamageColumn,
  type Row,
  type TeamColor,
  type TextLine,
} from './layout'

export const SCAN_VERSION = 1

/** The score is a large glyph next to small ones: read at 4x from a small crop. */
const SCORE_UPSCALE = 4
const SCORE_FACE = 0.35
const SCORE_MIN_WIDTH = 80
/** A score stands about half the box tall. Anything shorter is a coin badge. */
const SCORE_MIN_HEIGHT = 0.4

/**
 * A small board is read enlarged.
 *
 * On a 1v1 board shrunk into a small window the table is 76 px tall and a name is
 * about 11 px, which is below the recogniser's acuity: the table pass returns
 * garbage (`10乐 PVPDreadlord`). The same crop at 4x reads every name exactly, so
 * a table shorter than this is upscaled and its boxes divided back down.
 */
const TABLE_MIN_HEIGHT = 200
const TABLE_UPSCALE = 4
/** Never blow a table up past this many pixels on its longest side. */
const TABLE_MAX_SIDE = 1600

/** Enlargement for one row, when the table pass read its name badly. */
const ROW_UPSCALE = 4
/** Rows re-read per screenshot, so a broken board cannot stall the scan. */
const MAX_ROW_REREADS = 8

const hasHandle = (lines: TextLine[]) => lines.some((line) => line.text.trim().startsWith('@'))

/**
 * The character a complete handle ends on.
 *
 * They are letters, digits and underscores, and a handle never ends on the
 * separator in the middle of it. When a read does end there, the recogniser
 * stopped early — `@destruction_lord9` arrived as `destruction_` — and the row
 * gets the same enlarged second look a missing handle gets.
 */
const HANDLE_END = /[a-z0-9]$/i

export type TextReader = {
  name: string
  read(image: Bitmap, region?: string): Promise<TextLine[]>
}

export type ScanIssue = {
  code: string
  message: string
  rowIndex?: number
  field?: string
}

export type ScanDocument = {
  version: number
  image: { width: number; height: number }
  teams: { slot: number; color: TeamColor; score: number | null; confidence: number }[]
  winnerSlot: number | null
  rows: {
    index: number
    teamSlot: number | null
    color: TeamColor | null
    username: string | null
    usernameConfidence: number
    damage: number | null
    damageConfidence: number
    rawDamageText: string | null
    issues: ScanIssue[]
  }[]
  issues: ScanIssue[]
}

function issue(code: string, message: string, rowIndex?: number, field?: string): ScanIssue {
  const entry: ScanIssue = { code, message }
  if (rowIndex !== undefined) entry.rowIndex = rowIndex
  if (field !== undefined) entry.field = field
  return entry
}

/** Moves crop-relative text boxes into screenshot coordinates. */
function offset(lines: TextLine[], box: Box): TextLine[] {
  const [x0, y0] = box
  return lines.map((line) => ({
    text: line.text,
    confidence: line.confidence,
    box: [line.box[0] + x0, line.box[1] + y0, line.box[2] + x0, line.box[3] + y0] as Box,
  }))
}

function centreY(line: TextLine): number {
  return (line.box[1] + line.box[3]) / 2
}

/** Undoes an upscale: boxes are in enlarged pixels, geometry is in screenshot ones. */
function shrink(lines: TextLine[], factor: number): TextLine[] {
  if (factor === 1) return lines
  return lines.map((line) => ({
    text: line.text,
    confidence: line.confidence,
    box: [line.box[0] / factor, line.box[1] / factor, line.box[2] / factor, line.box[3] / factor] as Box,
  }))
}

/** How much to enlarge a table crop before reading it. */
function tableScale(table: Box): number {
  const height = table[3] - table[1]
  const longest = Math.max(table[2] - table[0], height)
  if (height >= TABLE_MIN_HEIGHT) return 1
  return Math.min(TABLE_UPSCALE, Math.max(1, Math.floor(TABLE_MAX_SIDE / Math.max(1, longest))))
}

/**
 * The end of a score box that faces the timer, where the score is drawn.
 *
 * The two boxes sit either side of the timer and each score is drawn against the
 * timer, so the rest of a box holds avatars, coin badges and a level bar that the
 * recogniser can mistake for a score.
 */
function scoreFacing(box: Box, width: number): Box {
  const [x0, y0, x1, y1] = box
  const span = x1 - x0
  const part = Math.min(span, Math.max(SCORE_MIN_WIDTH, Math.round(span * SCORE_FACE)))
  if ((x0 + x1) / 2 < width / 2) return [x1 - part, y0, x1, y1]
  return [x0, y0, x0 + part, y1]
}

/**
 * Scales tried for a score, largest first.
 *
 * The server read every score at 4x, but the browser's detector drops a very
 * large numeral and a very small one alike: on the five captures 4x reads two
 * boards, 2x reads a third and 1x reads a fourth. The numeral itself is already
 * big, so each scale is cheap and the first readable one wins.
 */
const SCORE_SCALES = [SCORE_UPSCALE, 2, 1] as const

async function readScoreCrop(
  color: TeamColor,
  box: Box,
  reader: TextReader,
  image: Bitmap,
  minimum: number,
  factor: number,
): Promise<{ value: number | null; confidence: number }> {
  const region = cropBitmap(image, box)
  if (region.width === 0 || region.height === 0) return { value: null, confidence: 0 }
  const scaled = factor === 1 ? region : upscaleBitmap(region, factor)
  const lines = await reader.read(scaled, `score:${color}`)
  return readScoreNumber(lines, minimum * factor)
}

/** A team's score, read where it is drawn and never from a badge. */
async function readScore(
  color: TeamColor,
  box: Box,
  reader: TextReader,
  image: Bitmap,
): Promise<{ value: number | null; confidence: number }> {
  const facing = scoreFacing(box, image.width)
  for (const factor of SCORE_SCALES) {
    const read = await readScoreCrop(color, facing, reader, image, 0, factor)
    if (read.value !== null) return read
  }
  // Second look at the whole box, still refusing anything smaller than a score.
  const minimum = (box[3] - box[1]) * SCORE_MIN_HEIGHT
  for (const factor of SCORE_SCALES) {
    const read = await readScoreCrop(color, box, reader, image, minimum, factor)
    if (read.value !== null) return read
  }
  return { value: null, confidence: 0 }
}

type ScoreRead = {
  gold: number | null
  purple: number | null
  confidence: number
  issue: [string, string] | null
}

async function readScores(
  reader: TextReader,
  image: Bitmap,
  regions: Partial<Record<TeamColor, Box>>,
): Promise<ScoreRead> {
  const scores: Record<TeamColor, number | null> = { gold: null, purple: null }
  const confidences: number[] = []
  for (const color of ['gold', 'purple'] as const) {
    const box = regions[color]
    if (!box) continue
    const { value, confidence } = await readScore(color, box, reader, image)
    scores[color] = value
    if (value !== null) confidences.push(confidence)
  }
  if (scores.gold === null || scores.purple === null)
    return {
      ...scores,
      confidence: 0,
      issue: ['score_ambiguous', 'The two team scores could not both be read — choose the winner by hand.'],
    }
  return {
    ...scores,
    confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
    issue: null,
  }
}

const rounded = (value: number) => Math.round(value * 1000) / 1000

export async function analyzeImage(image: Bitmap, reader: TextReader): Promise<ScanDocument> {
  const width = image.width
  const height = image.height
  const hsv = toHsv(image)

  // 1. Layout: rows from team colours, header and score bands above them.
  const layout = analyze(hsv)
  const { gold, purple } = masks(hsv)
  const issues: ScanIssue[] = []

  // 2. The DMG column, from its header label only. It also marks where the names
  // and damage end: EDA and PING are not needed, and every extra line the
  // recogniser has to read costs time.
  let headerLines: TextLine[] | null = null
  let column: DamageColumn | null = null
  if (layout.header) {
    headerLines = offset(await reader.read(cropBitmap(image, layout.header), 'header'), layout.header)
    column = damageColumn(headerLines, layout.rowHeight)
  }
  if (!column)
    issues.push(
      issue('header_unreadable', 'The DMG column header could not be read, so damage is left blank.', undefined, 'damage'),
    )

  // 3. One pass over the table's text. The team stripes cannot separate two
  // players of the same team, but their names and damage lines can, so the text
  // decides how many players a colour band holds.
  let table: Box = layout.table
  if (column && column.right !== null) table = [table[0], table[1], Math.max(table[0] + 40, Math.round(column.right)), table[3]]
  const tableFactor = tableScale(table)
  const tableCrop = cropBitmap(image, table)
  const tableRead = tableFactor === 1 ? tableCrop : upscaleBitmap(tableCrop, tableFactor)
  const tableLines = offset(shrink(await reader.read(tableRead, 'table'), tableFactor), table)
  const tableRows: Row[] = tableLines.length ? refineRows(layout.rows, tableLines) : layout.rows
  const heights = tableRows.map((row) => row.y1 - row.y0).sort((a, b) => a - b)
  const rowHeight = Math.max(1, Math.round(heights[Math.floor(heights.length / 2)] ?? 1))

  // The DMG window has to be one player row tall, and `layout.rowHeight` is not
  // that: it is the median colour band, and a band holds every player of one team
  // — this board's gold band is two rows and 196 px. A window derived from it
  // reached into EDA, where a kill count can be recognised more confidently than
  // the damage beside it: 16 was logged instead of 2,107. Only the window changes
  // here; the column position and where the crop ends are the same either way.
  if (column && headerLines) column = damageColumn(headerLines, rowHeight) ?? column

  // 4. Per row: username, damage and the team its stripe belongs to.
  const rows: ScanDocument['rows'] = []
  let rereads = 0
  for (const row of tableRows) {
    let lines: TextLine[]
    if (tableLines.length) lines = tableLines.filter((line) => row.y0 <= centreY(line) && centreY(line) < row.y1)
    else {
      // Nothing was recognised in the table crop; try each row on its own.
      const box: Box = [row.x0, row.y0, row.x1, row.y1]
      lines = offset(await reader.read(cropBitmap(image, box), `row:${row.index}`), box)
    }
    let text = parseRow(lines, column, rowHeight)

    // A row whose @handle was missed keeps only its display name, and the roster
    // is indexed by the handle, so it gets one enlarged second look. A handle that
    // stops on a separator is treated the same way, because that read is short:
    // both are a handle the first pass did not get. The pass is accepted only when
    // it reads a handle the first one lacked — missing, or strictly longer. A name
    // the engine simply spells differently is left alone, because nothing here can
    // tell a better spelling from a worse one.
    const missed = !hasHandle(lines)
    const truncated = text.username !== null && !HANDLE_END.test(text.username)
    if ((missed || truncated) && rereads < MAX_ROW_REREADS) {
      rereads += 1
      const box: Box = [row.x0, row.y0, row.x1, row.y1]
      const crop = cropBitmap(image, box)
      const enlarged = crop.width ? upscaleBitmap(crop, ROW_UPSCALE) : crop
      if (enlarged !== crop) {
        const second = shrink(await reader.read(enlarged, `row:${row.index} x${ROW_UPSCALE}`), ROW_UPSCALE)
        const better = parseRow(offset(second, box), column, rowHeight)
        const candidate = better.username
        if (
          candidate !== null &&
          hasHandle(second) &&
          (missed || candidate.length > (text.username?.length ?? 0))
        )
          text = better
      }
    }
    const rowIssues: ScanIssue[] = []
    if (text.empty)
      rowIssues.push(issue('row_obscured', 'This row could not be read at all — check it or remove it.', row.index))
    if (row.color === null)
      rowIssues.push(issue('team_ambiguous', 'The team colour of this row is unclear — choose the team.', row.index, 'team'))
    if (text.username === null)
      rowIssues.push(issue('username_unreadable', 'No username was read — type it or remove the row.', row.index, 'username'))
    else if (text.usernameConfidence < 0.7)
      rowIssues.push(issue('low_confidence', 'Low confidence username — check the spelling.', row.index, 'username'))
    if (text.damage === null)
      rowIssues.push(issue('damage_unreadable', 'Damage could not be read — enter it by hand.', row.index, 'damage'))
    issues.push(...rowIssues)
    rows.push({
      index: row.index,
      teamSlot: row.color === 'gold' ? 0 : row.color === 'purple' ? 1 : null,
      color: row.color,
      username: text.username,
      usernameConfidence: rounded(text.usernameConfidence),
      damage: text.damage,
      damageConfidence: rounded(text.damageConfidence),
      rawDamageText: text.rawDamage,
      issues: rowIssues,
    })
  }

  // 5. Team scores and the winner. A tie or a missing score is never guessed.
  const regions = scoreRegions(gold, purple, layout.score, width)
  const scores = Object.keys(regions).length
    ? await readScores(reader, image, regions)
    : {
        gold: null,
        purple: null,
        confidence: 0,
        issue: ['score_ambiguous', 'The team scores are not visible — choose the winner by hand.'] as [string, string],
      }
  if (scores.issue) issues.push(issue(scores.issue[0], scores.issue[1], undefined, 'score'))

  let winner: number | null = null
  if (scores.gold !== null && scores.purple !== null) {
    if (scores.gold === scores.purple)
      issues.push(issue('score_ambiguous', 'The scores are tied — confirm the winning team.', undefined, 'score'))
    else winner = scores.gold > scores.purple ? 0 : 1
  }

  return {
    version: SCAN_VERSION,
    image: { width, height },
    teams: [
      { slot: 0, color: 'gold', score: scores.gold, confidence: rounded(scores.confidence) },
      { slot: 1, color: 'purple', score: scores.purple, confidence: rounded(scores.confidence) },
    ],
    winnerSlot: winner,
    rows,
    issues,
  }
}
