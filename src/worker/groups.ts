import { DEFAULT_K_FACTOR, isKFactor } from '../shared/elo'
import { ROLE_IDS, ROLES } from '../shared/roles'
import type {
  GroupDetail,
  GroupMember,
  GroupRole,
  GroupSummary,
  GroupTag,
} from '../shared/types'
import type { Database, Statement } from './db'

export const MAX_GROUPS = 25
export const MAX_MEMBERS = 100
export const MAX_TAGS = 16
export const MAX_GROUP_NAME = 40
export const MAX_TAG_LABEL = 24
export const MAX_TAG_SHORT = 3
export const MAX_TAG_ID = 40
export const MAX_EMAIL_LENGTH = 254
export const MAX_REQUEST_NOTE = 280
export const MAX_EMAILS_PER_PLAYER = 10

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type GroupRow = {
  id: string
  owner_sub: string
  owner_name: string
  name: string
  k_factor: number
  rev: number
  created_at: number
  updated_at: number
  role?: string | null
  player_count?: number
  member_count?: number
}

export type TagRow = {
  id: string
  label: string
  short: string
  sort: number
}

export type MemberRow = {
  user_sub: string
  role: string
  display_name: string
  created_at: number
}

export const isGroupRole = (value: unknown): value is GroupRole =>
  value === 'owner' || value === 'editor' || value === 'viewer'

/** Emails are labels on a player, stored lowercase and never used for access. */
export const readEmail = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length >= 3 &&
    email.length <= MAX_EMAIL_LENGTH &&
    EMAIL_SHAPE.test(email) &&
    !/[\u0000-\u001f\u007f]/.test(email)
    ? email
    : null
}

/** A request's personal note is optional free text with a small bound. */
export const readNote = (value: unknown): string | null => {
  if (value === undefined) return ''
  if (typeof value !== 'string') return null
  const note = value.trim().replace(/\s+/g, ' ')
  return note.length <= MAX_REQUEST_NOTE ? note : null
}

export const readGroupName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length >= 1 && name.length <= MAX_GROUP_NAME ? name : null
}

/** Tag labels are free text within a small bound; ids are generated. */
export const readTagLabel = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const label = value.trim().replace(/\s+/g, ' ')
  return label.length >= 1 && label.length <= MAX_TAG_LABEL ? label : null
}

export const readTagShort = (value: unknown): string | null => {
  if (value === undefined) return ''
  if (typeof value !== 'string') return null
  const short = value.trim()
  return short.length <= MAX_TAG_SHORT && !/[\u0000-\u001f\u007f]/.test(short)
    ? short
    : null
}

export const mapTag = (row: TagRow): GroupTag => ({
  id: row.id,
  label: row.label,
  short: row.short,
  sort: row.sort,
})

export async function loadTags(db: Database, groupId: string): Promise<GroupTag[]> {
  const rows = await db
    .prepare(
      'SELECT id, label, short, sort FROM group_tags WHERE group_id = ? ORDER BY sort ASC, id ASC',
    )
    .bind(groupId)
    .all<TagRow>()
  return rows.results.map(mapTag)
}

/**
 * The caller's role in a live group, or null when the group is deleted or they
 * are not a member. The owner's row is implicit: `groups.owner_sub`.
 */
export async function roleFor(
  db: Database,
  groupId: string,
  sub: string,
): Promise<GroupRole | null> {
  const row = await db
    .prepare(
      `SELECT g.owner_sub, m.role FROM groups g
       LEFT JOIN group_members m ON m.group_id = g.id AND m.user_sub = ?
       WHERE g.id = ? AND g.deleted_at IS NULL`,
    )
    .bind(sub, groupId)
    .first<{ owner_sub: string; role: string | null }>()
  if (!row) return null
  if (row.owner_sub === sub) return 'owner'
  return row.role === 'editor' || row.role === 'viewer' ? row.role : null
}

export async function loadGroupDetail(
  db: Database,
  groupId: string,
  sub: string,
): Promise<GroupDetail | null> {
  const row = await db
    .prepare(
      `SELECT g.id, g.owner_sub, g.owner_name, g.name, g.k_factor, g.rev,
              g.created_at, g.updated_at,
              CASE WHEN g.owner_sub = ? THEN 'owner' ELSE m.role END AS role,
              (SELECT COUNT(*) FROM players p WHERE p.group_id = g.id AND p.deleted_at IS NULL) AS player_count,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) + 1 AS member_count
       FROM groups g
       LEFT JOIN group_members m ON m.group_id = g.id AND m.user_sub = ?
       WHERE g.id = ? AND g.deleted_at IS NULL`,
    )
    .bind(sub, sub, groupId)
    .first<GroupRow>()
  if (!row) return null
  const role = row.owner_sub === sub ? 'owner' : row.role
  if (!isGroupRole(role)) return null

  const members = await db
    .prepare(
      `SELECT user_sub, role, display_name, created_at FROM group_members
       WHERE group_id = ? ORDER BY created_at ASC, user_sub ASC`,
    )
    .bind(groupId)
    .all<MemberRow>()
  const list: GroupMember[] = [
    {
      id: row.owner_sub,
      name: row.owner_name || 'Owner',
      role: 'owner',
      isYou: row.owner_sub === sub,
      joinedAt: row.created_at,
    },
    ...members.results.map(
      (member): GroupMember => ({
        id: member.user_sub,
        name: member.display_name || 'Member',
        role: member.role === 'editor' ? 'editor' : 'viewer',
        isYou: member.user_sub === sub,
        joinedAt: member.created_at,
      }),
    ),
  ]

  return {
    id: row.id,
    name: row.name,
    role,
    kFactor: isKFactor(row.k_factor) ? row.k_factor : DEFAULT_K_FACTOR,
    rev: row.rev,
    playerCount: row.player_count ?? 0,
    memberCount: list.length,
    updatedAt: row.updated_at,
    ownerName: row.owner_name || 'Owner',
    tags: await loadTags(db, groupId),
    members: list,
  }
}

export async function listGroups(
  db: Database,
  sub: string,
): Promise<GroupSummary[]> {
  const rows = await db
    .prepare(
      `SELECT g.id, g.owner_sub, g.owner_name, g.name, g.k_factor, g.rev,
              g.created_at, g.updated_at,
              CASE WHEN g.owner_sub = ? THEN 'owner' ELSE m.role END AS role,
              (SELECT COUNT(*) FROM players p WHERE p.group_id = g.id AND p.deleted_at IS NULL) AS player_count,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) + 1 AS member_count
       FROM groups g
       LEFT JOIN group_members m ON m.group_id = g.id AND m.user_sub = ?
       WHERE g.deleted_at IS NULL AND (g.owner_sub = ? OR m.user_sub IS NOT NULL)
       ORDER BY g.updated_at DESC, g.id ASC`,
    )
    .bind(sub, sub, sub)
    .all<GroupRow>()
  return rows.results.flatMap((row) => {
    const role = row.owner_sub === sub ? 'owner' : row.role
    if (!isGroupRole(role)) return []
    return [
      {
        id: row.id,
        name: row.name,
        role,
        kFactor: isKFactor(row.k_factor) ? row.k_factor : DEFAULT_K_FACTOR,
        rev: row.rev,
        playerCount: row.player_count ?? 0,
        memberCount: row.member_count ?? 1,
        updatedAt: row.updated_at,
      },
    ]
  })
}

/** One statement that marks the group's data as changed for the live poll. */
export const bumpRev = (
  db: Database,
  groupId: string,
  at = Date.now(),
): Statement =>
  db
    .prepare('UPDATE groups SET rev = rev + 1, updated_at = ? WHERE id = ?')
    .bind(at, groupId)

export async function createGroup(
  db: Database,
  user: { sub: string; name?: string },
  name: string,
): Promise<GroupSummary> {
  const now = Date.now()
  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO groups (id, owner_sub, owner_name, name, k_factor, rev, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(id, user.sub, user.name ?? '', name, DEFAULT_K_FACTOR, now, now)
    .run()
  return {
    id,
    name,
    role: 'owner',
    kFactor: DEFAULT_K_FACTOR,
    rev: 0,
    playerCount: 0,
    memberCount: 1,
    updatedAt: now,
  }
}

export async function countOwnedGroups(
  db: Database,
  sub: string,
): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS total FROM groups WHERE owner_sub = ? AND deleted_at IS NULL',
    )
    .bind(sub)
    .first<{ total: number }>()
  return row?.total ?? 0
}

const base64url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 32 random bytes: unguessable, and only its hash is ever stored. */
export function newInviteToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Folds a pre-groups workspace into its owner's first group.
 *
 * The group id is deterministic (`g:<sub>`) so two concurrent first requests
 * cannot create two homes for the same history, and the row updates are
 * `WHERE group_id IS NULL` so re-running is harmless. Only the roles the
 * account actually used become tags, keeping their legacy ids so existing
 * player tags stay valid.
 */
export async function ensureGroupForUser(
  db: Database,
  user: { sub: string; name?: string },
): Promise<void> {
  const legacy = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM players WHERE owner_sub = ? AND group_id IS NULL) AS players,
        (SELECT COUNT(*) FROM rating_events WHERE owner_sub = ? AND group_id IS NULL) AS events,
        (SELECT COUNT(*) FROM rating_results WHERE owner_sub = ? AND group_id IS NULL) AS results,
        (SELECT COUNT(*) FROM rounds WHERE owner_sub = ? AND group_id IS NULL) AS rounds,
        (SELECT COUNT(*) FROM log_squashes WHERE owner_sub = ? AND group_id IS NULL) AS squashes`,
    )
    .bind(user.sub, user.sub, user.sub, user.sub, user.sub)
    .first<{
      players: number
      events: number
      results: number
      rounds: number
      squashes: number
    }>()
  const total =
    (legacy?.players ?? 0) +
    (legacy?.events ?? 0) +
    (legacy?.results ?? 0) +
    (legacy?.rounds ?? 0) +
    (legacy?.squashes ?? 0)
  if (total === 0) return

  const groupId = `g:${user.sub}`
  const now = Date.now()
  const settings = await db
    .prepare('SELECT k_factor FROM settings WHERE owner_sub = ?')
    .bind(user.sub)
    .first<{ k_factor: number }>()
  const kFactor =
    settings && isKFactor(settings.k_factor) ? settings.k_factor : DEFAULT_K_FACTOR

  const used = new Set<string>()
  const tagged = await db
    .prepare('SELECT tags FROM players WHERE owner_sub = ? AND group_id IS NULL')
    .bind(user.sub)
    .all<{ tags: string }>()
  for (const row of tagged.results) {
    try {
      const tags: unknown = JSON.parse(row.tags)
      if (Array.isArray(tags))
        for (const tag of tags) if (typeof tag === 'string') used.add(tag)
    } catch {
      // A malformed legacy tag list is treated as no tags.
    }
  }

  const statements: Statement[] = [
    db
      .prepare(
        `INSERT INTO groups (id, owner_sub, owner_name, name, k_factor, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(groupId, user.sub, user.name ?? '', 'My roster', kFactor, now, now),
  ]
  let sort = 0
  for (const roleId of ROLE_IDS) {
    if (!used.has(roleId)) continue
    const role = ROLES.find((entry) => entry.id === roleId)!
    statements.push(
      db
        .prepare(
          `INSERT INTO group_tags (group_id, id, label, short, sort, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(group_id, id) DO NOTHING`,
        )
        .bind(groupId, roleId, role.label, role.short, sort, now, now),
    )
    sort += 1
  }
  for (const table of ['players', 'rating_events', 'rating_results', 'rounds'] as const) {
    statements.push(
      db
        .prepare(`UPDATE ${table} SET group_id = ? WHERE owner_sub = ? AND group_id IS NULL`)
        .bind(groupId, user.sub),
    )
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO group_rating_meta (group_id, legacy_k, created_at)
         SELECT ?, legacy_k, created_at FROM rating_meta WHERE owner_sub = ?
         ON CONFLICT(group_id) DO NOTHING`,
      )
      .bind(groupId, user.sub),
    db
      .prepare(
        `INSERT INTO group_squashes (group_id, removed, squashed_at)
         SELECT ?, removed, squashed_at FROM log_squashes WHERE owner_sub = ?
         ON CONFLICT(group_id) DO NOTHING`,
      )
      .bind(groupId, user.sub),
  )
  await db.batch(statements)
}
