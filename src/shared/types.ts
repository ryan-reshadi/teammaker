export type Player = {
  id: string
  name: string
  /** 1 - 10, whole numbers only. */
  skill: number
  /** Any number of ids from the role catalogue (see shared/roles.ts). */
  tags: string[]
  sittingOut: boolean
  createdAt: number
  updatedAt: number
}

export type RoundPlayer = {
  id: string
  name: string
  skill: number
  tags?: string[]
}

export type RoundTeam = { players: RoundPlayer[]; sum: number }

/** A snapshot of a saved round: the teams as they were, plus who sat out. */
export type RoundConfig = {
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
