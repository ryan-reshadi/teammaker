import { MAX_DAMAGE, MAX_MATCH_PLAYERS, type MatchInput } from './elo'
import type { Player } from './types'

/**
 * The screenshot-import seam. The browser's OCR pipeline produces the extraction
 * below and the review UI turns it into an ordinary `MatchInput`. Nothing here
 * knows about elo: the existing `POST /api/matches` route stays the only way a
 * match is recorded.
 */

export const RIVALS_MAX_BYTES = 8 * 1024 * 1024
/** Two teams of at most ten, so a scoreboard larger than this is not a duel. */
export const RIVALS_MAX_ROWS = 20
export const RIVALS_MAX_USERNAME = 64
export const RIVALS_DEFAULT_LABEL = 'RIVALS Screenshot Import'
/** Fuzzy candidates are suggestions only; they are never applied automatically. */
export const RIVALS_FUZZY_THRESHOLD = 0.82
export const RIVALS_ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

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

/**
 * A handle folded onto the glyphs a small scoreboard cannot separate.
 *
 * At 11 to 14 px the on-device recogniser cannot tell `O` from `0` or `I`, `l`
 * and `1` apart, and it makes the same choice at every scale — a bias of the
 * model, not something a better crop can fix. The roster holds the true
 * spelling, so a folded key that names exactly one roster player settles it.
 */
export function foldConfusables(value: string): string {
  return normalizeUsername(value).replace(/o/g, '0').replace(/[il]/g, '1')
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
  const byFolded = new Map<string, Player[]>()
  for (const player of players) {
    const key = normalizeUsername(player.username ?? '')
    if (!key) continue
    const bucket = byUsername.get(key)
    if (bucket) bucket.push(player)
    else byUsername.set(key, [player])
    const folded = foldConfusables(key)
    const lookalikes = byFolded.get(folded)
    if (lookalikes) lookalikes.push(player)
    else byFolded.set(folded, [player])
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

    // A name that differs from exactly one roster handle only by look-alike
    // glyphs is that player: the screenshot cannot have meant anything else.
    const lookalikes = byFolded.get(foldConfusables(key)) ?? []
    if (lookalikes.length === 1)
      return {
        status: 'matched',
        playerId: lookalikes[0]!.id,
        candidates: [candidateOf(lookalikes[0]!, 1)],
        note: `Matched a look-alike spelling — your roster has ${lookalikes[0]!.username ?? lookalikes[0]!.name}.`,
      }
    if (lookalikes.length > 1)
      return {
        status: 'review',
        playerId: null,
        candidates: lookalikes.map((player) => candidateOf(player, 1)),
        note: 'Roster players differ only by look-alike characters — choose one.',
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
