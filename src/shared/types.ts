export type Player = {
  id: string
  name: string
  /** Optional handle, empty when the player has none. */
  username?: string
  /** 1 - 10, derived from elo. Kept for readers that predate the elo scale. */
  skill: number
  /** 100 - 1000. 100 points is one point on the 1-10 scale. */
  elo: number
  /** Any number of ids from the group's tag list (see shared/types GroupTag). */
  tags: string[]
  /**
   * Local only. The API never sends it and never accepts it: who is sitting
   * out is a per-device decision stored in localStorage.
   */
  sittingOut?: boolean
  createdAt: number
  updatedAt: number
}

export type GroupRole = 'owner' | 'editor' | 'viewer'

/** A group's skill tag. Ids are unique within their group. */
export type GroupTag = {
  id: string
  label: string
  short: string
  sort: number
}

export type GroupSummary = {
  id: string
  name: string
  role: GroupRole
  kFactor: number
  /** Bumped by every content write, for the live refresh poll. */
  rev: number
  playerCount: number
  memberCount: number
  updatedAt: number
}

export type GroupMember = {
  /** The member's user sub; the owner is included with role "owner". */
  id: string
  name: string
  role: GroupRole
  isYou: boolean
  joinedAt: number
}

export type GroupDetail = GroupSummary & {
  ownerName: string
  tags: GroupTag[]
  members: GroupMember[]
}

export type GroupInvite = {
  id: string
  role: 'editor' | 'viewer'
  createdAt: number
  /** Only present in the response that creates the link. */
  url?: string
}

export type GroupInvitePreview = {
  groupId: string
  name: string
  role: 'editor' | 'viewer'
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
