import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  DEFAULT_K_FACTOR,
  FLAT_K_FORMULA,
  MAX_DAMAGE,
  MAX_EVENTS,
  MAX_MATCH_PLAYERS,
  MAX_MATCH_TEAMS,
  clampElo,
  eventFormula,
  isKFactor,
  replay,
  skillFromElo,
  usesProvisionalK,
  type AdjustInput,
  type MatchEventView,
  type MatchInput,
  type MatchPlayerInput,
  type MatchRoster,
  type MatchTeamInput,
  type RatingEvent,
  type RatingEventView,
  type ReplayResult,
} from '../shared/elo'
import { normalizeTags, ROLE_IDS } from '../shared/roles'
import type { GroupPlayerRequest, GroupRole, Player } from '../shared/types'
import { appOrigin, currentUser, isLocalPreview } from './auth'
import {
  ensureSchema,
  mapPlayer,
  mapRound,
  REQUIRED_TABLES,
  type Database,
  type PlayerRow,
  type RoundRow,
  type Statement,
} from './db'
import {
  MAX_EMAILS_PER_PLAYER,
  MAX_GROUPS,
  MAX_MEMBERS,
  MAX_REQUEST_NOTE,
  MAX_TAGS,
  bumpRev,
  countOwnedGroups,
  createGroup,
  ensureGroupForUser,
  hashInviteToken,
  isGroupRole,
  listGroups,
  loadGroupDetail,
  loadTags,
  newInviteToken,
  readEmail,
  readGroupName,
  readNote,
  readTagLabel,
  readTagShort,
  roleFor,
  type MemberRow,
} from './groups'
import { groupGuard, sessionGuard, type AppContext, type Authenticate } from './guard'

const ROSTER_LIMIT = 200
const MAX_BATCH = 50
const MAX_LABEL = 60
const MAX_REASON = 80
/** Events a squash removes from the front and keeps at the back. */
export const SQUASH_KEEP = 500
const MATCH_ERROR =
  'A match needs two to eight teams, damage for every player, a winner and at least one player from your roster.'

const readName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length >= 1 && name.length <= 40 ? name : null
}

const MAX_USERNAME = 32

/** An optional handle: empty clears it, absent leaves it as it is. */
const readUsername = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const username = value.trim()
  return username.length <= MAX_USERNAME && !/[\u0000-\u001f\u007f]/.test(username)
    ? username
    : null
}

const readSkill = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10
    ? value
    : null

const readElo = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 1000
    ? value
    : null

/** Absent tags mean none; unknown ids are rejected rather than dropped. */
const readTags = (
  value: unknown,
  allowed: readonly string[],
): string[] | null => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_TAGS) return null
  for (const item of value)
    if (typeof item !== 'string' || !allowed.includes(item)) return null
  return normalizeTags(value, allowed)
}

const readRole = (value: unknown): 'editor' | 'viewer' | null =>
  value === 'editor' || value === 'viewer' ? value : null

/** A claim on a roster player, or a proposal to add one. */
type Claim =
  | { kind: 'link'; playerId: string }
  | { kind: 'create'; name: string; username: string }

function readClaim(value: unknown): Claim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.kind === 'link') {
    if (Object.keys(record).some((key) => key !== 'kind' && key !== 'playerId'))
      return null
    if (
      typeof record.playerId !== 'string' ||
      record.playerId.length < 1 ||
      record.playerId.length > 64
    )
      return null
    return { kind: 'link', playerId: record.playerId }
  }
  if (record.kind === 'create') {
    if (
      Object.keys(record).some(
        (key) => key !== 'kind' && key !== 'name' && key !== 'username',
      )
    )
      return null
    const name = readName(record.name)
    const username = readUsername(record.username)
    // A new player arrives with both details and no elo field, so nobody can
    // seed themselves a rating.
    if (!name || !username) return null
    return { kind: 'create', name, username }
  }
  return null
}

type ClaimDraft = { claim: Claim; note: string; email: string }

/**
 * The account's own email is attached automatically. Only an account without
 * one may supply an address, so a form cannot file a request for somebody
 * else's mailbox.
 */
function readClaimDraft(
  body: Record<string, unknown>,
  user: { email?: string },
): { draft: ClaimDraft | null; error: string } {
  if (
    Object.keys(body).some(
      (key) => key !== 'claim' && key !== 'note' && key !== 'email',
    )
  )
    return { draft: null, error: 'Choose a player to connect.' }
  const claim = readClaim(body.claim)
  if (!claim)
    return {
      draft: null,
      error:
        'Choose a player from the roster, or add one with a name and username.',
    }
  const note = readNote(body.note)
  if (note === null)
    return {
      draft: null,
      error: `A note is up to ${MAX_REQUEST_NOTE} characters.`,
    }
  const accountEmail =
    typeof user.email === 'string' && user.email.trim() ? user.email : null
  const email = accountEmail ? readEmail(accountEmail) : readEmail(body.email)
  if (!email)
    return {
      draft: null,
      error: accountEmail
        ? 'Your account email cannot be used for this request.'
        : typeof body.email === 'string' && body.email.trim()
          ? 'That does not look like an email address.'
          : 'Enter the email to connect before sending the request.',
    }
  return { draft: { claim, note, email }, error: '' }
}

type Draft = { name: string; username: string; skill: number; tags: string[] }

function readDrafts(body: unknown, allowedTags: readonly string[]): Draft[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const list = 'players' in record ? record.players : [record]
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH)
    return null
  const drafts: Draft[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const entry = item as Record<string, unknown>
    if (
      Object.keys(entry).some(
        (key) =>
          key !== 'name' && key !== 'username' && key !== 'skill' && key !== 'tags',
      )
    )
      return null
    const name = readName(entry.name)
    const username =
      entry.username === undefined ? '' : readUsername(entry.username)
    const skill = readSkill(entry.skill)
    const tags = readTags(entry.tags, allowedTags)
    if (!name || username === null || skill === null || !tags) return null
    drafts.push({ name, username, skill, tags })
  }
  return drafts
}

function readMatchInput(value: unknown): MatchInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) => key !== 'label' && key !== 'teams' && key !== 'winner',
    )
  )
    return null
  const label =
    record.label === undefined
      ? ''
      : typeof record.label === 'string' && record.label.trim().length <= MAX_LABEL
        ? record.label.trim()
        : null
  if (label === null) return null
  if (
    !Array.isArray(record.teams) ||
    record.teams.length < 2 ||
    record.teams.length > MAX_MATCH_TEAMS
  )
    return null

  const seen = new Set<string>()
  const teams: MatchTeamInput[] = []
  let tracked = 0
  let totalDamage = 0
  for (const rawTeam of record.teams) {
    if (!rawTeam || typeof rawTeam !== 'object' || Array.isArray(rawTeam))
      return null
    const team = rawTeam as Record<string, unknown>
    if (Object.keys(team).some((key) => key !== 'players')) return null
    if (
      !Array.isArray(team.players) ||
      team.players.length < 1 ||
      team.players.length > MAX_MATCH_PLAYERS
    )
      return null
    const players: MatchPlayerInput[] = []
    for (const rawPlayer of team.players) {
      if (
        !rawPlayer ||
        typeof rawPlayer !== 'object' ||
        Array.isArray(rawPlayer)
      )
        return null
      const player = rawPlayer as Record<string, unknown>
      if (
        Object.keys(player).some(
          (key) => key !== 'id' && key !== 'name' && key !== 'damage' && key !== 'tracked',
        )
      )
        return null
      if (
        typeof player.id !== 'string' ||
        player.id.length < 1 ||
        player.id.length > 64 ||
        seen.has(player.id)
      )
        return null
      seen.add(player.id)
      const name = readName(player.name)
      if (!name) return null
      if (
        typeof player.damage !== 'number' ||
        !Number.isInteger(player.damage) ||
        player.damage < 0 ||
        player.damage > MAX_DAMAGE
      )
        return null
      if (typeof player.tracked !== 'boolean') return null
      if (player.tracked) tracked++
      totalDamage += player.damage
      players.push({
        id: player.id,
        name,
        damage: player.damage,
        tracked: player.tracked,
      })
    }
    teams.push({ players })
  }
  if (tracked === 0 || totalDamage === 0) return null
  if (
    typeof record.winner !== 'number' ||
    !Number.isInteger(record.winner) ||
    record.winner < 0 ||
    record.winner >= teams.length
  )
    return null
  return { label, teams, winner: record.winner }
}

type EventRow = {
  id: string
  position: number
  kind: string
  payload: string
  created_at: number
  updated_at: number
}

type ResultRow = {
  event_id: string
  slot: string
  player_id: string | null
  name: string
  elo_before: number
  elo_after: number
  delta: number
}

type BaseRow = PlayerRow & { base_elo: number }

async function loadEvents(db: Database, groupId: string): Promise<RatingEvent[]> {
  const rows = await db
    .prepare(
      'SELECT id, position, kind, payload, created_at, updated_at FROM rating_events WHERE group_id = ? ORDER BY position ASC, created_at ASC, id ASC',
    )
    .bind(groupId)
    .all<EventRow>()
  const events: RatingEvent[] = []
  for (const row of rows.results) {
    let payload: unknown
    try {
      payload = JSON.parse(row.payload)
    } catch {
      continue
    }
    if (row.kind === 'match')
      events.push({
        id: row.id,
        position: row.position,
        kind: 'match',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        payload: payload as MatchInput,
      })
    else if (row.kind === 'adjust')
      events.push({
        id: row.id,
        position: row.position,
        kind: 'adjust',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        payload: payload as AdjustInput,
      })
  }
  return events
}

async function getKFactor(db: Database, groupId: string): Promise<number> {
  const row = await db
    .prepare('SELECT k_factor FROM groups WHERE id = ? AND deleted_at IS NULL')
    .bind(groupId)
    .first<{ k_factor: number }>()
  return row && isKFactor(row.k_factor) ? row.k_factor : DEFAULT_K_FACTOR
}

/**
 * The K that produced ratings written before versioning. Until a K change or
 * the first v2 match pins it, the group's current setting is still that K.
 */
async function getLegacyK(
  db: Database,
  groupId: string,
  currentK: number,
): Promise<number> {
  const row = await db
    .prepare('SELECT legacy_k FROM group_rating_meta WHERE group_id = ?')
    .bind(groupId)
    .first<{ legacy_k: number }>()
  return row && isKFactor(row.legacy_k) ? row.legacy_k : currentK
}

/** One additive row; it never rewrites an existing event or result. */
async function pinLegacyK(
  db: Database,
  groupId: string,
  legacyK: number,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO group_rating_meta (group_id, legacy_k, created_at) VALUES (?, ?, ?) ON CONFLICT(group_id) DO NOTHING',
    )
    .bind(groupId, legacyK, Date.now())
    .run()
}

async function loadPlayers(
  db: Database,
  groupId: string,
  allowedTags: readonly string[],
): Promise<Player[]> {
  const result = await db
    .prepare(
      'SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at FROM players WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC',
    )
    .bind(groupId)
    .all<PlayerRow>()
  const emails = await loadEmailMap(db, groupId)
  return result.results.map((row) =>
    mapPlayer(row, allowedTags, emails.get(row.id) ?? []),
  )
}

type EmailRow = { player_id: string; email: string }

async function loadPlayerEmailList(
  db: Database,
  groupId: string,
  playerId: string,
): Promise<string[]> {
  const rows = await db
    .prepare(
      'SELECT email FROM group_player_emails WHERE group_id = ? AND player_id = ? ORDER BY email ASC',
    )
    .bind(groupId, playerId)
    .all<{ email: string }>()
  return rows.results.map((row) => row.email)
}

/** Every player's connected emails, in one query for the whole roster. */
async function loadEmailMap(
  db: Database,
  groupId: string,
): Promise<Map<string, string[]>> {
  const rows = await db
    .prepare(
      'SELECT player_id, email FROM group_player_emails WHERE group_id = ? ORDER BY email ASC',
    )
    .bind(groupId)
    .all<EmailRow>()
  const map = new Map<string, string[]>()
  for (const row of rows.results) {
    const emails = map.get(row.player_id)
    if (emails) emails.push(row.email)
    else map.set(row.player_id, [row.email])
  }
  return map
}

const linkEmailStatement = (
  db: Database,
  groupId: string,
  playerId: string,
  email: string,
  sub: string,
  at: number,
): Statement =>
  db
    .prepare(
      'INSERT INTO group_player_emails (group_id, player_id, email, added_by_sub, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(group_id, player_id, email) DO NOTHING',
    )
    .bind(groupId, playerId, email, sub, at)

type RequestRow = {
  id: string
  requester_sub: string
  requester_name: string
  email: string
  kind: string
  player_id: string | null
  name: string | null
  username: string | null
  note: string
  created_at: number
  player_name?: string | null
}

const mapRequest = (row: RequestRow, sub: string): GroupPlayerRequest => ({
  id: row.id,
  kind: row.kind === 'create' ? 'create' : 'link',
  playerId: row.player_id,
  playerName: row.player_name ?? null,
  name: row.name,
  username: row.username,
  email: row.email,
  note: row.note,
  requesterName: row.requester_name || 'Member',
  isYou: row.requester_sub === sub,
  createdAt: row.created_at,
})

type FiledRequest =
  | { ok: true; id: string; statement: Statement }
  | { ok: false; error: string; status: 400 | 404 | 409 }

/**
 * Validates one pending request and prepares its insert. The caller writes it
 * with its own batch, so joining a group and asking for a player happen
 * together.
 */
async function filePlayerRequest(
  db: Database,
  groupId: string,
  user: { sub: string; name?: string },
  draft: ClaimDraft,
  at: number,
): Promise<FiledRequest> {
  if (draft.claim.kind === 'link') {
    const player = await db
      .prepare(
        'SELECT id FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL',
      )
      .bind(draft.claim.playerId, groupId)
      .first<{ id: string }>()
    if (!player)
      return {
        ok: false,
        error: 'That player is no longer on this roster.',
        status: 404,
      }
    const linked = await db
      .prepare(
        'SELECT 1 AS found FROM group_player_emails WHERE group_id = ? AND player_id = ? AND email = ?',
      )
      .bind(groupId, draft.claim.playerId, draft.email)
      .first<{ found: number }>()
    if (linked)
      return {
        ok: false,
        error: 'That email is already connected to this player.',
        status: 409,
      }
  }
  const pending = await db
    .prepare(
      "SELECT id FROM group_player_requests WHERE group_id = ? AND requester_sub = ? AND status = 'pending'",
    )
    .bind(groupId, user.sub)
    .first<{ id: string }>()
  if (pending)
    return {
      ok: false,
      error: 'You already have a player request waiting for an editor.',
      status: 409,
    }
  const id = crypto.randomUUID()
  return {
    ok: true,
    id,
    statement: db
      .prepare(
        `INSERT INTO group_player_requests (id, group_id, requester_sub, requester_name, email, kind, player_id, name, username, note, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        id,
        groupId,
        user.sub,
        user.name ?? '',
        draft.email,
        draft.claim.kind,
        draft.claim.kind === 'link' ? draft.claim.playerId : null,
        draft.claim.kind === 'create' ? draft.claim.name : null,
        draft.claim.kind === 'create' ? draft.claim.username : null,
        draft.note,
        at,
        at,
      ),
  }
}

type AppliedRequest =
  | { ok: true; playerId: string; statements: Statement[] }
  | { ok: false; error: string; status: 400 | 409 }

/** Turns an approved request into roster changes; it never edits an existing elo. */
async function applyPlayerRequest(
  db: Database,
  groupId: string,
  row: RequestRow,
  at: number,
): Promise<AppliedRequest> {
  if (row.kind === 'link') {
    if (!row.player_id)
      return { ok: false, error: 'That request has no player.', status: 400 }
    const player = await db
      .prepare(
        'SELECT id FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL',
      )
      .bind(row.player_id, groupId)
      .first<{ id: string }>()
    if (!player)
      return {
        ok: false,
        error:
          'That player is no longer on the roster, so the request cannot be applied.',
        status: 409,
      }
    return {
      ok: true,
      playerId: row.player_id,
      statements: [
        linkEmailStatement(
          db,
          groupId,
          row.player_id,
          row.email,
          row.requester_sub,
          at,
        ),
      ],
    }
  }
  const name = row.name
  const username = row.username
  if (!name || !username)
    return {
      ok: false,
      error: 'That request is missing a display name or username.',
      status: 400,
    }
  const existing = await db
    .prepare(
      'SELECT COUNT(*) AS total FROM players WHERE group_id = ? AND deleted_at IS NULL',
    )
    .bind(groupId)
    .first<{ total: number }>()
  if ((existing?.total ?? 0) + 1 > ROSTER_LIMIT)
    return { ok: false, error: 'A roster holds up to 200 players.', status: 400 }
  const id = crypto.randomUUID()
  return {
    ok: true,
    playerId: id,
    statements: [
      db
        .prepare(
          'INSERT INTO players (id, owner_sub, group_id, name, username, skill, elo, base_elo, tags, sitting_out, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?)',
        )
        .bind(
          id,
          row.requester_sub,
          groupId,
          name,
          username,
          skillFromElo(0),
          '[]',
          at,
          at,
        ),
      linkEmailStatement(db, groupId, id, row.email, row.requester_sub, at),
    ],
  }
}

async function nextPosition(db: Database, groupId: string): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM rating_events WHERE group_id = ?',
    )
    .bind(groupId)
    .first<{ next: number }>()
  return row?.next ?? 0
}

async function findEvent(
  db: Database,
  groupId: string,
  id: string,
): Promise<EventRow | null> {
  return db
    .prepare(
      'SELECT id, position, kind, payload, created_at, updated_at FROM rating_events WHERE id = ? AND group_id = ?',
    )
    .bind(id, groupId)
    .first<EventRow>()
}

const insertResultSql =
  'INSERT INTO rating_results (event_id, owner_sub, group_id, slot, player_id, name, elo_before, elo_after, delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'

/**
 * Rebuilds every rating from the log, then writes the affected bookkeeping
 * rows. `from` is the earliest position whose outcome can have changed.
 */
async function recompute(
  db: Database,
  groupId: string,
  from: number,
): Promise<Player[]> {
  const players = await db
    .prepare(
      'SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at, base_elo, deleted_at FROM players WHERE group_id = ? ORDER BY created_at ASC, id ASC',
    )
    .bind(groupId)
    .all<BaseRow>()
  const events = await loadEvents(db, groupId)
  const kFactor = await getKFactor(db, groupId)
  const legacyK = await getLegacyK(db, groupId, kFactor)
  // `owner_sub` stays the group's creator for older readers and the existing
  // test queries; every route scopes by `group_id`.
  const owner = await db
    .prepare('SELECT owner_sub FROM groups WHERE id = ?')
    .bind(groupId)
    .first<{ owner_sub: string }>()
  const ownerSub = owner?.owner_sub ?? groupId
  const roster: MatchRoster[] = players.results.map((player) => ({
    id: player.id,
    name: player.name,
    baseElo: player.base_elo,
  }))
  const { elos, outcomes }: ReplayResult = replay(events, roster, kFactor, legacyK)

  const statements: Statement[] = []
  for (const player of players.results) {
    const elo = elos.get(player.id) ?? player.elo
    const skill = skillFromElo(elo)
    if (elo !== player.elo || skill !== player.skill)
      statements.push(
        db
          .prepare('UPDATE players SET elo = ?, skill = ? WHERE id = ? AND group_id = ?')
          .bind(elo, skill, player.id, groupId),
      )
  }

  statements.push(
    db
      .prepare(
        'DELETE FROM rating_results WHERE group_id = ? AND event_id IN (SELECT id FROM rating_events WHERE group_id = ? AND position >= ?)',
      )
      .bind(groupId, groupId, from),
  )

  const names = new Map(players.results.map((player) => [player.id, player.name]))
  for (const event of events) {
    if (event.position < from) continue
    const outcome = outcomes.get(event.id)
    if (!outcome) continue
    if (outcome.kind === 'match') {
      outcome.result.teams.forEach((team, teamIndex) => {
        team.players.forEach((player, slot) => {
          statements.push(
            db
              .prepare(insertResultSql)
              .bind(
                event.id,
                ownerSub,
                groupId,
                `${teamIndex}:${slot}`,
                player.id,
                player.name,
                player.eloBefore,
                player.eloAfter,
                player.delta,
              ),
          )
        })
      })
      continue
    }
    const { playerId, eloBefore, eloAfter } = outcome.result
    statements.push(
      db
        .prepare(insertResultSql)
        .bind(
          event.id,
          ownerSub,
          groupId,
          '0',
          playerId,
          names.get(playerId) ?? '',
          eloBefore,
          eloAfter,
          eloAfter - eloBefore,
        ),
    )
  }

  if (statements.length > 0) await db.batch(statements)

  const tags = await loadTags(db, groupId)
  const allowed = tags.map((tag) => tag.id)
  const emails = await loadEmailMap(db, groupId)
  return players.results
    .filter((player) => !player.deleted_at)
    .map((player) =>
      mapPlayer(
        {
          ...player,
          elo: elos.get(player.id) ?? player.elo,
          skill: skillFromElo(elos.get(player.id) ?? player.elo),
        },
        allowed,
        emails.get(player.id) ?? [],
      ),
    )
}

async function countEvents(db: Database, groupId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM rating_events WHERE group_id = ?')
    .bind(groupId)
    .first<{ total: number }>()
  return row?.total ?? 0
}

/**
 * Folds the oldest events into each player's replay anchor, then deletes them.
 * `base_elo` becomes the elo at the cut, so the kept log replays forward to
 * exactly the ratings it produced before: no `elo` moves and every kept
 * `rating_results` row stays valid. Only the history is lost.
 */
export async function compactLog(
  db: Database,
  groupId: string,
  keep = SQUASH_KEEP,
): Promise<{ removed: number; kept: number }> {
  const events = await loadEvents(db, groupId)
  if (events.length <= keep) return { removed: 0, kept: events.length }

  let cut = events.length - keep
  for (let index = events.length - 1; index >= cut; index -= 1) {
    const event = events[index]!
    if (event.kind === 'match' && usesProvisionalK(eventFormula(event.payload))) {
      cut = index + 1
      break
    }
  }
  if (cut >= events.length) return { removed: 0, kept: events.length }

  const players = await db
    .prepare(
      'SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at, base_elo, deleted_at FROM players WHERE group_id = ? ORDER BY created_at ASC, id ASC',
    )
    .bind(groupId)
    .all<BaseRow>()
  const kFactor = await getKFactor(db, groupId)
  const legacyK = await getLegacyK(db, groupId, kFactor)
  const roster: MatchRoster[] = players.results.map((player) => ({
    id: player.id,
    name: player.name,
    baseElo: player.base_elo,
  }))
  const { elos } = replay(events.slice(0, cut), roster, kFactor, legacyK)

  const oldest = `(SELECT id FROM rating_events WHERE group_id = ? ORDER BY position ASC, created_at ASC, id ASC LIMIT ${cut})`
  const statements: Statement[] = []
  for (const player of players.results) {
    const anchor = clampElo(elos.get(player.id) ?? player.base_elo)
    if (anchor === player.base_elo) continue
    statements.push(
      db
        .prepare('UPDATE players SET base_elo = ? WHERE id = ? AND group_id = ?')
        .bind(anchor, player.id, groupId),
    )
  }
  statements.push(
    db
      .prepare(`DELETE FROM rating_results WHERE group_id = ? AND event_id IN ${oldest}`)
      .bind(groupId, groupId),
    db.prepare(`DELETE FROM rating_events WHERE id IN ${oldest}`).bind(groupId),
    db
      .prepare(
        'INSERT INTO group_squashes (group_id, removed, squashed_at) VALUES (?, ?, ?) ON CONFLICT(group_id) DO UPDATE SET removed = group_squashes.removed + excluded.removed, squashed_at = excluded.squashed_at',
      )
      .bind(groupId, cut, Date.now()),
    bumpRev(db, groupId),
  )
  await db.batch(statements)
  return { removed: cut, kept: events.length - cut }
}

/**
 * Makes room for one more event, compacting a full log. `false` means the log is
 * at the cap and nothing could safely be cut.
 */
async function makeRoom(db: Database, groupId: string): Promise<boolean> {
  if ((await countEvents(db, groupId)) < MAX_EVENTS) return true
  const { removed } = await compactLog(db, groupId)
  return removed > 0
}

async function matchViews(
  db: Database,
  groupId: string,
): Promise<RatingEventView[]> {
  const events = await loadEvents(db, groupId)
  const rows = await db
    .prepare(
      'SELECT event_id, slot, player_id, name, elo_before, elo_after, delta FROM rating_results WHERE group_id = ?',
    )
    .bind(groupId)
    .all<ResultRow>()
  const results = new Map(
    rows.results.map((row) => [`${row.event_id}|${row.slot}`, row]),
  )

  return events.map((event): RatingEventView => {
    if (event.kind === 'adjust') {
      const row = results.get(`${event.id}|0`)
      return {
        id: event.id,
        kind: 'adjust',
        position: event.position,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        playerId: event.payload.playerId,
        name: row?.name ?? '',
        reason: event.payload.reason,
        eloBefore: row?.elo_before ?? event.payload.elo,
        eloAfter: row?.elo_after ?? event.payload.elo,
        delta: row?.delta ?? 0,
      }
    }
    const teams = event.payload.teams.map((team, teamIndex) => ({
      players: team.players.map((player, slot) => {
        const row = results.get(`${event.id}|${teamIndex}:${slot}`)
        return {
          id: player.tracked ? player.id : null,
          name: row?.name ?? player.name,
          damage: player.damage,
          tracked: player.tracked,
          elo: row?.elo_before ?? 0,
          eloBefore: row?.elo_before ?? 0,
          eloAfter: row?.elo_after ?? 0,
          delta: row?.delta ?? 0,
        }
      }),
    }))
    return {
      id: event.id,
      kind: 'match',
      position: event.position,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      label: event.payload.label,
      winner: event.payload.winner,
      teams,
    } satisfies MatchEventView
  })
}

/**
 * New matches may only name players on the group's roster. An edit passes
 * `includeArchived`, because a lineup logged before a removal must stay
 * editable and the archived row still has a real rating in the replay.
 */
async function trackedIdsExist(
  db: Database,
  groupId: string,
  ids: string[],
  includeArchived = false,
): Promise<boolean> {
  if (ids.length === 0) return true
  const rows = await db
    .prepare(
      `SELECT id FROM players WHERE group_id = ?${includeArchived ? '' : ' AND deleted_at IS NULL'} AND id IN (${ids.map(() => '?').join(', ')})`,
    )
    .bind(groupId, ...ids)
    .all<{ id: string }>()
  return rows.results.length === new Set(ids).size
}

/** Tests inject identities; production uses the SDK. */
export function createApp(authenticate: Authenticate = currentUser) {
  const app = new Hono<AppContext>()

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    await next()
  })
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: 'Request is too large.' }, 413),
    }),
  )

  // Reachability probe: one real round trip, no authentication, no rows written.
  app.get('/api/health', async (c) => {
    c.header('Cache-Control', 'private, no-store')
    const db = c.env.DB
    if (!db) return c.json({ ok: true, database: 'unconfigured' })
    try {
      await db.prepare('SELECT 1 AS ok').first<{ ok: number }>()
      const tables = await db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(
            (table) => `'${table}'`,
          ).join(', ')})`,
        )
        .all<{ name: string }>()
      return c.json({
        ok: true,
        database: 'ok',
        schema: tables.results.length === REQUIRED_TABLES.length ? 'ready' : 'missing',
      })
    } catch (error) {
      console.error(
        'Teammaker: database health check failed',
        error instanceof Error ? error.message : error,
      )
      return c.json({ ok: false, database: 'unreachable' }, 503)
    }
  })

  app.get('/api/session', async (c) =>
    c.json({
      user: await authenticate(c.req.raw, c.env),
      mode: isLocalPreview(c.req.raw, c.env)
        ? 'local'
        : c.env.FREEBUFF_CLIENT_ID && c.env.APP_ORIGIN
          ? 'freebuff'
          : 'setup',
      database: Boolean(c.env.DB),
    }),
  )

  const guard = groupGuard(authenticate)

  // A token holder may see which group and role a link is for before signing
  // in: the 32-byte token is the credential. Accepting still needs an account.
  app.get('/api/invites/:token', async (c) => {
    if (!c.env.DB)
      return c.json(
        { error: 'This app is still being set up. Please try again later.' },
        503,
      )
    await ensureSchema(c.env.DB)
    const invite = await loadInvite(c.env.DB, c.req.param('token'))
    if (!invite)
      return c.json({ error: 'That invite link is no longer valid.' }, 404)
    // The token is the credential, so the visitor may see enough of the roster
    // to say "that's me" before joining. Emails stay out of this preview.
    const roster = await c.env.DB.prepare(
      'SELECT id, name, username, elo FROM players WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC',
    )
      .bind(invite.groupId)
      .all<{ id: string; name: string; username: string | null; elo: number }>()
    return c.json({
      invite: {
        ...invite,
        players: roster.results.map((row) => ({
          id: row.id,
          name: row.name,
          username: row.username ?? '',
          elo: row.elo,
        })),
      },
    })
  })

  // The group list and accepting an invite are account-level routes; everything
  // inside a group goes through `guard`, which decides read/editor/owner.
  app.use('/api/groups', sessionGuard(authenticate))
  app.use('/api/invites/:token/accept', sessionGuard(authenticate))
  app.use('/api/groups/:groupId', guard)
  app.use('/api/groups/:groupId/*', guard)

  app.get('/api/groups', async (c) => {
    const db = c.get('db')
    const user = c.get('user')
    await ensureGroupForUser(db, { sub: user.sub, name: user.name })
    if (user.name)
      await db
        .prepare(
          'UPDATE group_members SET display_name = ?, updated_at = ? WHERE user_sub = ? AND display_name <> ?',
        )
        .bind(user.name, Date.now(), user.sub, user.name)
        .run()
    return c.json({ groups: await listGroups(db, user.sub) })
  })

  app.post('/api/groups', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const name =
      body && typeof body === 'object' && !Array.isArray(body)
        ? readGroupName((body as Record<string, unknown>).name)
        : null
    if (!name) return c.json({ error: 'Group names are 1 to 40 characters.' }, 400)
    const db = c.get('db')
    const user = c.get('user')
    if ((await countOwnedGroups(db, user.sub)) >= MAX_GROUPS)
      return c.json({ error: `You can own up to ${MAX_GROUPS} groups.` }, 400)
    return c.json(
      { group: await createGroup(db, { sub: user.sub, name: user.name }, name) },
      201,
    )
  })

  app.get('/api/groups/:groupId', async (c) => {
    const detail = await loadGroupDetail(
      c.get('db'),
      c.get('groupId'),
      c.get('user').sub,
    )
    return detail ? c.json({ group: detail }) : c.json({ error: 'Group not found.' }, 404)
  })

  app.patch('/api/groups/:groupId', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const patch = body as Record<string, unknown>
    if (
      Object.keys(patch).some((key) => key !== 'name' && key !== 'kFactor') ||
      Object.keys(patch).length === 0
    )
      return c.json({ error: 'Nothing to update.' }, 400)
    const sets: string[] = []
    const values: unknown[] = []
    if ('name' in patch) {
      const name = readGroupName(patch.name)
      if (!name) return c.json({ error: 'Group names are 1 to 40 characters.' }, 400)
      sets.push('name = ?')
      values.push(name)
    }
    if ('kFactor' in patch) {
      if (!isKFactor(patch.kFactor))
        return c.json({ error: 'K must be a whole number from 8 to 64.' }, 400)
      sets.push('k_factor = ?')
      values.push(patch.kFactor)
    }
    const db = c.get('db')
    const groupId = c.get('groupId')
    sets.push('updated_at = ?', 'rev = rev + 1')
    values.push(Date.now(), groupId)
    await db
      .prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run()
    const detail = await loadGroupDetail(db, groupId, c.get('user').sub)
    return detail ? c.json({ group: detail }) : c.json({ error: 'Group not found.' }, 404)
  })

  app.delete('/api/groups/:groupId', async (c) => {
    const now = Date.now()
    await c
      .get('db')
      .prepare(
        'UPDATE groups SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      )
      .bind(now, now, c.get('groupId'))
      .run()
    return c.json({ ok: true })
  })

  app.get('/api/groups/:groupId/rev', async (c) => {
    const row = await c
      .get('db')
      .prepare('SELECT rev FROM groups WHERE id = ? AND deleted_at IS NULL')
      .bind(c.get('groupId'))
      .first<{ rev: number }>()
    return row ? c.json({ rev: row.rev }) : c.json({ error: 'Group not found.' }, 404)
  })

  // ---- tags ---------------------------------------------------------------

  app.post('/api/groups/:groupId/tags', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'A tag needs a label.' }, 400)
    const record = body as Record<string, unknown>
    if (Object.keys(record).some((key) => key !== 'label' && key !== 'short'))
      return c.json({ error: 'A tag needs a label.' }, 400)
    const label = readTagLabel(record.label)
    const short = readTagShort(record.short)
    if (!label || short === null)
      return c.json({ error: 'Labels are 1 to 24 characters, short forms up to 3.' }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    const tags = await loadTags(db, groupId)
    if (tags.length >= MAX_TAGS)
      return c.json({ error: `A group holds up to ${MAX_TAGS} tags.` }, 400)
    const id = crypto.randomUUID()
    const sort = tags.length
    const now = Date.now()
    await db.batch([
      db
        .prepare(
          'INSERT INTO group_tags (group_id, id, label, short, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(groupId, id, label, short, sort, now, now),
      bumpRev(db, groupId, now),
    ])
    return c.json({ tag: { id, label, short, sort } }, 201)
  })

  app.patch('/api/groups/:groupId/tags/:tagId', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const patch = body as Record<string, unknown>
    if (
      Object.keys(patch).some(
        (key) => key !== 'label' && key !== 'short' && key !== 'sort',
      ) ||
      Object.keys(patch).length === 0
    )
      return c.json({ error: 'Nothing to update.' }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    const tagId = c.req.param('tagId')
    const current = await db
      .prepare('SELECT id FROM group_tags WHERE group_id = ? AND id = ?')
      .bind(groupId, tagId)
      .first<{ id: string }>()
    if (!current) return c.json({ error: 'Tag not found.' }, 404)
    const sets: string[] = []
    const values: unknown[] = []
    if ('label' in patch) {
      const label = readTagLabel(patch.label)
      if (!label) return c.json({ error: 'Labels are 1 to 24 characters.' }, 400)
      sets.push('label = ?')
      values.push(label)
    }
    if ('short' in patch) {
      const short = readTagShort(patch.short)
      if (short === null)
        return c.json({ error: 'Short forms are up to 3 characters.' }, 400)
      sets.push('short = ?')
      values.push(short)
    }
    if ('sort' in patch) {
      if (
        typeof patch.sort !== 'number' ||
        !Number.isInteger(patch.sort) ||
        patch.sort < 0 ||
        patch.sort > MAX_TAGS
      )
        return c.json({ error: 'That order is not valid.' }, 400)
      sets.push('sort = ?')
      values.push(patch.sort)
    }
    sets.push('updated_at = ?')
    values.push(Date.now(), groupId, tagId)
    await db.batch([
      db
        .prepare(
          `UPDATE group_tags SET ${sets.join(', ')} WHERE group_id = ? AND id = ?`,
        )
        .bind(...values),
      bumpRev(db, groupId),
    ])
    return c.json({ ok: true })
  })

  app.delete('/api/groups/:groupId/tags/:tagId', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const tagId = c.req.param('tagId')
    const current = await db
      .prepare('SELECT id FROM group_tags WHERE group_id = ? AND id = ?')
      .bind(groupId, tagId)
      .first<{ id: string }>()
    if (!current) return c.json({ error: 'Tag not found.' }, 404)
    const tags = await loadTags(db, groupId)
    const remaining = tags.filter((tag) => tag.id !== tagId).map((tag) => tag.id)
    const players = await db
      .prepare('SELECT id, tags FROM players WHERE group_id = ?')
      .bind(groupId)
      .all<{ id: string; tags: string }>()
    const statements: Statement[] = []
    for (const player of players.results) {
      let parsed: unknown
      try {
        parsed = JSON.parse(player.tags)
      } catch {
        continue
      }
      if (!Array.isArray(parsed) || !parsed.includes(tagId)) continue
      statements.push(
        db
          .prepare('UPDATE players SET tags = ?, updated_at = ? WHERE id = ? AND group_id = ?')
          .bind(JSON.stringify(normalizeTags(parsed, remaining)), Date.now(), player.id, groupId),
      )
    }
    statements.push(
      db
        .prepare('DELETE FROM group_tags WHERE group_id = ? AND id = ?')
        .bind(groupId, tagId),
      bumpRev(db, groupId),
    )
    await db.batch(statements)
    return c.json({ ok: true, tags: remaining })
  })

  // ---- sharing ------------------------------------------------------------

  app.post('/api/groups/:groupId/invites', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const role =
      body && typeof body === 'object' && !Array.isArray(body)
        ? readRole((body as Record<string, unknown>).role)
        : null
    if (!role)
      return c.json({ error: 'Pick editor or viewer for the invite.' }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    const token = newInviteToken()
    const id = crypto.randomUUID()
    const now = Date.now()
    await db
      .prepare(
        'INSERT INTO group_invites (id, group_id, role, token_hash, created_by_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(id, groupId, role, await hashInviteToken(token), c.get('user').sub, now)
      .run()
    const origin = appOrigin(c.req.raw, c.env) ?? new URL(c.req.url).origin
    return c.json(
      { invite: { id, role, createdAt: now, url: `${origin}/join/${token}` } },
      201,
    )
  })

  app.get('/api/groups/:groupId/invites', async (c) => {
    const rows = await c
      .get('db')
      .prepare(
        'SELECT id, role, created_at FROM group_invites WHERE group_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      )
      .bind(c.get('groupId'))
      .all<{ id: string; role: string; created_at: number }>()
    return c.json({
      invites: rows.results.map((row) => ({
        id: row.id,
        role: row.role === 'editor' ? 'editor' : 'viewer',
        createdAt: row.created_at,
      })),
    })
  })

  app.delete('/api/groups/:groupId/invites/:inviteId', async (c) => {
    const row = await c
      .get('db')
      .prepare(
        'UPDATE group_invites SET revoked_at = ? WHERE id = ? AND group_id = ? AND revoked_at IS NULL RETURNING id',
      )
      .bind(Date.now(), c.req.param('inviteId'), c.get('groupId'))
      .first()
    return row ? c.json({ ok: true }) : c.json({ error: 'Invite not found.' }, 404)
  })

  app.get('/api/groups/:groupId/members', async (c) => {
    const detail = await loadGroupDetail(
      c.get('db'),
      c.get('groupId'),
      c.get('user').sub,
    )
    return detail ? c.json({ members: detail.members }) : c.json({ error: 'Group not found.' }, 404)
  })

  app.patch('/api/groups/:groupId/members/:userId', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const role =
      body && typeof body === 'object' && !Array.isArray(body)
        ? readRole((body as Record<string, unknown>).role)
        : null
    if (!role) return c.json({ error: 'Pick editor or viewer.' }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    const userId = c.req.param('userId')
    const owner = await db
      .prepare('SELECT owner_sub FROM groups WHERE id = ?')
      .bind(groupId)
      .first<{ owner_sub: string }>()
    if (owner?.owner_sub === userId)
      return c.json({ error: 'The owner keeps their role.' }, 400)
    const changed = await db
      .prepare(
        'UPDATE group_members SET role = ?, updated_at = ? WHERE group_id = ? AND user_sub = ? RETURNING user_sub',
      )
      .bind(role, Date.now(), groupId, userId)
      .first()
    if (!changed) return c.json({ error: 'Member not found.' }, 404)
    await bumpRev(db, groupId).run()
    return c.json({ ok: true })
  })

  app.delete('/api/groups/:groupId/members/:userId', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const userId = c.req.param('userId')
    const owner = await db
      .prepare('SELECT owner_sub FROM groups WHERE id = ?')
      .bind(groupId)
      .first<{ owner_sub: string }>()
    if (owner?.owner_sub === userId)
      return c.json({ error: 'The owner cannot be removed.' }, 400)
    const removed = await db
      .prepare(
        'DELETE FROM group_members WHERE group_id = ? AND user_sub = ? RETURNING user_sub',
      )
      .bind(groupId, userId)
      .first()
    if (!removed) return c.json({ error: 'Member not found.' }, 404)
    await bumpRev(db, groupId).run()
    return c.json({ ok: true })
  })

  app.post('/api/invites/:token/accept', async (c) => {
    const db = c.get('db')
    const user = c.get('user')
    const invite = await loadInvite(db, c.req.param('token'))
    if (!invite) return c.json({ error: 'That invite link is no longer valid.' }, 404)

    // An optional claim rides along with the join: membership is granted at
    // once, and only the player connection waits for an editor.
    const body: unknown = await c.req.json().catch(() => null)
    let draft: ClaimDraft | null = null
    if (body !== null) {
      if (typeof body !== 'object' || Array.isArray(body))
        return c.json({ error: 'Choose a player to connect.' }, 400)
      const record = body as Record<string, unknown>
      if (record.claim !== undefined) {
        const parsed = readClaimDraft(record, user)
        if (!parsed.draft) return c.json({ error: parsed.error }, 400)
        draft = parsed.draft
      } else if ('note' in record || 'email' in record) {
        return c.json({ error: 'Choose a player to connect.' }, 400)
      }
    }

    const now = Date.now()
    const statements: Statement[] = []
    const owner = await db
      .prepare('SELECT owner_sub FROM groups WHERE id = ?')
      .bind(invite.groupId)
      .first<{ owner_sub: string }>()
    if (owner?.owner_sub !== user.sub) {
      const members = await db
        .prepare('SELECT COUNT(*) AS total FROM group_members WHERE group_id = ?')
        .bind(invite.groupId)
        .first<{ total: number }>()
      if ((members?.total ?? 0) + 1 > MAX_MEMBERS)
        return c.json({ error: 'That group is full.' }, 400)
      statements.push(
        db
          .prepare(
            `INSERT INTO group_members (group_id, user_sub, role, display_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(group_id, user_sub) DO NOTHING`,
          )
          .bind(invite.groupId, user.sub, invite.role, user.name ?? '', now, now),
      )
    }
    let requestId: string | null = null
    if (draft) {
      const filed = await filePlayerRequest(db, invite.groupId, user, draft, now)
      if (!filed.ok) return c.json({ error: filed.error }, filed.status)
      requestId = filed.id
      statements.push(filed.statement)
    }
    statements.push(bumpRev(db, invite.groupId, now))
    await db.batch(statements)
    return c.json({
      group: { id: invite.groupId, name: invite.name, role: invite.role },
      request: requestId ? { id: requestId } : null,
    })
  })

  // ---- player connections -------------------------------------------------

  /** Editors review every pending claim; a member sees only their own. */
  app.get('/api/groups/:groupId/player-requests', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const user = c.get('user')
    const editor = c.get('role') !== 'viewer'
    const rows = await db
      .prepare(
        `SELECT r.id, r.requester_sub, r.requester_name, r.email, r.kind,
                r.player_id, r.name, r.username, r.note, r.created_at,
                p.name AS player_name
         FROM group_player_requests r
         LEFT JOIN players p ON p.id = r.player_id AND p.group_id = r.group_id
         WHERE r.group_id = ? AND r.status = 'pending'${
           editor ? '' : ' AND r.requester_sub = ?'
         }
         ORDER BY r.created_at ASC, r.id ASC`,
      )
      .bind(...(editor ? [groupId] : [groupId, user.sub]))
      .all<RequestRow>()
    return c.json({ requests: rows.results.map((row) => mapRequest(row, user.sub)) })
  })

  /** Any member, viewers included, may ask to be connected to a player. */
  app.post('/api/groups/:groupId/player-requests', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Choose a player to connect.' }, 400)
    const parsed = readClaimDraft(body as Record<string, unknown>, c.get('user'))
    if (!parsed.draft) return c.json({ error: parsed.error }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    const now = Date.now()
    const filed = await filePlayerRequest(db, groupId, c.get('user'), parsed.draft, now)
    if (!filed.ok) return c.json({ error: filed.error }, filed.status)
    await db.batch([filed.statement, bumpRev(db, groupId, now)])
    return c.json({ request: { id: filed.id } }, 201)
  })

  app.post('/api/groups/:groupId/player-requests/:requestId/approve', async (c) => {
    if (c.get('role') === 'viewer')
      return c.json({ error: 'Only an editor can review player requests.' }, 403)
    const db = c.get('db')
    const groupId = c.get('groupId')
    const id = c.req.param('requestId')
    const row = await db
      .prepare(
        "SELECT id, requester_sub, requester_name, email, kind, player_id, name, username, note, created_at FROM group_player_requests WHERE id = ? AND group_id = ? AND status = 'pending'",
      )
      .bind(id, groupId)
      .first<RequestRow>()
    if (!row) return c.json({ error: 'Request not found.' }, 404)
    const now = Date.now()
    // Claim the row first, so two editors cannot both apply it.
    const claimed = await db
      .prepare(
        `UPDATE group_player_requests SET status = 'approved', decided_by_sub = ?, decided_at = ?, updated_at = ?
         WHERE id = ? AND group_id = ? AND status = 'pending' RETURNING id`,
      )
      .bind(c.get('user').sub, now, now, id, groupId)
      .first<{ id: string }>()
    if (!claimed)
      return c.json({ error: 'That request was already handled.' }, 409)
    const applied = await applyPlayerRequest(db, groupId, row, now)
    if (!applied.ok) {
      // Nothing was written: hand the request back so it stays reviewable.
      await db
        .prepare(
          "UPDATE group_player_requests SET status = 'pending', decided_by_sub = NULL, decided_at = NULL, updated_at = ? WHERE id = ? AND group_id = ?",
        )
        .bind(Date.now(), id, groupId)
        .run()
      return c.json({ error: applied.error }, applied.status)
    }
    await db.batch([...applied.statements, bumpRev(db, groupId, now)])
    return c.json({ ok: true, playerId: applied.playerId })
  })

  /** An editor dismisses any pending request; a member may cancel their own. */
  app.delete('/api/groups/:groupId/player-requests/:requestId', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const id = c.req.param('requestId')
    const row = await db
      .prepare(
        'SELECT requester_sub FROM group_player_requests WHERE id = ? AND group_id = ?',
      )
      .bind(id, groupId)
      .first<{ requester_sub: string }>()
    if (!row) return c.json({ error: 'Request not found.' }, 404)
    if (c.get('role') === 'viewer' && row.requester_sub !== c.get('user').sub)
      return c.json({ error: 'Only an editor can review player requests.' }, 403)
    await db.batch([
      db
        .prepare('DELETE FROM group_player_requests WHERE id = ? AND group_id = ?')
        .bind(id, groupId),
      bumpRev(db, groupId),
    ])
    return c.json({ ok: true })
  })

  // ---- players ------------------------------------------------------------

  app.post('/api/groups/:groupId/players/:playerId/emails', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const playerId = c.req.param('playerId')
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Enter an email address.' }, 400)
    const record = body as Record<string, unknown>
    if (Object.keys(record).some((key) => key !== 'email'))
      return c.json({ error: 'Enter an email address.' }, 400)
    const email = readEmail(record.email)
    if (!email)
      return c.json({ error: 'That does not look like an email address.' }, 400)
    const player = await db
      .prepare(
        'SELECT id FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL',
      )
      .bind(playerId, groupId)
      .first<{ id: string }>()
    if (!player) return c.json({ error: 'Player not found.' }, 404)
    const emails = await loadPlayerEmailList(db, groupId, playerId)
    if (emails.includes(email)) return c.json({ ok: true, emails })
    if (emails.length >= MAX_EMAILS_PER_PLAYER)
      return c.json(
        { error: `A player holds up to ${MAX_EMAILS_PER_PLAYER} emails.` },
        400,
      )
    const now = Date.now()
    await db.batch([
      linkEmailStatement(db, groupId, playerId, email, c.get('user').sub, now),
      bumpRev(db, groupId, now),
    ])
    return c.json(
      { ok: true, emails: await loadPlayerEmailList(db, groupId, playerId) },
      201,
    )
  })

  app.delete('/api/groups/:groupId/players/:playerId/emails/:email', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const playerId = c.req.param('playerId')
    const email = readEmail(c.req.param('email'))
    if (!email) return c.json({ error: 'That email is not connected.' }, 404)
    const player = await db
      .prepare(
        'SELECT id FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL',
      )
      .bind(playerId, groupId)
      .first<{ id: string }>()
    if (!player) return c.json({ error: 'Player not found.' }, 404)
    const removed = await db
      .prepare(
        'DELETE FROM group_player_emails WHERE group_id = ? AND player_id = ? AND email = ? RETURNING email',
      )
      .bind(groupId, playerId, email)
      .first<{ email: string }>()
    if (!removed) return c.json({ error: 'That email is not connected.' }, 404)
    await bumpRev(db, groupId).run()
    return c.json({
      ok: true,
      emails: await loadPlayerEmailList(db, groupId, playerId),
    })
  })

  app.get('/api/groups/:groupId/players', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const tags = (await loadTags(db, groupId)).map((tag) => tag.id)
    return c.json({ players: await loadPlayers(db, groupId, tags) })
  })

  app.post('/api/groups/:groupId/players', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const allowed = (await loadTags(db, groupId)).map((tag) => tag.id)
    const body: unknown = await c.req.json().catch(() => null)
    const drafts = readDrafts(body, allowed)
    if (!drafts)
      return c.json(
        { error: 'Each player needs a name, a skill from 1 to 10 and known tags.' },
        400,
      )
    const existing = await db
      .prepare(
        'SELECT COUNT(*) AS total FROM players WHERE group_id = ? AND deleted_at IS NULL',
      )
      .bind(groupId)
      .first<{ total: number }>()
    if ((existing?.total ?? 0) + drafts.length > ROSTER_LIMIT)
      return c.json({ error: 'A roster holds up to 200 players.' }, 400)
    const createdAt = Date.now()
    const players: Player[] = drafts.map((draft, index) => ({
      id: crypto.randomUUID(),
      name: draft.name,
      username: draft.username,
      skill: draft.skill,
      elo: clampElo(draft.skill * 100),
      tags: draft.tags,
      createdAt: createdAt + index,
      updatedAt: createdAt + index,
    }))
    await db.batch([
      ...players.map((player) =>
        db
          .prepare(
            'INSERT INTO players (id, owner_sub, group_id, name, username, skill, elo, base_elo, tags, sitting_out, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
          )
          .bind(
            player.id,
            c.get('user').sub,
            groupId,
            player.name,
            player.username ?? '',
            player.skill,
            player.elo,
            player.elo,
            JSON.stringify(player.tags),
            player.createdAt,
            player.updatedAt,
          ),
      ),
      bumpRev(db, groupId),
    ])
    return c.json({ players }, 201)
  })

  app.patch('/api/groups/:groupId/players/:playerId', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const patch = body as Record<string, unknown>
    if (
      Object.keys(patch).some(
        (key) => !['name', 'username', 'skill', 'elo', 'tags'].includes(key),
      )
    )
      return c.json(
        {
          error:
            'Nothing to update. Sitting out is saved on each device, not in the group.',
        },
        400,
      )
    const db = c.get('db')
    const groupId = c.get('groupId')
    const id = c.req.param('playerId')
    const current = await db
      .prepare(
        'SELECT id, elo FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL',
      )
      .bind(id, groupId)
      .first<{ id: string; elo: number }>()
    if (!current) return c.json({ error: 'Player not found.' }, 404)
    const allowed = (await loadTags(db, groupId)).map((tag) => tag.id)

    const sets: string[] = []
    const values: unknown[] = []
    let targetElo: number | null = null
    let reason = 'Manual rating'
    if ('name' in patch) {
      const name = readName(patch.name)
      if (!name) return c.json({ error: 'Names are 1 to 40 characters.' }, 400)
      sets.push('name = ?')
      values.push(name)
    }
    if ('username' in patch) {
      const username = readUsername(patch.username)
      if (username === null)
        return c.json({ error: 'Usernames are up to 32 characters.' }, 400)
      sets.push('username = ?')
      values.push(username)
    }
    if ('skill' in patch && 'elo' in patch)
      return c.json({ error: 'Set either the 1-10 rating or elo, not both.' }, 400)
    if ('skill' in patch) {
      const skill = readSkill(patch.skill)
      if (skill === null)
        return c.json({ error: 'Skills are whole numbers from 1 to 10.' }, 400)
      targetElo = skill * 100
      reason = '1-10 rating'
    }
    if ('elo' in patch) {
      const elo = readElo(patch.elo)
      if (elo === null)
        return c.json({ error: 'Elo is a whole number from 100 to 1000.' }, 400)
      targetElo = elo
      reason = 'Advanced elo edit'
    }
    let logAdjustment = false
    if (targetElo !== null) {
      sets.push('elo = ?', 'skill = ?')
      values.push(targetElo, skillFromElo(targetElo))
      const history = await db
        .prepare(
          'SELECT COUNT(*) AS total FROM rating_results WHERE group_id = ? AND player_id = ?',
        )
        .bind(groupId, id)
        .first<{ total: number }>()
      logAdjustment = (history?.total ?? 0) > 0
      if (!logAdjustment) {
        sets.push('base_elo = ?')
        values.push(targetElo)
      }
    }
    if ('tags' in patch) {
      const tags = readTags(patch.tags, allowed)
      if (!tags) return c.json({ error: 'Those tags are not in this group.' }, 400)
      sets.push('tags = ?')
      values.push(JSON.stringify(tags))
    }
    if (sets.length === 0) return c.json({ error: 'Nothing to update.' }, 400)
    sets.push('updated_at = ?')
    values.push(Date.now(), id, groupId)
    await db.batch([
      db
        .prepare(`UPDATE players SET ${sets.join(', ')} WHERE id = ? AND group_id = ?`)
        .bind(...values),
      bumpRev(db, groupId),
    ])

    if (targetElo !== null && logAdjustment && targetElo !== current.elo) {
      await makeRoom(db, groupId)
      const position = await nextPosition(db, groupId)
      const now = Date.now()
      await db
        .prepare(
          'INSERT INTO rating_events (id, owner_sub, group_id, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          crypto.randomUUID(),
          c.get('user').sub,
          groupId,
          position,
          'adjust',
          JSON.stringify({ playerId: id, elo: targetElo, reason }),
          now,
          now,
        )
        .run()
      const players = await recompute(db, groupId, position)
      return c.json({ player: players.find((entry) => entry.id === id) ?? null })
    }

    const row = await db
      .prepare(
        'SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL',
      )
      .bind(id, groupId)
      .first<PlayerRow>()
    if (!row) return c.json({ error: 'Player not found.' }, 404)
    return c.json({
      player: mapPlayer(row, allowed, await loadPlayerEmailList(db, groupId, id)),
    })
  })

  app.delete('/api/groups/:groupId/players/:playerId', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const id = c.req.param('playerId')
    const player = await db
      .prepare(
        'SELECT id FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL',
      )
      .bind(id, groupId)
      .first<{ id: string }>()
    if (!player) return c.json({ error: 'Player not found.' }, 404)
    // Archive, do not erase: the row keeps its creation elo, so every replay
    // seeds this player exactly as before and nobody else's rating moves.
    const now = Date.now()
    await db.batch([
      db
        .prepare(
          'UPDATE players SET deleted_at = ?, updated_at = ? WHERE id = ? AND group_id = ?',
        )
        .bind(now, now, id, groupId),
      // An archived player has no one left to sign in as them.
      db
        .prepare('DELETE FROM group_player_emails WHERE group_id = ? AND player_id = ?')
        .bind(groupId, id),
      bumpRev(db, groupId, now),
    ])
    return c.json({ ok: true })
  })

  app.post('/api/groups/:groupId/players/:playerId/elo', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const record = body as Record<string, unknown>
    if (Object.keys(record).some((key) => key !== 'elo' && key !== 'reason'))
      return c.json({ error: 'Nothing to update.' }, 400)
    const elo = readElo(record.elo)
    if (elo === null)
      return c.json({ error: 'Elo is a whole number from 100 to 1000.' }, 400)
    if (
      record.reason !== undefined &&
      (typeof record.reason !== 'string' || record.reason.trim().length > MAX_REASON)
    )
      return c.json({ error: 'That reason is too long.' }, 400)
    const reason =
      typeof record.reason === 'string' && record.reason.trim()
        ? record.reason.trim()
        : 'Manual elo edit'
    const db = c.get('db')
    const groupId = c.get('groupId')
    const id = c.req.param('playerId')
    const player = await db
      .prepare(
        'SELECT id, elo FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL',
      )
      .bind(id, groupId)
      .first<{ id: string; elo: number }>()
    if (!player) return c.json({ error: 'Player not found.' }, 404)

    await makeRoom(db, groupId)
    const position = await nextPosition(db, groupId)
    const now = Date.now()
    await db
      .prepare(
        'INSERT INTO rating_events (id, owner_sub, group_id, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        crypto.randomUUID(),
        c.get('user').sub,
        groupId,
        position,
        'adjust',
        JSON.stringify({ playerId: id, elo, reason }),
        now,
        now,
      )
      .run()
    const players = await recompute(db, groupId, position)
    await bumpRev(db, groupId).run()
    return c.json({
      player: players.find((entry) => entry.id === id) ?? null,
      players,
    })
  })

  // ---- matches ------------------------------------------------------------

  app.get('/api/groups/:groupId/matches', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const squash = await db
      .prepare('SELECT removed, squashed_at FROM group_squashes WHERE group_id = ?')
      .bind(groupId)
      .first<{ removed: number; squashed_at: number }>()
    return c.json({
      kFactor: await getKFactor(db, groupId),
      squashed: squash
        ? { removed: squash.removed, at: squash.squashed_at }
        : null,
      events: await matchViews(db, groupId),
    })
  })

  app.post('/api/groups/:groupId/matches', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const input = readMatchInput(body)
    if (!input) return c.json({ error: MATCH_ERROR }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    const tracked = input.teams.flatMap((team) =>
      team.players.filter((player) => player.tracked).map((player) => player.id),
    )
    if (!(await trackedIdsExist(db, groupId, tracked)))
      return c.json({ error: "Those players are no longer on this group's roster." }, 400)
    if (!(await makeRoom(db, groupId)))
      return c.json(
        { error: `The log holds ${MAX_EVENTS} events. Delete one to add another.` },
        400,
      )
    const position = await nextPosition(db, groupId)
    const id = crypto.randomUUID()
    const now = Date.now()
    const kFactor = await getKFactor(db, groupId)
    await pinLegacyK(db, groupId, kFactor)
    const payload: MatchInput = {
      ...input,
      formula: FLAT_K_FORMULA,
      k: kFactor,
    }
    await db
      .prepare(
        'INSERT INTO rating_events (id, owner_sub, group_id, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id,
        c.get('user').sub,
        groupId,
        position,
        'match',
        JSON.stringify(payload),
        now,
        now,
      )
      .run()
    const players = await recompute(db, groupId, position)
    await bumpRev(db, groupId).run()
    return c.json({ match: { id, position }, players }, 201)
  })

  app.patch('/api/groups/:groupId/matches/:matchId', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const id = c.req.param('matchId')
    const row = await findEvent(db, groupId, id)
    if (!row || row.kind !== 'match')
      return c.json({ error: 'Match not found.' }, 404)
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const patch = body as Record<string, unknown>
    if (
      Object.keys(patch).some((key) => key !== 'input' && key !== 'position') ||
      Object.keys(patch).length === 0
    )
      return c.json({ error: 'Nothing to update.' }, 400)
    if (
      'position' in patch &&
      (typeof patch.position !== 'number' || !Number.isInteger(patch.position))
    )
      return c.json({ error: 'That position is not valid.' }, 400)

    let from = row.position
    if ('input' in patch) {
      const input = readMatchInput(patch.input)
      if (!input) return c.json({ error: MATCH_ERROR }, 400)
      const tracked = input.teams.flatMap((team) =>
        team.players.filter((player) => player.tracked).map((player) => player.id),
      )
      if (!(await trackedIdsExist(db, groupId, tracked, true)))
        return c.json({ error: "Those players are no longer on this group's roster." }, 400)
      let marker: { formula?: 2 | 3 | 4; k?: number } = {}
      try {
        const existing = JSON.parse(row.payload) as MatchInput
        const version = eventFormula(existing)
        if (version !== 1) {
          marker = { formula: version }
          if (isKFactor(existing.k)) marker.k = existing.k
        }
      } catch {
        // A malformed legacy payload is left unmarked, as it was.
      }
      const nextInput: MatchInput = { ...input, ...marker }
      await db
        .prepare(
          'UPDATE rating_events SET payload = ?, updated_at = ? WHERE id = ? AND group_id = ?',
        )
        .bind(JSON.stringify(nextInput), Date.now(), id, groupId)
        .run()
    }

    if ('position' in patch) {
      const all = await db
        .prepare(
          'SELECT id FROM rating_events WHERE group_id = ? ORDER BY position ASC, created_at ASC, id ASC',
        )
        .bind(groupId)
        .all<{ id: string }>()
      const ids = all.results.map((entry) => entry.id)
      const current = ids.indexOf(id)
      const target = Math.max(
        0,
        Math.min(ids.length - 1, Math.trunc(patch.position as number)),
      )
      if (current !== -1 && target !== current) {
        ids.splice(current, 1)
        ids.splice(target, 0, id)
        from = Math.min(from, current, target)
        await db.batch(
          ids.map((eventId, index) =>
            db
              .prepare(
                'UPDATE rating_events SET position = ? WHERE id = ? AND group_id = ?',
              )
              .bind(index, eventId, groupId),
          ),
        )
      }
    }

    const players = await recompute(db, groupId, from)
    await bumpRev(db, groupId).run()
    return c.json({ ok: true, players })
  })

  app.delete('/api/groups/:groupId/matches/:matchId', async (c) => {
    const db = c.get('db')
    const groupId = c.get('groupId')
    const id = c.req.param('matchId')
    const row = await findEvent(db, groupId, id)
    if (!row) return c.json({ error: 'Match not found.' }, 404)
    await db.batch([
      db
        .prepare('DELETE FROM rating_results WHERE event_id = ? AND group_id = ?')
        .bind(id, groupId),
      db
        .prepare('DELETE FROM rating_events WHERE id = ? AND group_id = ?')
        .bind(id, groupId),
    ])
    const players = await recompute(db, groupId, row.position)
    await bumpRev(db, groupId).run()
    return c.json({ ok: true, players })
  })

  // ---- settings -----------------------------------------------------------

  app.get('/api/groups/:groupId/settings', async (c) =>
    c.json({ kFactor: await getKFactor(c.get('db'), c.get('groupId')) }),
  )

  app.put('/api/groups/:groupId/settings', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const kFactor = (body as Record<string, unknown>).kFactor
    if (!isKFactor(kFactor))
      return c.json({ error: 'K must be a whole number from 8 to 64.' }, 400)
    const db = c.get('db')
    const groupId = c.get('groupId')
    await pinLegacyK(db, groupId, await getKFactor(db, groupId))
    await db.batch([
      db
        .prepare('UPDATE groups SET k_factor = ?, updated_at = ? WHERE id = ?')
        .bind(kFactor, Date.now(), groupId),
      bumpRev(db, groupId),
    ])
    const tags = (await loadTags(db, groupId)).map((tag) => tag.id)
    return c.json({
      kFactor,
      players: await loadPlayers(db, groupId, tags),
    })
  })

  // ---- legacy saved rounds ------------------------------------------------

  /**
   * Saved rounds are per-device now. This read-only route exists so the owner
   * can import the snapshots that used to live in the account; nothing writes
   * rounds on the server any more.
   */
  app.get('/api/groups/:groupId/rounds', async (c) => {
    const result = await c
      .get('db')
      .prepare(
        'SELECT id, config, created_at FROM rounds WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT 60',
      )
      .bind(c.get('groupId'))
      .all<RoundRow>()
    return c.json({
      rounds: result.results
        .map((row) => mapRound(row))
        .filter((round): round is NonNullable<typeof round> => round !== null),
    })
  })

  app.notFound((c) =>
    c.req.path === '/api' || c.req.path.startsWith('/api/')
      ? c.json({ error: 'Endpoint not found.' }, 404)
      : c.env.ASSETS
        ? c.env.ASSETS.fetch(c.req.raw)
        : c.text('Not found', 404),
  )
  app.onError((_error, c) =>
    c.json({ error: 'Something went wrong. Please try again.' }, 500),
  )
  return app
}

type InviteRow = { group_id: string; role: string; name: string }

/** Looks up a live invite by the hash of its token. */
async function loadInvite(
  db: Database,
  token: string,
): Promise<{ groupId: string; name: string; role: 'editor' | 'viewer' } | null> {
  if (!token || token.length > 128) return null
  const row = await db
    .prepare(
      `SELECT i.group_id, i.role, g.name FROM group_invites i
       JOIN groups g ON g.id = i.group_id
       WHERE i.token_hash = ? AND i.revoked_at IS NULL AND g.deleted_at IS NULL
         AND (i.expires_at IS NULL OR i.expires_at > ?)`,
    )
    .bind(await hashInviteToken(token), Date.now())
    .first<InviteRow>()
  if (!row) return null
  return {
    groupId: row.group_id,
    name: row.name,
    role: row.role === 'editor' ? 'editor' : 'viewer',
  }
}

export type { MemberRow, GroupRole }
