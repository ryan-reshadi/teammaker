export type Player = {
  id: string
  name: string
  /** 1 - 10, derived from elo. Kept for readers that predate the elo scale. */
  skill: number
  /** 100 - 1000. 100 points is one point on the 1-10 scale. */
  elo: number
  /** Any number of ids from the role catalogue (see shared/roles.ts). */
  tags: string[]
  sittingOut: boolean
  createdAt: number
  updatedAt: number
}

export type RoundPlayer = {
  id: string
  name: string
  elo: number
  tags?: string[]
}

export type RoundTeam = { players: RoundPlayer[]; sum: number }

/** A snapshot of a saved round: the teams as they were, plus who sat out. */
export type RoundConfig = {
  version: 2
  teamCount: number
  tolerance: number
  spread: number
  teams: RoundTeam[]
  benchedIds: string[]
}

export type Round = {
  id: string
  createdAt: number
  config: RoundConfig
}

export type Session = {
  user: { sub: string; name?: string; email?: string } | null
  mode: 'local' | 'freebuff' | 'setup'
  database: boolean
}
