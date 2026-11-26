/**
 * The tag framework: a fixed catalogue of shooter roles. Players may hold any
 * number of them (a sniper who also calls the round), and the solver uses them
 * to rank splits that are equally balanced on skill.
 */

export type Role = {
  id: string
  label: string
  /** Two letters, for tight team columns. */
  short: string
  hint: string
}

export const ROLES: Role[] = [
  {
    id: 'sniper',
    label: 'Sniper',
    short: 'SN',
    hint: 'Long-range picks and sightline control',
  },
  {
    id: 'push',
    label: 'Push',
    short: 'PU',
    hint: 'Takes space and forces the pace',
  },
  {
    id: 'antipush',
    label: 'Anti-push',
    short: 'AP',
    hint: 'Holds a lane and stops the other side pushing',
  },
  {
    id: 'entry',
    label: 'Entry',
    short: 'EN',
    hint: 'First through the door, opens the site',
  },
  {
    id: 'support',
    label: 'Support',
    short: 'SU',
    hint: 'Utility, smokes, heals and trades for the team',
  },
  {
    id: 'flank',
    label: 'Flank',
    short: 'FL',
    hint: 'Off-angles, lurks and back-line pressure',
  },
  {
    id: 'igl',
    label: 'IGL',
    short: 'IG',
    hint: 'Calls the round',
  },
  {
    id: 'flex',
    label: 'Flex',
    short: 'FX',
    hint: 'Fills whatever the team is missing',
  },
]

export const ROLE_IDS: string[] = ROLES.map((role) => role.id)

const byId = new Map(ROLES.map((role) => [role.id, role]))

export const roleLabel = (id: string): string => byId.get(id)?.label ?? id

export const roleShort = (id: string): string => byId.get(id)?.short ?? id.slice(0, 2)

export const roleHint = (id: string): string => byId.get(id)?.hint ?? ''

/** Drops unknown ids and duplicates, keeping catalogue order. */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const chosen = new Set<string>()
  for (const item of value) if (typeof item === 'string') chosen.add(item)
  return ROLE_IDS.filter((id) => chosen.has(id))
}

const ROLE_BITS = new Map(ROLE_IDS.map((id, index) => [id, 1 << index]))

/** Roles as a bitmask, so the solver can count coverage cheaply. */
export function roleMask(tags?: string[]): number {
  if (!tags?.length) return 0
  let mask = 0
  for (const tag of tags) mask |= ROLE_BITS.get(tag) ?? 0
  return mask
}

export const ROLE_COUNT = ROLE_IDS.length

export type RoleCoverage = {
  /** Role counts per team, in team order. */
  counts: Record<string, number>[]
  /** How many players hold each role across the whole split. */
  totals: Record<string, number>
  /**
   * Roles held by enough players to be common (at least one per team) but
   * missing from some team. A role only one player has is a specialist, not a
   * gap, so it is never reported.
   */
  missing: { teamIndex: number; role: string }[]
}

export function roleCoverage(
  teams: { players: { tags?: string[] }[] }[],
): RoleCoverage {
  const counts = teams.map((team) => {
    const result: Record<string, number> = {}
    for (const player of team.players)
      for (const tag of normalizeTags(player.tags))
        result[tag] = (result[tag] ?? 0) + 1
    return result
  })
  const totals: Record<string, number> = {}
  for (const team of counts)
    for (const [role, count] of Object.entries(team))
      totals[role] = (totals[role] ?? 0) + count
  const missing: { teamIndex: number; role: string }[] = []
  for (const role of ROLE_IDS) {
    if ((totals[role] ?? 0) < teams.length) continue
    counts.forEach((team, teamIndex) => {
      if (!team[role]) missing.push({ teamIndex, role })
    })
  }
  return { counts, totals, missing }
}

/** How many teams are missing a role they could have had. Lower is better. */
export function roleGapScore(teams: { players: { tags?: string[] }[] }[]): number {
  return roleCoverage(teams).missing.length
}
