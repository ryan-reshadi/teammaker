import type { RatingEventView } from './elo'

export type PlayerHistoryEntry = {
  id: string
  position: number
  createdAt: number
  kind: 'match' | 'adjust'
  label: string
  delta: number
  eloBefore: number
  eloAfter: number
  /** True for a match the player's team won; absent on manual adjustments. */
  won?: boolean
}

/** The player's slice of the ordered log, oldest first. Derived, never stored. */
export function playerHistory(
  events: RatingEventView[],
  playerId: string,
): PlayerHistoryEntry[] {
  const entries: PlayerHistoryEntry[] = []
  for (const event of events) {
    if (event.kind === 'adjust') {
      if (event.playerId !== playerId) continue
      entries.push({
        id: event.id,
        position: event.position,
        createdAt: event.createdAt,
        kind: 'adjust',
        label: event.reason || 'Manual rating',
        delta: event.delta,
        eloBefore: event.eloBefore,
        eloAfter: event.eloAfter,
      })
      continue
    }
    event.teams.forEach((team, teamIndex) => {
      for (const player of team.players) {
        if (!player.tracked || player.id !== playerId) continue
        entries.push({
          id: event.id,
          position: event.position,
          createdAt: event.createdAt,
          kind: 'match',
          label: event.label || 'Match',
          delta: player.delta,
          eloBefore: player.eloBefore,
          eloAfter: player.eloAfter,
          won: teamIndex === event.winner,
        })
      }
    })
  }
  return entries.sort(
    (a, b) =>
      a.position - b.position ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id),
  )
}

/** Polyline coordinates for a compact SVG sparkline. */
export function sparklinePoints(
  values: number[],
  width: number,
  height: number,
): string {
  if (values.length === 0) return ''
  if (values.length === 1) return `${width / 2},${height / 2}`
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width
      const y = span === 0 ? height / 2 : height - ((value - min) / span) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}