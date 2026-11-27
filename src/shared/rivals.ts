import { MAX_DAMAGE, MAX_MATCH_PLAYERS, type MatchInput } from './elo'
import type { Player } from './types'

/**
 * The screenshot-import seam. The Python OCR service produces the extraction
 * below, the Worker validates it before it reaches the browser, and the review
 * UI turns it into an ordinary `MatchInput`. Nothing here knows about elo: the
 * existing `POST /api/matches` route stays the only way a match is recorded.
 */

export const RIVALS_SCAN_VERSION = 1
export const RIVALS_MAX_BYTES = 8 * 1024 * 1024
export const RIVALS_MAX_DIMENSION = 4096
export const RIVALS_MIN_DIMENSION = 320
/** Two teams of at most ten, so a scoreboard larger than this is not a duel. */
export const RIVALS_MAX_ROWS = 20
export const RIVALS_MAX_USERNAME = 64
export const RIVALS_DEFAULT_LABEL = 'RIVALS Screenshot Import'
/** Fuzzy candidates are suggestions only; they are never applied automatically. */
export const RIVALS_FUZZY_THRESHOLD = 0.82
export const RIVALS_ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

/**
 * Why screenshot import is or is not available. `ready` is the only state an
 * upload can succeed in; every other state names the thing to fix, so the UI
 * never has to guess between "not configured" and "configured but down".
 */
export const RIVALS_CONFIG_STATUSES = [
  'ready',
  'unconfigured',
  'invalid_url',
  'unreachable',
  'timeout',
  'error',
] as const

export type RivalsConfigStatus = (typeof RIVALS_CONFIG_STATUSES)[number]
export type RivalsEnvVar = 'OCR_SERVICE_URL' | 'OCR_SERVICE_TOKEN'

/**
 * `GET /api/rivals/config`. The first three fields are the original contract, so
 * an older client still renders; `status`, `missing` and `message` are additive
 * detail for the import panel.
 */
export type RivalsConfig = {
  /** True only when both variables are set and the service answered a probe. */
  configured: boolean
  maxBytes: number
  acceptedTypes: readonly string[]
  status?: RivalsConfigStatus
  /** Which variables are absent; empty when both are set. */
  missing?: RivalsEnvVar[]
  /** Shown verbatim by the import UI. Never contains the token. */
  message?: string
  /** The engine's own name, from the service's health response. */
  engine?: string
}

export type RivalsImageType = (typeof RIVALS_ACCEPTED_TYPES)[number]
export type RivalsTeamColor = 'gold' | 'purple'

export const RIVALS_ISSUE_CODES = [
  'row_obscured',
  'damage_unreadable',
  'username_unreadable',
  'team_ambiguous',
  'header_unreadable',
  'score_ambiguous',
  'low_confidence',
] as const

export type RivalsIssueCode = (typeof RIVALS_ISSUE_CODES)[number]
export type RivalsIssueField = 'username' | 'damage' | 'team' | 'score'

export type RivalsIssue = {
  code: RivalsIssueCode
  message: string
  rowIndex?: number
  field?: RivalsIssueField
}

export type RivalsTeam = {
  slot: number
  color: RivalsTeamColor
  /** Null when the score could not be read confidently — never guessed. */
  score: number | null
  confidence: number
}

export type RivalsRow = {
  index: number
  /** 0 for gold, 1 for purple; null when the row colour was ambiguous. */
  teamSlot: number | null
  color: RivalsTeamColor | null
  username: string | null
  usernameConfidence: number
  /** Null when unreadable. Zero is only ever a genuine, recognised zero. */
  damage: number | null
  damageConfidence: number
  rawDamageText?: string | null
  issues: RivalsIssue[]
}

export type RivalsScan = {
  version: number
  image: { width: number; height: number }
  teams: RivalsTeam[]
  /** Null when the scores tie or one of them is unreadable: confirm by hand. */
  winnerSlot: number | null
  rows: RivalsRow[]
  issues: RivalsIssue[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

const isConfidence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

const isSlot = (value: unknown): value is 0 | 1 => value === 0 || value === 1

const isColor = (value: unknown): value is RivalsTeamColor =>
  value === 'gold' || value === 'purple'

/** Magic-byte check, so a renamed HTML file never reaches the OCR service. */
export function sniffImageType(bytes: Uint8Array): RivalsImageType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp'
  return null
}

function readIssue(value: unknown): RivalsIssue | null {
  if (!isRecord(value)) return null
  const code = value.code
  if (
    typeof code !== 'string' ||
    !RIVALS_ISSUE_CODES.includes(code as RivalsIssueCode)
  )
    return null
  const message = value.message
  if (typeof message !== 'string' || message.length === 0 || message.length > 240)
    return null
  const issue: RivalsIssue = { code: code as RivalsIssueCode, message }
  if (
    value.field === 'username' ||
    value.field === 'damage' ||
    value.field === 'team' ||
    value.field === 'score'
  )
    issue.field = value.field
  if (isIndex(value.rowIndex)) issue.rowIndex = value.rowIndex
  return issue
}

function readIssues(value: unknown): RivalsIssue[] | null {
  if (!Array.isArray(value)) return null
  const issues: RivalsIssue[] = []
  for (const item of value) {
    const issue = readIssue(item)
    if (!issue) return null
    issues.push(issue)
  }
  return issues
}

function readTeam(value: unknown): RivalsTeam | null {
  if (!isRecord(value)) return null
  if (!isSlot(value.slot) || !isColor(value.color)) return null
  if (value.score !== null && !isIndex(value.score)) return null
  if (value.score !== null && (value.score as number) > 999) return null
  if (!isConfidence(value.confidence)) return null
  return {
    slot: value.slot,
    color: value.color,
    score: value.score as number | null,
    confidence: value.confidence,
  }
}

function readRow(value: unknown): RivalsRow | null {
  if (!isRecord(value)) return null
  if (!isIndex(value.index)) return null
  if (value.teamSlot !== null && !isSlot(value.teamSlot)) return null
  if (value.color !== null && !isColor(value.color)) return null
  if (value.username !== null) {
    if (typeof value.username !== 'string') return null
    if (value.username.length > RIVALS_MAX_USERNAME) return null
  }
  if (!isConfidence(value.usernameConfidence)) return null
  if (value.damage !== null) {
    if (typeof value.damage !== 'number' || !Number.isInteger(value.damage)) return null
    if (value.damage < 0 || value.damage > MAX_DAMAGE) return null
  }
  if (!isConfidence(value.damageConfidence)) return null
  if (
    value.rawDamageText !== undefined &&
    value.rawDamageText !== null &&
    typeof value.rawDamageText !== 'string'
  )
    return null
  const issues = readIssues(value.issues)
  if (!issues) return null
  return {
    index: value.index,
    teamSlot: value.teamSlot as number | null,
    color: value.color as RivalsTeamColor | null,
    username: value.username as string | null,
    usernameConfidence: value.usernameConfidence,
    damage: value.damage as number | null,
    damageConfidence: value.damageConfidence,
    rawDamageText: (value.rawDamageText as string | null | undefined) ?? null,
    issues,
  }
}

/**
 * Validates the OCR service's response before the Worker hands it to the
 * browser. A shape this strict means a broken or hostile upstream cannot smuggle
 * anything into the review UI.
 */
export function readRivalsScan(value: unknown): RivalsScan | null {
  if (!isRecord(value)) return null
  if (value.ok === false) return null
  if (value.version !== RIVALS_SCAN_VERSION) return null
  if (!isRecord(value.image)) return null
  const width = value.image.width
  const height = value.image.height
  if (!isIndex(width) || !isIndex(height)) return null
  if (width === 0 || height === 0) return null
  if (!Array.isArray(value.teams) || value.teams.length !== 2) return null
  const teams: RivalsTeam[] = []
  for (const item of value.teams) {
    const team = readTeam(item)
    if (!team) return null
    teams.push(team)
  }
  if (teams[0]!.slot === teams[1]!.slot) return null
  if (teams[0]!.color === teams[1]!.color) return null
  if (value.winnerSlot !== null && !isSlot(value.winnerSlot)) return null
  if (!Array.isArray(value.rows) || value.rows.length === 0) return null
  if (value.rows.length > RIVALS_MAX_ROWS) return null
  const rows: RivalsRow[] = []
  for (const item of value.rows) {
    const row = readRow(item)
    if (!row) return null
    rows.push(row)
  }
  const issues = readIssues(value.issues)
  if (!issues) return null
  return {
    version: RIVALS_SCAN_VERSION,
    image: { width, height },
    teams,
    winnerSlot: value.winnerSlot as number | null,
    rows,
    issues,
  }
}

export type RosterMatchStatus =
  | 'matched'
  | 'suggested'
  | 'unmatched'
  | 'manual'
  | 'review'

export type RivalsCandidate = {
  id: string
  name: string
  username: string
  elo: number
  score: number
}

export type RosterMatch = {
  status: RosterMatchStatus
  playerId: string | null
  candidates: RivalsCandidate[]
  note: string
}

/** Roblox handles are case-insensitive and have no internal whitespace. */
export function normalizeUsername(value: string): string {
  return value.trim().replace(/\s+/g, '').toLowerCase()
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_value, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution)
    }
    previous = current
  }
  return previous[b.length]!
}

/** 1 for identical handles, 0 for nothing in common. Small strings only. */
export function usernameSimilarity(a: string, b: string): number {
  const left = normalizeUsername(a)
  const right = normalizeUsername(b)
  if (!left || !right) return 0
  if (left === right) return 1
  return 1 - levenshtein(left, right) / Math.max(left.length, right.length)
}

const candidateOf = (player: Player, score: number): RivalsCandidate => ({
  id: player.id,
  name: player.name,
  username: player.username ?? '',
  elo: player.elo,
  score,
})

/**
 * Matches extracted usernames against the roster. Exact, case-insensitive
 * username matches are the only automatic assignment; everything else is a
 * suggestion or a "needs review" that the user must settle by hand.
 */
export function matchRoster(
  usernames: (string | null)[],
  players: Player[],
): RosterMatch[] {
  const byUsername = new Map<string, Player[]>()
  for (const player of players) {
    const key = normalizeUsername(player.username ?? '')
    if (!key) continue
    const bucket = byUsername.get(key)
    if (bucket) bucket.push(player)
    else byUsername.set(key, [player])
  }

  const matches = usernames.map((username): RosterMatch => {
    const key = normalizeUsername(username ?? '')
    if (!key)
      return {
        status: 'unmatched',
        playerId: null,
        candidates: [],
        note: 'No username was read from this row.',
      }
    const exact = byUsername.get(key) ?? []
    if (exact.length === 1)
      return {
        status: 'matched',
        playerId: exact[0]!.id,
        candidates: [candidateOf(exact[0]!, 1)],
        note: 'Exact username match.',
      }
    if (exact.length > 1)
      return {
        status: 'review',
        playerId: null,
        candidates: exact.map((player) => candidateOf(player, 1)),
        note: 'Two roster players share this username — choose one.',
      }
    const fuzzy = players
      .map((player) => ({
        player,
        score: usernameSimilarity(key, player.username ?? ''),
      }))
      .filter((entry) => entry.score >= RIVALS_FUZZY_THRESHOLD)
      .sort((a, b) => b.score - a.score || a.player.name.localeCompare(b.player.name))
      .slice(0, 3)
    if (fuzzy.length > 0)
      return {
        status: 'suggested',
        playerId: null,
        candidates: fuzzy.map((entry) => candidateOf(entry.player, entry.score)),
        note: 'Suggested from a similar username — confirm to use it.',
      }
    return {
      status: 'unmatched',
      playerId: null,
      candidates: [],
      note: 'No roster player matches — keep as an untracked random or pick one.',
    }
  })

  // The same roster player twice is never a valid match: both rows need review.
  const counts = new Map<string, number>()
  for (const match of matches)
    if (match.playerId) counts.set(match.playerId, (counts.get(match.playerId) ?? 0) + 1)
  for (const match of matches) {
    if (!match.playerId) continue
    if ((counts.get(match.playerId) ?? 0) < 2) continue
    match.status = 'review'
    match.note = 'This player appears more than once — assign one of these rows.'
  }
  return matches
}

export type RivalsDraftPlayer = {
  /** Stable client key; also the id of an untracked random. */
  key: string
  username: string
  playerId: string | null
  /** The roster player's display name, used for tracked entries. */
  playerName?: string | null
  teamSlot: number
  damage: string
  tracked: boolean
}

export type RivalsDraft = {
  label: string
  winner: number | null
  players: RivalsDraftPlayer[]
}

export type RivalsDraftResult =
  | { ok: true; input: MatchInput }
  | { ok: false; errors: string[] }

const readDraftName = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length >= 1 && name.length <= 40 ? name : null
}

/**
 * Turns a reviewed draft into the exact `MatchInput` the existing route
 * accepts — no confidence, image or OCR values travel with it. Team index 0 is
 * the gold team and 1 the purple one unless the review swapped them.
 */
export function buildRivalsMatchInput(draft: RivalsDraft): RivalsDraftResult {
  const errors: string[] = []
  const teams: MatchInput['teams'] = [
    { players: [] },
    { players: [] },
  ]
  const seen = new Set<string>()
  const trackedIds = new Set<string>()
  let tracked = 0
  let totalDamage = 0
  let randomIndex = 0

  for (const player of draft.players) {
    if (player.teamSlot !== 0 && player.teamSlot !== 1) {
      errors.push(`“${player.username || 'That player'}” has no team.`)
      continue
    }
    if (player.tracked && !player.playerId) {
      errors.push(`“${player.username || 'That player'}” needs a roster player.`)
      continue
    }
    const name = player.tracked
      ? readDraftName(player.playerName) ?? readDraftName(player.username)
      : readDraftName(player.username) ?? readDraftName(`Random ${++randomIndex}`)
    if (!name) {
      errors.push('Every player needs a name of 1 to 40 characters.')
      continue
    }
    const damageText = player.damage.trim()
    if (!/^\d+$/.test(damageText)) {
      errors.push(`Enter whole-number damage for ${name}.`)
      continue
    }
    const damage = Number(damageText)
    if (!Number.isSafeInteger(damage) || damage < 0 || damage > MAX_DAMAGE) {
      errors.push(`Damage for ${name} is 0 to ${MAX_DAMAGE.toLocaleString()}.`)
      continue
    }
    const id = player.tracked ? player.playerId! : player.key
    if (id.length < 1 || id.length > 64) {
      errors.push('A player id is not valid.')
      continue
    }
    if (seen.has(id)) {
      errors.push(`${name} appears twice in this match.`)
      continue
    }
    seen.add(id)
    if (player.tracked) {
      trackedIds.add(id)
      tracked++
    }
    totalDamage += damage
    const team = teams[player.teamSlot]!
    if (team.players.length >= MAX_MATCH_PLAYERS) {
      errors.push(`A team holds up to ${MAX_MATCH_PLAYERS} players.`)
      continue
    }
    team.players.push({
      id,
      name,
      damage,
      tracked: player.tracked,
    })
  }

  if (teams.some((team) => team.players.length === 0))
    errors.push('Each team needs at least one player.')
  if (tracked === 0) errors.push('Match at least one player from your roster.')
  if (totalDamage === 0) errors.push('A match needs some damage on the board.')
  if (draft.winner !== 0 && draft.winner !== 1)
    errors.push('Choose the winning team.')
  if (draft.label.trim().length > 60) errors.push('The label is up to 60 characters.')
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] }

  return {
    ok: true,
    input: {
      label: draft.label.trim() || RIVALS_DEFAULT_LABEL,
      teams,
      winner: draft.winner as number,
    },
  }
}
