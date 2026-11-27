/**
 * Skill tags. Groups define their own (see `group_tags`); the original eight
 * shooter roles remain here as the labels used when an existing roster is
 * migrated into its first group, and as the backward-compatible default for
 * helpers that are called without an explicit tag list.
 */

import type { GroupTag } from './types'

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

/**
 * Drops unknown ids and duplicates, keeping the order of `allowed`. Callers
 * pass a group's tag ids; without one the legacy role catalogue is used.
 */
export function normalizeTags(
  value: unknown,
  allowed: readonly string[] = ROLE_IDS,
): string[] {
  if (!Array.isArray(value)) return []
  const chosen = new Set<string>()
  for (const item of value) if (typeof item === 'string') chosen.add(item)
  return allowed.filter((id) => chosen.has(id))
}

/** Tags as a bitmask over `ids`, so the solver can count coverage cheaply. */
export function roleMask(
  tags?: string[],
  ids: readonly string[] = ROLE_IDS,
): number {
  if (!tags?.length) return 0
  let mask = 0
  tags.forEach((tag) => {
    const bit = ids.indexOf(tag)
    if (bit >= 0) mask |= 1 << bit
  })
  return mask
}

/** The legacy catalogue size. Group tags are indexed per solve instead. */
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
  tagIds: readonly string[] = ROLE_IDS,
): RoleCoverage {
  const allowed = tagIds
  const counts = teams.map((team) => {
    const result: Record<string, number> = {}
    for (const player of team.players)
      for (const tag of normalizeTags(player.tags, allowed))
        result[tag] = (result[tag] ?? 0) + 1
    return result
  })
  const totals: Record<string, number> = {}
  for (const team of counts)
    for (const [role, count] of Object.entries(team))
      totals[role] = (totals[role] ?? 0) + count
  const missing: { teamIndex: number; role: string }[] = []
  for (const role of allowed) {
    if ((totals[role] ?? 0) < teams.length) continue
    counts.forEach((team, teamIndex) => {
      if (!team[role]) missing.push({ teamIndex, role })
    })
  }
  return { counts, totals, missing }
}

/** How many teams are missing a role they could have had. Lower is better. */
export function roleGapScore(
  teams: { players: { tags?: string[] }[] }[],
  tagIds: readonly string[] = ROLE_IDS,
): number {
  return roleCoverage(teams, tagIds).missing.length
}

/** Label lookup for a group's tags, with the terse legacy names as fallback. */
export function tagLabel(tags: readonly GroupTag[], id: string): string {
  return tags.find((tag) => tag.id === id)?.label ?? roleLabel(id)
}

export function tagShort(tags: readonly GroupTag[], id: string): string {
  const tag = tags.find((entry) => entry.id === id)
  if (tag) return tag.short || tag.label.slice(0, 2).toUpperCase()
  return roleShort(id)
}

/** Two-letter-ish chip text for a tag id, from its label when it has no short. */
export function tagShortFromLabel(label: string): string {
  const words = label.trim().split(/\s+/)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  return label.slice(0, 2).toUpperCase()
}
