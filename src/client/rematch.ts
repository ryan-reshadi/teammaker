import type { MatchEventView } from '../shared/elo'
import type { Player } from '../shared/types'

export type RematchPlayer = {
  key: string
  id: string
  name: string
  tracked: boolean
  damage: string
}

export type RematchTeam = RematchPlayer[]

export type RematchDraft = {
  label: string
  teams: RematchTeam[]
  winner: number
}

/**
 * The same line-ups for the next game, with fresh damage and client keys. A
 * tracked player who has left the roster makes the rematch unavailable rather
 * than silently producing a different match.
 */
export function rematchDraft(
  event: MatchEventView,
  roster: Player[],
): { draft: RematchDraft } | { error: string } {
  const byId = new Map(roster.map((player) => [player.id, player]))
  const missing: string[] = []
  const teams = event.teams.map((team) =>
    team.players.map((player) => {
      if (player.tracked && player.id) {
        const current = byId.get(player.id)
        if (!current) missing.push(player.name)
        return {
          key: crypto.randomUUID(),
          id: player.id,
          name: current?.name ?? player.name,
          tracked: true,
          damage: '',
        } satisfies RematchPlayer
      }
      const key = crypto.randomUUID()
      return {
        key,
        id: key,
        name: player.name,
        tracked: false,
        damage: '',
      } satisfies RematchPlayer
    }),
  )
  if (missing.length > 0)
    return {
      error: `Cannot rematch: ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } no longer on the roster.`,
    }
  return {
    draft: {
      label: event.label ? `${event.label} (rematch)`.slice(0, 60) : 'Rematch',
      teams,
      winner: 0,
    },
  }
}