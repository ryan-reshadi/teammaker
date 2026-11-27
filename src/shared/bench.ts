import type { RatingEventView } from './elo'
import type { Player, Round } from './types'

export type BenchCounts = {
  counts: Record<string, number>
  /** Matches are the real sessions; rounds are only a fallback before any. */
  source: 'matches' | 'rounds' | 'none'
  matchCount: number
}

/**
 * A roster player sat out a match when they already existed and were not on any
 * team. Adjustments are not sessions and never count. Removed players are
 * archived, so they stop appearing here while their history stays in the log.
 */
export function matchSitOutCounts(
  events: RatingEventView[],
  players: Player[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const event of events) {
    if (event.kind !== 'match') continue
    const played = new Set<string>()
    for (const team of event.teams)
      for (const player of team.players)
        if (player.tracked && player.id) played.add(player.id)
    for (const player of players) {
      if (player.createdAt > event.createdAt) continue
      if (!played.has(player.id)) counts[player.id] = (counts[player.id] ?? 0) + 1
    }
  }
  return counts
}

export function savedRoundSitOutCounts(rounds: Round[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const round of rounds)
    for (const id of round.config.benchedIds)
      counts[id] = (counts[id] ?? 0) + 1
  return counts
}

export function sitOutCounts(
  events: RatingEventView[],
  rounds: Round[],
  players: Player[],
): BenchCounts {
  const matchCount = events.filter((event) => event.kind === 'match').length
  if (matchCount > 0)
    return { counts: matchSitOutCounts(events, players), source: 'matches', matchCount }
  if (rounds.length > 0)
    return {
      counts: savedRoundSitOutCounts(rounds),
      source: 'rounds',
      matchCount: 0,
    }
  return { counts: {}, source: 'none', matchCount: 0 }
}