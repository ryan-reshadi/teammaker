import {
  buildRivalsMatchInput,
  matchRoster,
  RIVALS_DEFAULT_LABEL,
  RIVALS_MAX_ROWS,
  RIVALS_MAX_USERNAME,
  type RosterMatch,
  type RosterMatchStatus,
  type RivalsDraft,
  type RivalsDraftResult,
  type RivalsScan,
  type RivalsTeamColor,
} from '../shared/rivals'
import type { Player } from '../shared/types'

/**
 * Review-draft state for the screenshot importer. Pure and React-free: the
 * component owns the state, this module owns every transition, so the rules are
 * testable without a DOM.
 */

export type ImportChoice =
  | { kind: 'roster'; playerId: string; auto: boolean }
  | { kind: 'random' }
  | null

export type ImportRow = {
  key: string
  username: string
  damage: string
  teamSlot: number
  choice: ImportChoice
  usernameConfidence: number
  damageConfidence: number
  issues: string[]
}

export type ImportDraft = {
  label: string
  winner: number | null
  colors: [RivalsTeamColor, RivalsTeamColor]
  scores: [number | null, number | null]
  rows: ImportRow[]
}

const issueText = (message: string): string => message

/** Rows keep their order from the screenshot: index 0 is the topmost row. */
export function draftFromScan(scan: RivalsScan, players: Player[]): ImportDraft {
  const matches = matchRoster(
    scan.rows.map((row) => row.username),
    players,
  )
  const bySlot = new Map(scan.teams.map((team) => [team.slot, team]))
  const colors: [RivalsTeamColor, RivalsTeamColor] = [
    bySlot.get(0)?.color ?? 'gold',
    bySlot.get(1)?.color ?? 'purple',
  ]
  const scores: [number | null, number | null] = [
    bySlot.get(0)?.score ?? null,
    bySlot.get(1)?.score ?? null,
  ]
  const winner =
    scan.winnerSlot === 0 || scan.winnerSlot === 1 ? scan.winnerSlot : null

  return {
    label: RIVALS_DEFAULT_LABEL,
    winner,
    colors,
    scores,
    rows: scan.rows.slice(0, RIVALS_MAX_ROWS).map((row, index) => {
      const match = matches[index]
      const teamSlot = row.teamSlot === 1 ? 1 : 0
      const issues = row.issues.map((issue) => issueText(issue.message))
      if (row.teamSlot === null)
        issues.push('Team colour unclear — check which team this row belongs to.')
      return {
        key: crypto.randomUUID(),
        username: (row.username ?? '').slice(0, RIVALS_MAX_USERNAME),
        damage: row.damage === null ? '' : String(row.damage),
        teamSlot,
        choice:
          match?.status === 'matched' && match.playerId
            ? { kind: 'roster', playerId: match.playerId, auto: true }
            : null,
        usernameConfidence: row.usernameConfidence,
        damageConfidence: row.damageConfidence,
        issues,
      }
    }),
  }
}

/** The current auto/manual/suggested state of every row. */
export function draftStatuses(
  draft: ImportDraft,
  players: Player[],
): Record<string, RosterMatchStatus> {
  const matches = matchRoster(
    draft.rows.map((row) => row.username),
    players,
  )
  const assigned = new Map<string, number>()
  for (const row of draft.rows) {
    if (row.choice?.kind !== 'roster') continue
    assigned.set(row.choice.playerId, (assigned.get(row.choice.playerId) ?? 0) + 1)
  }
  const statuses: Record<string, RosterMatchStatus> = {}
  draft.rows.forEach((row, index) => {
    const match: RosterMatch | undefined = matches[index]
    const choice = row.choice
    if (choice?.kind === 'random') {
      statuses[row.key] = 'unmatched'
      return
    }
    if (choice?.kind === 'roster') {
      if ((assigned.get(choice.playerId) ?? 0) > 1) {
        statuses[row.key] = 'review'
        return
      }
      const exact =
        match?.status === 'matched' && match.playerId === choice.playerId
      statuses[row.key] = exact ? 'matched' : 'manual'
      return
    }
    statuses[row.key] = match?.status ?? 'unmatched'
  })
  return statuses
}

export function rowCandidates(row: ImportRow, players: Player[]): RosterMatch {
  return (
    matchRoster([row.username], players)[0] ?? {
      status: 'unmatched',
      playerId: null,
      candidates: [],
      note: '',
    }
  )
}

const edit = (
  draft: ImportDraft,
  change: (row: ImportRow) => ImportRow | null,
): ImportDraft => ({
  ...draft,
  rows: draft.rows.flatMap((row) => {
    const next = change(row)
    return next ? [next] : []
  }),
})

export const setLabel = (draft: ImportDraft, label: string): ImportDraft => ({
  ...draft,
  label: label.slice(0, 60),
})

export const setWinner = (draft: ImportDraft, winner: number | null): ImportDraft => ({
  ...draft,
  winner,
})

export const setUsername = (
  draft: ImportDraft,
  key: string,
  username: string,
): ImportDraft =>
  edit(draft, (row) => {
    if (row.key !== key) return row
    // An automatic assignment stops applying once the handle it came from
    // changes; a hand-picked player stays picked.
    const choice =
      row.choice?.kind === 'roster' && row.choice.auto ? null : row.choice
    return { ...row, username: username.slice(0, RIVALS_MAX_USERNAME), choice }
  })

export const setDamage = (
  draft: ImportDraft,
  key: string,
  damage: string,
): ImportDraft =>
  edit(draft, (row) =>
    row.key === key ? { ...row, damage: damage.replace(/[^\d]/g, '') } : row,
  )

export const choosePlayer = (
  draft: ImportDraft,
  key: string,
  playerId: string,
): ImportDraft =>
  edit(draft, (row) =>
    row.key === key
      ? {
          ...row,
          choice: playerId
            ? { kind: 'roster', playerId, auto: false }
            : null,
        }
      : row,
  )

export const markRandom = (draft: ImportDraft, key: string): ImportDraft =>
  edit(draft, (row) =>
    row.key === key
      ? {
          ...row,
          choice: row.choice?.kind === 'random' ? null : { kind: 'random' },
        }
      : row,
  )

export const moveRow = (
  draft: ImportDraft,
  key: string,
  teamSlot: number,
): ImportDraft =>
  edit(draft, (row) =>
    row.key === key ? { ...row, teamSlot: teamSlot === 1 ? 1 : 0 } : row,
  )

export const removeRow = (draft: ImportDraft, key: string): ImportDraft =>
  edit(draft, (row) => (row.key === key ? null : row))

export const swapTeams = (draft: ImportDraft): ImportDraft => ({
  ...draft,
  colors: [draft.colors[1], draft.colors[0]],
  scores: [draft.scores[1], draft.scores[0]],
  winner:
    draft.winner === 0 ? 1 : draft.winner === 1 ? 0 : draft.winner,
  rows: draft.rows.map((row) => ({ ...row, teamSlot: row.teamSlot === 1 ? 0 : 1 })),
})

/** Display names from the roster travel into the event for tracked players. */
export function buildImportInput(
  draft: ImportDraft,
  players: Player[],
): RivalsDraftResult {
  const roster = new Map(players.map((player) => [player.id, player]))
  const mapped: RivalsDraft = {
    label: draft.label,
    winner: draft.winner,
    players: draft.rows.map((row) => {
      const choice = row.choice
      const player =
        choice?.kind === 'roster' ? roster.get(choice.playerId) : undefined
      const tracked = Boolean(player)
      return {
        key: row.key,
        username: row.username,
        playerName: player?.name ?? null,
        playerId: tracked ? player!.id : null,
        teamSlot: row.teamSlot,
        damage: row.damage,
        tracked,
      }
    }),
  }
  return buildRivalsMatchInput(mapped)
}

/**
 * Identifies a reviewed draft, so a repeat click cannot send the same match
 * twice even after a failed response left the outcome unknown.
 */
export function draftFingerprint(draft: ImportDraft): string {
  return JSON.stringify({
    label: draft.label.trim(),
    winner: draft.winner,
    teams: [0, 1].map((slot) =>
      draft.rows
        .filter((row) => row.teamSlot === slot)
        .map((row) => [
          row.choice?.kind === 'roster'
            ? row.choice.playerId
            : row.choice?.kind === 'random'
              ? 'random'
              : 'none',
          row.username.trim().toLowerCase(),
          row.damage.trim(),
        ]),
    ),
  })
}
