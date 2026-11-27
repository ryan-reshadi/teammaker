import { ROLES, ROLE_IDS } from '../shared/roles'
import type { GroupTag, Player, Round } from '../shared/types'

const SIT_KEY = 'teammaker.sitouts.v1'
const ROUNDS_KEY = 'teammaker.rounds.v2'
const LEGACY_ROUNDS_KEY = 'teammaker.rounds.v1'
const GROUP_KEY = 'teammaker.activeGroup.v1'
const GUEST_TAGS_KEY = 'teammaker.guestTags.v1'
const LEGACY_PLAYERS_KEY = 'teammaker.players.v1'
const LEGACY_IMPORTED_KEY = 'teammaker.legacyRoundsImported.v1'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private browsing with no storage: the session still works, nothing persists.
  }
}

/** Whoever is sitting out is a per-device, per-group decision. */
export function readSitOuts(groupId: string): string[] {
  const all = read<Record<string, string[]>>(SIT_KEY, {})
  const ids = all[groupId]
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
}

export function writeSitOuts(groupId: string, ids: string[]) {
  const all = read<Record<string, string[]>>(SIT_KEY, {})
  all[groupId] = [...new Set(ids)]
  write(SIT_KEY, all)
}

/** Saved team snapshots never leave this browser. */
export function readLocalRounds(groupId: string): Round[] {
  const all = read<Record<string, Round[]>>(ROUNDS_KEY, {})
  const rounds = all[groupId]
  if (Array.isArray(rounds) && rounds.length > 0) return rounds
  const legacy = read<Round[]>(LEGACY_ROUNDS_KEY, [])
  if (Array.isArray(legacy) && legacy.length > 0 && groupId === 'local') {
    all[groupId] = legacy.slice(0, 60)
    write(ROUNDS_KEY, all)
    return all[groupId]!
  }
  return Array.isArray(rounds) ? rounds : []
}

export function saveLocalRound(groupId: string, round: Round): Round[] {
  const all = read<Record<string, Round[]>>(ROUNDS_KEY, {})
  const rounds = readLocalRounds(groupId)
  all[groupId] = [round, ...rounds].slice(0, 60)
  write(ROUNDS_KEY, all)
  return all[groupId]!
}

export function removeLocalRound(groupId: string, id: string): Round[] {
  const all = read<Record<string, Round[]>>(ROUNDS_KEY, {})
  const rounds = readLocalRounds(groupId).filter((round) => round.id !== id)
  all[groupId] = rounds
  write(ROUNDS_KEY, all)
  return rounds
}

/** Whether this browser already checked a group for rounds saved before groups. */
export function wereLegacyRoundsImported(groupId: string): boolean {
  const all = read<Record<string, boolean>>(LEGACY_IMPORTED_KEY, {})
  return all[groupId] === true
}

/**
 * Pull server snapshots into this browser exactly once. The marker is written
 * even when the server has no rounds, so every later load stays a no-op.
 * Returns the merged list when something was imported.
 */
export function importLegacyRounds(
  groupId: string,
  incoming: Round[],
): Round[] | null {
  const checked = read<Record<string, boolean>>(LEGACY_IMPORTED_KEY, {})
  if (checked[groupId]) return null
  checked[groupId] = true
  write(LEGACY_IMPORTED_KEY, checked)
  if (incoming.length === 0) return null

  const current = readLocalRounds(groupId)
  const ids = new Set(current.map((round) => round.id))
  const merged = [...current, ...incoming.filter((round) => !ids.has(round.id))]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 60)
  const all = read<Record<string, Round[]>>(ROUNDS_KEY, {})
  all[groupId] = merged
  write(ROUNDS_KEY, all)
  return merged
}

/** The group last opened on this device, so a reload lands in the same place. */
export function readActiveGroupId(): string | null {
  try {
    return localStorage.getItem(GROUP_KEY)
  } catch {
    return null
  }
}

export function writeActiveGroupId(id: string | null) {
  try {
    if (id) localStorage.setItem(GROUP_KEY, id)
    else localStorage.removeItem(GROUP_KEY)
  } catch {
    // Nothing to do.
  }
}

const legacyTag = (id: string): GroupTag | null => {
  const role = ROLES.find((entry) => entry.id === id)
  return role
    ? { id: role.id, label: role.label, short: role.short, sort: ROLE_IDS.indexOf(id) }
    : null
}

/**
 * The guest workspace's tags. A device that already rated players with the old
 * role catalogue gets exactly the roles it used, so those tags keep working;
 * a fresh device starts with none, like any new group.
 */
export function readGuestTags(): GroupTag[] {
  const stored = read<GroupTag[] | null>(GUEST_TAGS_KEY, null)
  if (Array.isArray(stored)) return stored
  const players = read<Player[]>(LEGACY_PLAYERS_KEY, [])
  const used = new Set<string>()
  for (const player of players)
    for (const tag of player.tags ?? []) if (typeof tag === 'string') used.add(tag)
  const tags = ROLE_IDS.filter((id) => used.has(id))
    .map(legacyTag)
    .filter((tag): tag is GroupTag => tag !== null)
  write(GUEST_TAGS_KEY, tags)
  return tags
}

export function writeGuestTags(tags: GroupTag[]) {
  write(GUEST_TAGS_KEY, tags)
}
