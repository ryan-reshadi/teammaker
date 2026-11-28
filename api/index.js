// server/vercel.ts
import { getRequestListener } from "@hono/node-server";

// src/server/libsql.ts
var toRecord = (values, columns) => {
  const record = {};
  columns.forEach((column, index) => {
    record[column] = values[index];
  });
  return record;
};

class LibsqlStatement {
  executor;
  sql;
  args;
  constructor(executor, sql, args = []) {
    this.executor = executor;
    this.sql = sql;
    this.args = args;
  }
  bind(...values) {
    return new LibsqlStatement(this.executor, this.sql, values);
  }
  async all() {
    const [values, columns] = await this.executor.execute({
      sql: this.sql,
      args: this.args
    });
    const results = values.map((row) => toRecord(row, columns));
    return { results };
  }
  async first() {
    const { results } = await this.all();
    return results[0] ?? null;
  }
  async run() {
    await this.executor.execute({ sql: this.sql, args: this.args });
    return { ok: true };
  }
}

class LibsqlDatabase {
  executor;
  constructor(executor) {
    this.executor = executor;
  }
  prepare(sql) {
    return new LibsqlStatement(this.executor, sql);
  }
  async batch(statements) {
    await this.executor.batch(statements.map((statement) => {
      const { sql, args } = statement;
      return { sql, args };
    }));
    return { ok: true };
  }
}
function databaseFromExecutor(executor) {
  return new LibsqlDatabase(executor);
}
function createLibsqlDatabase(url, authToken) {
  let clientPromise = null;
  const client = async () => {
    clientPromise ??= (url.startsWith("file:") ? import("@libsql/client") : import("@libsql/client/web")).then((module) => module.createClient({ url, authToken }));
    return clientPromise;
  };
  return databaseFromExecutor({
    async execute({ sql, args }) {
      const result = await (await client()).execute({ sql, args });
      const columns = result.columns;
      const values = result.rows.map((row) => columns.map((column) => row[column]));
      return [values, columns];
    },
    async batch(statements) {
      await (await client()).batch(statements.map(({ sql, args }) => ({ sql, args })), "write");
    }
  });
}

// src/worker/app.ts
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

// src/shared/elo.ts
var ELO_MIN = 100;
var ELO_MAX = 1000;
var ELO_PER_SKILL = 100;
var DEFAULT_K_FACTOR = 32;
var MIN_K_FACTOR = 8;
var MAX_K_FACTOR = 64;
var RATING_FORMULA = 2;
var PLACEMENT_FORMULA = 3;
var FLAT_K_FORMULA = 4;
var PROVISIONAL_MATCHES = 5;
var PROVISIONAL_K_MULTIPLIER = 2;
var MAX_EVENTS = 1000;
var MAX_MATCH_PLAYERS = 10;
var MAX_MATCH_TEAMS = 8;
var MAX_DAMAGE = 1e5;
var PERFORMANCE_WEIGHT = 0.6;
var PERFORMANCE_TAU = 0.7;
var RANDOM_WEIGHT = 0.5;
var RANDOM_SWING = 200;
var clampElo = (value) => {
  if (!Number.isFinite(value))
    return ELO_MIN;
  return Math.min(ELO_MAX, Math.max(ELO_MIN, Math.round(value)));
};
var skillFromElo = (elo) => Math.min(10, Math.max(1, Math.round(clampElo(elo) / ELO_PER_SKILL)));
var isKFactor = (value) => typeof value === "number" && Number.isInteger(value) && value >= MIN_K_FACTOR && value <= MAX_K_FACTOR;
function provisionalK(baseK, matchesPlayed) {
  const k = isKFactor(baseK) ? baseK : DEFAULT_K_FACTOR;
  return matchesPlayed < PROVISIONAL_MATCHES ? Math.min(MAX_K_FACTOR, k * PROVISIONAL_K_MULTIPLIER) : k;
}
function expectationsFromStrengths(strengths) {
  if (strengths.length === 0)
    return [];
  if (strengths.length === 1)
    return [1];
  const versus = strengths.map((value, index) => strengths.map((other, otherIndex) => otherIndex === index ? 0 : 1 / (1 + 10 ** ((other - value) / 400))));
  const totals = versus.map((row) => row.reduce((sum, value) => sum + value, 0));
  const total = totals.reduce((sum, value) => sum + value, 0);
  if (!(total > 0))
    return strengths.map(() => 1 / strengths.length);
  return totals.map((value) => value / total);
}
function median(values) {
  if (values.length === 0)
    return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
function placementScores(places) {
  const pairs = places.length * (places.length - 1) / 2;
  if (pairs === 0)
    return places.map(() => 0);
  return places.map((place, index) => {
    const taken = places.reduce((sum, other, otherIndex) => {
      if (otherIndex === index)
        return sum;
      if (place === other)
        return sum + 0.5;
      return sum + (place < other ? 1 : 0);
    }, 0);
    return taken / pairs;
  });
}
function isPlacement(places, teams) {
  return Array.isArray(places) && places.length === teams && places.every((place) => typeof place === "number" && Number.isInteger(place) && place >= 1 && place <= teams);
}
function eventFormula(payload) {
  if (payload.formula === FLAT_K_FORMULA)
    return FLAT_K_FORMULA;
  if (payload.formula === PLACEMENT_FORMULA)
    return PLACEMENT_FORMULA;
  return payload.formula === RATING_FORMULA ? RATING_FORMULA : 1;
}
var usesProvisionalK = (formula) => formula !== 1 && formula !== FLAT_K_FORMULA;
function knownAverage(teams, ratings) {
  let total = 0;
  let count = 0;
  for (const team of teams) {
    for (const player of team.players) {
      if (!player.tracked)
        continue;
      const elo = ratings.get(player.id);
      if (elo === undefined)
        continue;
      total += elo;
      count++;
    }
  }
  return count > 0 ? total / count : (ELO_MIN + ELO_MAX) / 2;
}
function estimateRandomElo(averageKnown, damagePerEnemy, trackedDamagePerEnemy) {
  if (damagePerEnemy <= 0)
    return clampElo(averageKnown - RANDOM_SWING);
  const factor = trackedDamagePerEnemy > 0 ? damagePerEnemy / trackedDamagePerEnemy : 1;
  const shift = RANDOM_SWING * Math.tanh(Math.log(Math.max(factor, 0.000001)) / PERFORMANCE_TAU);
  return clampElo(averageKnown + shift);
}
function rateMatch(input, ratings, kFactor, options = {}) {
  const teams = input.teams;
  const updates = new Map;
  const formula = options.formula ?? 1;
  const priorMatches = options.priorMatches;
  if (teams.length < 2 || teams.length > MAX_MATCH_TEAMS || teams.some((team) => team.players.length === 0) || !Number.isInteger(input.winner) || input.winner < 0 || input.winner >= teams.length)
    return { result: { teams: [], winner: input.winner, expected: [] }, updates };
  const sizes = teams.map((team) => team.players.length);
  const enemiesFaced = sizes.map((_size, index) => sizes.reduce((sum, size, other) => other === index ? sum : sum + size, 0));
  const averageKnown = knownAverage(teams, ratings);
  const damagePerEnemy = teams.map((team, index) => team.players.map((player) => player.damage / Math.max(1, enemiesFaced[index])));
  const trackedDamage = teams.flatMap((team, index) => team.players.map((player, slot) => player.tracked ? damagePerEnemy[index][slot] : null).filter((value) => value !== null));
  const trackedAverage = trackedDamage.length > 0 ? trackedDamage.reduce((sum, value) => sum + value, 0) / trackedDamage.length : 1;
  const weights = teams.map((team) => team.players.map((player) => player.tracked ? 1 : RANDOM_WEIGHT));
  const elos = teams.map((team, index) => team.players.map((player, slot) => {
    if (!player.tracked) {
      return estimateRandomElo(averageKnown, damagePerEnemy[index][slot], trackedAverage);
    }
    const rating = ratings.get(player.id);
    return rating === undefined ? clampElo(averageKnown) : clampElo(rating);
  }));
  const strength = teams.map((team, index) => team.players.reduce((sum, _player, slot) => sum + weights[index][slot] * elos[index][slot], 0));
  const expected = expectationsFromStrengths(strength);
  const placed = formula === PLACEMENT_FORMULA && isPlacement(input.places, teams.length) ? placementScores(input.places) : null;
  const pool = teams.reduce((sum, team, index) => sum + team.players.reduce((teamSum, _player, slot) => teamSum + weights[index][slot] * damagePerEnemy[index][slot], 0), 0);
  const weightTotal = weights.flat().reduce((sum, weight) => sum + weight, 0);
  const ratingTotal = teams.reduce((sum, team, index) => sum + team.players.reduce((teamSum, _player, slot) => teamSum + weights[index][slot] * elos[index][slot], 0), 0);
  const lobbyMedian = median(damagePerEnemy.flat());
  const result = { teams: [], winner: input.winner, expected };
  teams.forEach((team, index) => {
    result.teams.push({
      players: team.players.map((player, slot) => {
        const weight = weights[index][slot];
        const before = elos[index][slot];
        const rate = damagePerEnemy[index][slot];
        const actualShare = pool > 0 ? weight * rate / pool : 0;
        const equalShare = weightTotal > 0 ? weight / weightTotal : 0;
        const ratingShare = ratingTotal > 0 ? weight * before / ratingTotal : 0;
        const expectedShare = 0.5 * equalShare + 0.5 * ratingShare;
        const predicted = expectedShare > 0 && actualShare > 0 ? Math.tanh(Math.log(actualShare / expectedShare) / PERFORMANCE_TAU) : -1;
        const againstLobby = lobbyMedian > 0 ? rate > 0 ? Math.tanh(Math.log(rate / lobbyMedian) / PERFORMANCE_TAU) : -1 : 0;
        const performance = againstLobby > 0 ? Math.max(predicted, againstLobby) : predicted;
        const outcome = placed ? placed[index] : index === input.winner ? 1 : 0;
        const playerK = usesProvisionalK(formula) && player.tracked ? provisionalK(kFactor, priorMatches?.get(player.id) ?? 0) : kFactor;
        const delta = Math.round(playerK * (outcome - expected[index] + PERFORMANCE_WEIGHT * performance));
        const after = player.tracked ? clampElo(before + delta) : before;
        if (player.tracked)
          updates.set(player.id, after);
        return {
          id: player.tracked ? player.id : null,
          name: player.name,
          damage: player.damage,
          tracked: player.tracked,
          elo: before,
          eloBefore: before,
          eloAfter: after,
          delta: player.tracked ? after - before : 0
        };
      })
    });
  });
  return { result, updates };
}
function replay(events, roster, kFactor, legacyK = kFactor) {
  const elos = new Map;
  for (const player of roster)
    elos.set(player.id, clampElo(player.baseElo));
  const outcomes = new Map;
  const matchesPlayed = new Map;
  const ordered = [...events].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const event of ordered) {
    if (event.kind === "adjust") {
      const before = elos.get(event.payload.playerId) ?? clampElo(event.payload.elo);
      const after = clampElo(event.payload.elo);
      elos.set(event.payload.playerId, after);
      outcomes.set(event.id, {
        eventId: event.id,
        kind: "adjust",
        result: { playerId: event.payload.playerId, eloBefore: before, eloAfter: after }
      });
      continue;
    }
    const formula = eventFormula(event.payload);
    const eventK = formula !== 1 && isKFactor(event.payload.k) ? event.payload.k : legacyK;
    const { result, updates } = rateMatch(event.payload, elos, eventK, {
      formula,
      priorMatches: matchesPlayed
    });
    for (const [id, elo] of updates)
      elos.set(id, elo);
    if (result.teams.length > 0) {
      const seen = new Set;
      for (const team of event.payload.teams)
        for (const player of team.players)
          if (player.tracked)
            seen.add(player.id);
      for (const id of seen)
        matchesPlayed.set(id, (matchesPlayed.get(id) ?? 0) + 1);
    }
    outcomes.set(event.id, { eventId: event.id, kind: "match", result });
  }
  return { elos, outcomes };
}

// src/shared/roles.ts
var ROLES = [
  {
    id: "sniper",
    label: "Sniper",
    short: "SN",
    hint: "Long-range picks and sightline control"
  },
  {
    id: "push",
    label: "Push",
    short: "PU",
    hint: "Takes space and forces the pace"
  },
  {
    id: "antipush",
    label: "Anti-push",
    short: "AP",
    hint: "Holds a lane and stops the other side pushing"
  },
  {
    id: "entry",
    label: "Entry",
    short: "EN",
    hint: "First through the door, opens the site"
  },
  {
    id: "support",
    label: "Support",
    short: "SU",
    hint: "Utility, smokes, heals and trades for the team"
  },
  {
    id: "flank",
    label: "Flank",
    short: "FL",
    hint: "Off-angles, lurks and back-line pressure"
  },
  {
    id: "igl",
    label: "IGL",
    short: "IG",
    hint: "Calls the round"
  },
  {
    id: "flex",
    label: "Flex",
    short: "FX",
    hint: "Fills whatever the team is missing"
  }
];
var ROLE_IDS = ROLES.map((role) => role.id);
var byId = new Map(ROLES.map((role) => [role.id, role]));
function normalizeTags(value, allowed = ROLE_IDS) {
  if (!Array.isArray(value))
    return [];
  const chosen = new Set;
  for (const item of value)
    if (typeof item === "string")
      chosen.add(item);
  return allowed.filter((id) => chosen.has(id));
}
var ROLE_COUNT = ROLE_IDS.length;

// src/worker/auth.ts
import { createFreebuffAuth } from "@freebuff/auth";
var LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
function isLocalPreview(request, env) {
  return !env.FREEBUFF_CLIENT_ID && !env.APP_ORIGIN && LOOPBACK.has(new URL(request.url).hostname);
}
var cached;
function getAuth(env) {
  if (!env.FREEBUFF_CLIENT_ID || !env.APP_ORIGIN)
    return null;
  const origin = new URL(env.APP_ORIGIN);
  const key = JSON.stringify([
    env.FREEBUFF_CLIENT_ID,
    env.FREEBUFF_ISSUER,
    env.APP_ORIGIN
  ]);
  if (cached?.key !== key) {
    cached = {
      key,
      auth: createFreebuffAuth({
        clientId: env.FREEBUFF_CLIENT_ID,
        issuer: env.FREEBUFF_ISSUER || undefined,
        baseUrl: env.APP_ORIGIN,
        allowInsecureLocalhost: origin.protocol === "http:" && LOOPBACK.has(origin.hostname)
      })
    };
  }
  return cached.auth;
}
async function currentUser(request, env) {
  const auth = getAuth(env);
  if (auth)
    return auth.getUser(request);
  return isLocalPreview(request, env) ? { sub: "local-preview", name: "Local preview" } : null;
}
function appOrigin(request, env) {
  return env.APP_ORIGIN || (isLocalPreview(request, env) ? new URL(request.url).origin : null);
}

// src/worker/db.ts
var schema = [
  `CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    owner_name TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    k_factor INTEGER NOT NULL DEFAULT 32,
    rev INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS groups_owner ON groups(owner_sub, deleted_at)`,
  `CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    user_sub TEXT NOT NULL,
    role TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_sub)
  )`,
  `CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_sub)`,
  `CREATE TABLE IF NOT EXISTS group_invites (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by_sub TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    expires_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS group_invites_group ON group_invites(group_id, revoked_at)`,
  `CREATE TABLE IF NOT EXISTS group_tags (
    group_id TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    short TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS group_tags_order ON group_tags(group_id, sort, id)`,
  `CREATE TABLE IF NOT EXISTS group_player_emails (
    group_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    email TEXT NOT NULL,
    added_by_sub TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, player_id, email)
  )`,
  `CREATE INDEX IF NOT EXISTS player_emails_player ON group_player_emails(group_id, player_id)`,
  `CREATE INDEX IF NOT EXISTS player_emails_email ON group_player_emails(group_id, email)`,
  `CREATE TABLE IF NOT EXISTS group_player_requests (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    requester_sub TEXT NOT NULL,
    requester_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    kind TEXT NOT NULL,
    player_id TEXT,
    name TEXT,
    username TEXT,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by_sub TEXT,
    decided_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS player_requests_group ON group_player_requests(group_id, status, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS player_requests_pending ON group_player_requests(group_id, requester_sub) WHERE status = 'pending'`,
  `CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    group_id TEXT,
    name TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    skill INTEGER NOT NULL,
    elo INTEGER NOT NULL DEFAULT 0,
    base_elo INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    sitting_out INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS players_owner ON players(owner_sub, created_at ASC, id ASC)`,
  `CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    group_id TEXT,
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS rounds_owner ON rounds(owner_sub, created_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS rating_events (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    group_id TEXT,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS rating_events_owner ON rating_events(owner_sub, position ASC, created_at ASC)`,
  `CREATE TABLE IF NOT EXISTS rating_results (
    event_id TEXT NOT NULL,
    owner_sub TEXT NOT NULL,
    group_id TEXT,
    slot TEXT NOT NULL,
    player_id TEXT,
    name TEXT NOT NULL,
    elo_before INTEGER NOT NULL,
    elo_after INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    PRIMARY KEY (event_id, slot)
  )`,
  `CREATE INDEX IF NOT EXISTS rating_results_player ON rating_results(owner_sub, player_id)`,
  `CREATE TABLE IF NOT EXISTS settings (
    owner_sub TEXT PRIMARY KEY,
    k_factor INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rating_meta (
    owner_sub TEXT PRIMARY KEY,
    legacy_k INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS group_rating_meta (
    group_id TEXT PRIMARY KEY,
    legacy_k INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS log_squashes (
    owner_sub TEXT PRIMARY KEY,
    removed INTEGER NOT NULL,
    squashed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS group_squashes (
    group_id TEXT PRIMARY KEY,
    removed INTEGER NOT NULL,
    squashed_at INTEGER NOT NULL
  )`
];
var REQUIRED_TABLES = [
  "players",
  "rounds",
  "rating_events",
  "rating_results",
  "settings",
  "rating_meta",
  "log_squashes",
  "groups",
  "group_members",
  "group_invites",
  "group_tags",
  "group_player_emails",
  "group_player_requests",
  "group_rating_meta",
  "group_squashes"
];
var TAG_COLUMN = `ALTER TABLE players ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`;
var USERNAME_COLUMN = `ALTER TABLE players ADD COLUMN username TEXT NOT NULL DEFAULT ''`;
var ELO_COLUMN = `ALTER TABLE players ADD COLUMN elo INTEGER NOT NULL DEFAULT 0`;
var BASE_ELO_COLUMN = `ALTER TABLE players ADD COLUMN base_elo INTEGER NOT NULL DEFAULT 0`;
var DELETED_AT_COLUMN = `ALTER TABLE players ADD COLUMN deleted_at INTEGER`;
var GROUP_COLUMNS = [
  ["players", "group_id TEXT"],
  ["rating_events", "group_id TEXT"],
  ["rating_results", "group_id TEXT"],
  ["rounds", "group_id TEXT"],
  ["log_squashes", "group_id TEXT"]
];
var TABLES = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map((table) => `'${table}'`).join(", ")})`;
var COLUMNS = "SELECT name FROM pragma_table_info('players')";
var ensureColumns = async (db) => {
  const columns = await db.prepare(COLUMNS).all();
  const names = new Set(columns.results.map((column) => column.name));
  const missing = [];
  if (!names.has("tags"))
    missing.push(TAG_COLUMN);
  if (!names.has("username"))
    missing.push(USERNAME_COLUMN);
  if (!names.has("elo"))
    missing.push(ELO_COLUMN);
  if (!names.has("base_elo"))
    missing.push(BASE_ELO_COLUMN);
  if (!names.has("deleted_at"))
    missing.push(DELETED_AT_COLUMN);
  if (missing.length > 0)
    await db.batch(missing.map((sql) => db.prepare(sql)));
  if (!names.has("elo") || !names.has("base_elo")) {
    await db.prepare("UPDATE players SET elo = skill * 100, base_elo = skill * 100 WHERE elo = 0").run();
  }
  await ensureGroupColumns(db);
};
var ensureGroupColumns = async (db) => {
  const statements = [];
  for (const [table, column] of GROUP_COLUMNS) {
    const info = await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all();
    if (!info.results.some((entry) => entry.name === "group_id"))
      statements.push(db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column}`));
  }
  if (statements.length > 0)
    await db.batch(statements);
};
var groupIndexes = [
  `CREATE INDEX IF NOT EXISTS players_group ON players(group_id, created_at ASC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS rounds_group ON rounds(group_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS rating_events_group ON rating_events(group_id, position ASC, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS rating_results_group ON rating_results(group_id, event_id)`
];
var bootstrap = async (db) => {
  const tables = await db.prepare(TABLES).all();
  if (tables.results.length < REQUIRED_TABLES.length) {
    await db.batch(schema.map((sql) => db.prepare(sql)));
  }
  await ensureColumns(db);
  await db.batch(groupIndexes.map((sql) => db.prepare(sql)));
};
var ready = new WeakMap;
function ensureSchema(db) {
  let pending = ready.get(db);
  if (!pending) {
    pending = bootstrap(db).catch(async (error) => {
      console.warn("Teammaker: schema bootstrap failed, retrying once", error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        await bootstrap(db);
      } catch (retryError) {
        ready.delete(db);
        throw retryError;
      }
    });
    ready.set(db, pending);
  }
  return pending;
}
var parseTags = (value, allowed) => {
  if (!value)
    return [];
  try {
    return normalizeTags(JSON.parse(value), allowed);
  } catch {
    return [];
  }
};
var mapPlayer = (row, allowedTags, emails) => ({
  id: row.id,
  name: row.name,
  username: row.username ?? "",
  skill: skillFromElo(row.elo),
  elo: row.elo,
  tags: parseTags(row.tags, allowedTags),
  emails: [...emails ?? []],
  createdAt: row.created_at,
  updatedAt: row.updated_at
});
var asString = (value, fallback = "") => typeof value === "string" ? value : fallback;
var mapRound = (row) => {
  try {
    const config = JSON.parse(row.config);
    if (!config || !Array.isArray(config.teams))
      return null;
    const legacy = config.version !== 2;
    const teams = config.teams.map((team) => {
      const entry = team ?? {};
      const players = Array.isArray(entry.players) ? entry.players : [];
      return {
        sum: (Number(entry.sum) || 0) * (legacy ? 100 : 1),
        players: players.map((player) => {
          const raw = player ?? {};
          return {
            id: asString(raw.id),
            name: asString(raw.name),
            elo: clampElo(legacy ? (Number(raw.skill) || 1) * 100 : Number(raw.elo)),
            tags: normalizeTags(raw.tags)
          };
        })
      };
    });
    const benchedIds = Array.isArray(config.benchedIds) ? config.benchedIds.filter((id) => typeof id === "string") : [];
    return {
      id: row.id,
      createdAt: row.created_at,
      config: {
        version: 2,
        teamCount: Number(config.teamCount) || 1,
        tolerance: (Number(config.tolerance) || 0) * (legacy ? 100 : 1),
        spread: (Number(config.spread) || 0) * (legacy ? 100 : 1),
        teams,
        benchedIds
      }
    };
  } catch {
    return null;
  }
};

// src/worker/groups.ts
var MAX_GROUPS = 25;
var MAX_MEMBERS = 100;
var MAX_TAGS = 16;
var MAX_GROUP_NAME = 40;
var MAX_TAG_LABEL = 24;
var MAX_TAG_SHORT = 3;
var MAX_EMAIL_LENGTH = 254;
var MAX_REQUEST_NOTE = 280;
var MAX_EMAILS_PER_PLAYER = 10;
var EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var isGroupRole = (value) => value === "owner" || value === "editor" || value === "viewer";
var readEmail = (value) => {
  if (typeof value !== "string")
    return null;
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(email) && !/[\u0000-\u001f\u007f]/.test(email) ? email : null;
};
var readNote = (value) => {
  if (value === undefined)
    return "";
  if (typeof value !== "string")
    return null;
  const note = value.trim().replace(/\s+/g, " ");
  return note.length <= MAX_REQUEST_NOTE ? note : null;
};
var readGroupName = (value) => {
  if (typeof value !== "string")
    return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= MAX_GROUP_NAME ? name : null;
};
var readTagLabel = (value) => {
  if (typeof value !== "string")
    return null;
  const label = value.trim().replace(/\s+/g, " ");
  return label.length >= 1 && label.length <= MAX_TAG_LABEL ? label : null;
};
var readTagShort = (value) => {
  if (value === undefined)
    return "";
  if (typeof value !== "string")
    return null;
  const short = value.trim();
  return short.length <= MAX_TAG_SHORT && !/[\u0000-\u001f\u007f]/.test(short) ? short : null;
};
var mapTag = (row) => ({
  id: row.id,
  label: row.label,
  short: row.short,
  sort: row.sort
});
async function loadTags(db, groupId) {
  const rows = await db.prepare("SELECT id, label, short, sort FROM group_tags WHERE group_id = ? ORDER BY sort ASC, id ASC").bind(groupId).all();
  return rows.results.map(mapTag);
}
async function roleFor(db, groupId, sub) {
  const row = await db.prepare(`SELECT g.owner_sub, m.role FROM groups g
       LEFT JOIN group_members m ON m.group_id = g.id AND m.user_sub = ?
       WHERE g.id = ? AND g.deleted_at IS NULL`).bind(sub, groupId).first();
  if (!row)
    return null;
  if (row.owner_sub === sub)
    return "owner";
  return row.role === "editor" || row.role === "viewer" ? row.role : null;
}
async function loadGroupDetail(db, groupId, sub) {
  const row = await db.prepare(`SELECT g.id, g.owner_sub, g.owner_name, g.name, g.k_factor, g.rev,
              g.created_at, g.updated_at,
              CASE WHEN g.owner_sub = ? THEN 'owner' ELSE m.role END AS role,
              (SELECT COUNT(*) FROM players p WHERE p.group_id = g.id AND p.deleted_at IS NULL) AS player_count,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) + 1 AS member_count
       FROM groups g
       LEFT JOIN group_members m ON m.group_id = g.id AND m.user_sub = ?
       WHERE g.id = ? AND g.deleted_at IS NULL`).bind(sub, sub, groupId).first();
  if (!row)
    return null;
  const role = row.owner_sub === sub ? "owner" : row.role;
  if (!isGroupRole(role))
    return null;
  const members = await db.prepare(`SELECT user_sub, role, display_name, created_at FROM group_members
       WHERE group_id = ? ORDER BY created_at ASC, user_sub ASC`).bind(groupId).all();
  const list = [
    {
      id: row.owner_sub,
      name: row.owner_name || "Owner",
      role: "owner",
      isYou: row.owner_sub === sub,
      joinedAt: row.created_at
    },
    ...members.results.map((member) => ({
      id: member.user_sub,
      name: member.display_name || "Member",
      role: member.role === "editor" ? "editor" : "viewer",
      isYou: member.user_sub === sub,
      joinedAt: member.created_at
    }))
  ];
  return {
    id: row.id,
    name: row.name,
    role,
    kFactor: isKFactor(row.k_factor) ? row.k_factor : DEFAULT_K_FACTOR,
    rev: row.rev,
    playerCount: row.player_count ?? 0,
    memberCount: list.length,
    updatedAt: row.updated_at,
    ownerName: row.owner_name || "Owner",
    tags: await loadTags(db, groupId),
    members: list
  };
}
async function listGroups(db, sub) {
  const rows = await db.prepare(`SELECT g.id, g.owner_sub, g.owner_name, g.name, g.k_factor, g.rev,
              g.created_at, g.updated_at,
              CASE WHEN g.owner_sub = ? THEN 'owner' ELSE m.role END AS role,
              (SELECT COUNT(*) FROM players p WHERE p.group_id = g.id AND p.deleted_at IS NULL) AS player_count,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) + 1 AS member_count
       FROM groups g
       LEFT JOIN group_members m ON m.group_id = g.id AND m.user_sub = ?
       WHERE g.deleted_at IS NULL AND (g.owner_sub = ? OR m.user_sub IS NOT NULL)
       ORDER BY g.updated_at DESC, g.id ASC`).bind(sub, sub, sub).all();
  return rows.results.flatMap((row) => {
    const role = row.owner_sub === sub ? "owner" : row.role;
    if (!isGroupRole(role))
      return [];
    return [
      {
        id: row.id,
        name: row.name,
        role,
        kFactor: isKFactor(row.k_factor) ? row.k_factor : DEFAULT_K_FACTOR,
        rev: row.rev,
        playerCount: row.player_count ?? 0,
        memberCount: row.member_count ?? 1,
        updatedAt: row.updated_at
      }
    ];
  });
}
var bumpRev = (db, groupId, at = Date.now()) => db.prepare("UPDATE groups SET rev = rev + 1, updated_at = ? WHERE id = ?").bind(at, groupId);
async function createGroup(db, user, name) {
  const now = Date.now();
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO groups (id, owner_sub, owner_name, name, k_factor, rev, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).bind(id, user.sub, user.name ?? "", name, DEFAULT_K_FACTOR, now, now).run();
  return {
    id,
    name,
    role: "owner",
    kFactor: DEFAULT_K_FACTOR,
    rev: 0,
    playerCount: 0,
    memberCount: 1,
    updatedAt: now
  };
}
async function countOwnedGroups(db, sub) {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM groups WHERE owner_sub = ? AND deleted_at IS NULL").bind(sub).first();
  return row?.total ?? 0;
}
var base64url = (bytes) => {
  let binary = "";
  for (const byte of bytes)
    binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
function newInviteToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
async function hashInviteToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function ensureGroupForUser(db, user) {
  const legacy = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM players WHERE owner_sub = ? AND group_id IS NULL) AS players,
        (SELECT COUNT(*) FROM rating_events WHERE owner_sub = ? AND group_id IS NULL) AS events,
        (SELECT COUNT(*) FROM rating_results WHERE owner_sub = ? AND group_id IS NULL) AS results,
        (SELECT COUNT(*) FROM rounds WHERE owner_sub = ? AND group_id IS NULL) AS rounds,
        (SELECT COUNT(*) FROM log_squashes WHERE owner_sub = ? AND group_id IS NULL) AS squashes`).bind(user.sub, user.sub, user.sub, user.sub, user.sub).first();
  const total = (legacy?.players ?? 0) + (legacy?.events ?? 0) + (legacy?.results ?? 0) + (legacy?.rounds ?? 0) + (legacy?.squashes ?? 0);
  if (total === 0)
    return;
  const groupId = `g:${user.sub}`;
  const now = Date.now();
  const settings = await db.prepare("SELECT k_factor FROM settings WHERE owner_sub = ?").bind(user.sub).first();
  const kFactor = settings && isKFactor(settings.k_factor) ? settings.k_factor : DEFAULT_K_FACTOR;
  const used = new Set;
  const tagged = await db.prepare("SELECT tags FROM players WHERE owner_sub = ? AND group_id IS NULL").bind(user.sub).all();
  for (const row of tagged.results) {
    try {
      const tags = JSON.parse(row.tags);
      if (Array.isArray(tags)) {
        for (const tag of tags)
          if (typeof tag === "string")
            used.add(tag);
      }
    } catch {}
  }
  const statements = [
    db.prepare(`INSERT INTO groups (id, owner_sub, owner_name, name, k_factor, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO NOTHING`).bind(groupId, user.sub, user.name ?? "", "My roster", kFactor, now, now)
  ];
  let sort = 0;
  for (const roleId of ROLE_IDS) {
    if (!used.has(roleId))
      continue;
    const role = ROLES.find((entry) => entry.id === roleId);
    statements.push(db.prepare(`INSERT INTO group_tags (group_id, id, label, short, sort, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(group_id, id) DO NOTHING`).bind(groupId, roleId, role.label, role.short, sort, now, now));
    sort += 1;
  }
  for (const table of ["players", "rating_events", "rating_results", "rounds"]) {
    statements.push(db.prepare(`UPDATE ${table} SET group_id = ? WHERE owner_sub = ? AND group_id IS NULL`).bind(groupId, user.sub));
  }
  statements.push(db.prepare(`INSERT INTO group_rating_meta (group_id, legacy_k, created_at)
         SELECT ?, legacy_k, created_at FROM rating_meta WHERE owner_sub = ?
         ON CONFLICT(group_id) DO NOTHING`).bind(groupId, user.sub), db.prepare(`INSERT INTO group_squashes (group_id, removed, squashed_at)
         SELECT ?, removed, squashed_at FROM log_squashes WHERE owner_sub = ?
         ON CONFLICT(group_id) DO NOTHING`).bind(groupId, user.sub));
  await db.batch(statements);
}

// src/worker/guard.ts
import { isSameOriginRequest } from "@freebuff/auth";
async function preflight(c, authenticate) {
  const user = await authenticate(c.req.raw, c.env);
  if (!user)
    return { ok: false, response: c.json({ error: "Sign in required." }, 401) };
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = appOrigin(c.req.raw, c.env);
    if (!origin || !isSameOriginRequest(c.req.raw, origin))
      return {
        ok: false,
        response: c.json({ error: "Cross-origin request refused." }, 403)
      };
  }
  if (!c.env.DB)
    return {
      ok: false,
      response: c.json({ error: "This app is still being set up. Please try again later." }, 503)
    };
  await ensureSchema(c.env.DB);
  return { ok: true, user, db: c.env.DB };
}
function sessionGuard(authenticate) {
  return async (c, next) => {
    const done = await preflight(c, authenticate);
    if (!done.ok)
      return done.response;
    c.set("user", done.user);
    c.set("db", done.db);
    await next();
  };
}
function groupGuard(authenticate) {
  return async (c, next) => {
    const done = await preflight(c, authenticate);
    if (!done.ok)
      return done.response;
    const groupId = c.req.param("groupId");
    const role = groupId ? await roleFor(done.db, groupId, done.user.sub) : null;
    if (!role)
      return c.json({ error: "Group not found." }, 404);
    const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    if (write) {
      const after = c.req.path.replace(/^\/api\/groups\/[^/]+/, "");
      const sharing = after.startsWith("/invites") || after.startsWith("/members");
      const deleting = c.req.method === "DELETE" && after === "";
      const requesting = after.startsWith("/player-requests");
      if ((sharing || deleting) && role !== "owner")
        return c.json({ error: "Only the group owner can do that." }, 403);
      if (!sharing && !deleting && !requesting && role === "viewer")
        return c.json({ error: "You have view-only access to this group." }, 403);
    }
    c.set("user", done.user);
    c.set("db", done.db);
    c.set("role", role);
    c.set("groupId", groupId);
    await next();
  };
}

// src/worker/app.ts
var ROSTER_LIMIT = 200;
var MAX_BATCH = 50;
var MAX_LABEL = 60;
var MAX_REASON = 80;
var SQUASH_KEEP = 500;
var MATCH_ERROR = "A match needs two to eight teams, damage for every player, a winner and at least one player from your roster.";
var readName = (value) => {
  if (typeof value !== "string")
    return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 40 ? name : null;
};
var MAX_USERNAME = 32;
var readUsername = (value) => {
  if (typeof value !== "string")
    return null;
  const username = value.trim();
  return username.length <= MAX_USERNAME && !/[\u0000-\u001f\u007f]/.test(username) ? username : null;
};
var readSkill = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10 ? value : null;
var readElo = (value) => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 1000 ? value : null;
var readTags = (value, allowed) => {
  if (value === undefined)
    return [];
  if (!Array.isArray(value) || value.length > MAX_TAGS)
    return null;
  for (const item of value)
    if (typeof item !== "string" || !allowed.includes(item))
      return null;
  return normalizeTags(value, allowed);
};
var readRole = (value) => value === "editor" || value === "viewer" ? value : null;
function readClaim(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value;
  if (record.kind === "link") {
    if (Object.keys(record).some((key) => key !== "kind" && key !== "playerId"))
      return null;
    if (typeof record.playerId !== "string" || record.playerId.length < 1 || record.playerId.length > 64)
      return null;
    return { kind: "link", playerId: record.playerId };
  }
  if (record.kind === "create") {
    if (Object.keys(record).some((key) => key !== "kind" && key !== "name" && key !== "username"))
      return null;
    const name = readName(record.name);
    const username = readUsername(record.username);
    if (!name || !username)
      return null;
    return { kind: "create", name, username };
  }
  return null;
}
function readClaimDraft(body, user) {
  if (Object.keys(body).some((key) => key !== "claim" && key !== "note" && key !== "email"))
    return { draft: null, error: "Choose a player to connect." };
  const claim = readClaim(body.claim);
  if (!claim)
    return {
      draft: null,
      error: "Choose a player from the roster, or add one with a name and username."
    };
  const note = readNote(body.note);
  if (note === null)
    return {
      draft: null,
      error: `A note is up to ${MAX_REQUEST_NOTE} characters.`
    };
  const accountEmail = typeof user.email === "string" && user.email.trim() ? user.email : null;
  const email = accountEmail ? readEmail(accountEmail) : readEmail(body.email);
  if (!email)
    return {
      draft: null,
      error: accountEmail ? "Your account email cannot be used for this request." : typeof body.email === "string" && body.email.trim() ? "That does not look like an email address." : "Enter the email to connect before sending the request."
    };
  return { draft: { claim, note, email }, error: "" };
}
function readDrafts(body, allowedTags) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return null;
  const record = body;
  const list = "players" in record ? record.players : [record];
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH)
    return null;
  const drafts = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return null;
    const entry = item;
    if (Object.keys(entry).some((key) => key !== "name" && key !== "username" && key !== "skill" && key !== "tags"))
      return null;
    const name = readName(entry.name);
    const username = entry.username === undefined ? "" : readUsername(entry.username);
    const skill = readSkill(entry.skill);
    const tags = readTags(entry.tags, allowedTags);
    if (!name || username === null || skill === null || !tags)
      return null;
    drafts.push({ name, username, skill, tags });
  }
  return drafts;
}
function readMatchInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value;
  if (Object.keys(record).some((key) => key !== "label" && key !== "teams" && key !== "winner"))
    return null;
  const label = record.label === undefined ? "" : typeof record.label === "string" && record.label.trim().length <= MAX_LABEL ? record.label.trim() : null;
  if (label === null)
    return null;
  if (!Array.isArray(record.teams) || record.teams.length < 2 || record.teams.length > MAX_MATCH_TEAMS)
    return null;
  const seen = new Set;
  const teams = [];
  let tracked = 0;
  let totalDamage = 0;
  for (const rawTeam of record.teams) {
    if (!rawTeam || typeof rawTeam !== "object" || Array.isArray(rawTeam))
      return null;
    const team = rawTeam;
    if (Object.keys(team).some((key) => key !== "players"))
      return null;
    if (!Array.isArray(team.players) || team.players.length < 1 || team.players.length > MAX_MATCH_PLAYERS)
      return null;
    const players = [];
    for (const rawPlayer of team.players) {
      if (!rawPlayer || typeof rawPlayer !== "object" || Array.isArray(rawPlayer))
        return null;
      const player = rawPlayer;
      if (Object.keys(player).some((key) => key !== "id" && key !== "name" && key !== "damage" && key !== "tracked"))
        return null;
      if (typeof player.id !== "string" || player.id.length < 1 || player.id.length > 64 || seen.has(player.id))
        return null;
      seen.add(player.id);
      const name = readName(player.name);
      if (!name)
        return null;
      if (typeof player.damage !== "number" || !Number.isInteger(player.damage) || player.damage < 0 || player.damage > MAX_DAMAGE)
        return null;
      if (typeof player.tracked !== "boolean")
        return null;
      if (player.tracked)
        tracked++;
      totalDamage += player.damage;
      players.push({
        id: player.id,
        name,
        damage: player.damage,
        tracked: player.tracked
      });
    }
    teams.push({ players });
  }
  if (tracked === 0 || totalDamage === 0)
    return null;
  if (typeof record.winner !== "number" || !Number.isInteger(record.winner) || record.winner < 0 || record.winner >= teams.length)
    return null;
  return { label, teams, winner: record.winner };
}
async function loadEvents(db, groupId) {
  const rows = await db.prepare("SELECT id, position, kind, payload, created_at, updated_at FROM rating_events WHERE group_id = ? ORDER BY position ASC, created_at ASC, id ASC").bind(groupId).all();
  const events = [];
  for (const row of rows.results) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (row.kind === "match")
      events.push({
        id: row.id,
        position: row.position,
        kind: "match",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        payload
      });
    else if (row.kind === "adjust")
      events.push({
        id: row.id,
        position: row.position,
        kind: "adjust",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        payload
      });
  }
  return events;
}
async function getKFactor(db, groupId) {
  const row = await db.prepare("SELECT k_factor FROM groups WHERE id = ? AND deleted_at IS NULL").bind(groupId).first();
  return row && isKFactor(row.k_factor) ? row.k_factor : DEFAULT_K_FACTOR;
}
async function getLegacyK(db, groupId, currentK) {
  const row = await db.prepare("SELECT legacy_k FROM group_rating_meta WHERE group_id = ?").bind(groupId).first();
  return row && isKFactor(row.legacy_k) ? row.legacy_k : currentK;
}
async function pinLegacyK(db, groupId, legacyK) {
  await db.prepare("INSERT INTO group_rating_meta (group_id, legacy_k, created_at) VALUES (?, ?, ?) ON CONFLICT(group_id) DO NOTHING").bind(groupId, legacyK, Date.now()).run();
}
async function loadPlayers(db, groupId, allowedTags) {
  const result = await db.prepare("SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at FROM players WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC").bind(groupId).all();
  const emails = await loadEmailMap(db, groupId);
  return result.results.map((row) => mapPlayer(row, allowedTags, emails.get(row.id) ?? []));
}
async function loadPlayerEmailList(db, groupId, playerId) {
  const rows = await db.prepare("SELECT email FROM group_player_emails WHERE group_id = ? AND player_id = ? ORDER BY email ASC").bind(groupId, playerId).all();
  return rows.results.map((row) => row.email);
}
async function loadEmailMap(db, groupId) {
  const rows = await db.prepare("SELECT player_id, email FROM group_player_emails WHERE group_id = ? ORDER BY email ASC").bind(groupId).all();
  const map = new Map;
  for (const row of rows.results) {
    const emails = map.get(row.player_id);
    if (emails)
      emails.push(row.email);
    else
      map.set(row.player_id, [row.email]);
  }
  return map;
}
var linkEmailStatement = (db, groupId, playerId, email, sub, at) => db.prepare("INSERT INTO group_player_emails (group_id, player_id, email, added_by_sub, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(group_id, player_id, email) DO NOTHING").bind(groupId, playerId, email, sub, at);
var mapRequest = (row, sub) => ({
  id: row.id,
  kind: row.kind === "create" ? "create" : "link",
  playerId: row.player_id,
  playerName: row.player_name ?? null,
  name: row.name,
  username: row.username,
  email: row.email,
  note: row.note,
  requesterName: row.requester_name || "Member",
  isYou: row.requester_sub === sub,
  createdAt: row.created_at
});
async function filePlayerRequest(db, groupId, user, draft, at) {
  if (draft.claim.kind === "link") {
    const player = await db.prepare("SELECT id FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL").bind(draft.claim.playerId, groupId).first();
    if (!player)
      return {
        ok: false,
        error: "That player is no longer on this roster.",
        status: 404
      };
    const linked = await db.prepare("SELECT 1 AS found FROM group_player_emails WHERE group_id = ? AND player_id = ? AND email = ?").bind(groupId, draft.claim.playerId, draft.email).first();
    if (linked)
      return {
        ok: false,
        error: "That email is already connected to this player.",
        status: 409
      };
  }
  const pending = await db.prepare("SELECT id FROM group_player_requests WHERE group_id = ? AND requester_sub = ? AND status = 'pending'").bind(groupId, user.sub).first();
  if (pending)
    return {
      ok: false,
      error: "You already have a player request waiting for an editor.",
      status: 409
    };
  const id = crypto.randomUUID();
  return {
    ok: true,
    id,
    statement: db.prepare(`INSERT INTO group_player_requests (id, group_id, requester_sub, requester_name, email, kind, player_id, name, username, note, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).bind(id, groupId, user.sub, user.name ?? "", draft.email, draft.claim.kind, draft.claim.kind === "link" ? draft.claim.playerId : null, draft.claim.kind === "create" ? draft.claim.name : null, draft.claim.kind === "create" ? draft.claim.username : null, draft.note, at, at)
  };
}
async function applyPlayerRequest(db, groupId, row, at) {
  if (row.kind === "link") {
    if (!row.player_id)
      return { ok: false, error: "That request has no player.", status: 400 };
    const player = await db.prepare("SELECT id FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL").bind(row.player_id, groupId).first();
    if (!player)
      return {
        ok: false,
        error: "That player is no longer on the roster, so the request cannot be applied.",
        status: 409
      };
    return {
      ok: true,
      playerId: row.player_id,
      statements: [
        linkEmailStatement(db, groupId, row.player_id, row.email, row.requester_sub, at)
      ]
    };
  }
  const name = row.name;
  const username = row.username;
  if (!name || !username)
    return {
      ok: false,
      error: "That request is missing a display name or username.",
      status: 400
    };
  const existing = await db.prepare("SELECT COUNT(*) AS total FROM players WHERE group_id = ? AND deleted_at IS NULL").bind(groupId).first();
  if ((existing?.total ?? 0) + 1 > ROSTER_LIMIT)
    return { ok: false, error: "A roster holds up to 200 players.", status: 400 };
  const id = crypto.randomUUID();
  return {
    ok: true,
    playerId: id,
    statements: [
      db.prepare("INSERT INTO players (id, owner_sub, group_id, name, username, skill, elo, base_elo, tags, sitting_out, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?)").bind(id, row.requester_sub, groupId, name, username, skillFromElo(0), "[]", at, at),
      linkEmailStatement(db, groupId, id, row.email, row.requester_sub, at)
    ]
  };
}
async function nextPosition(db, groupId) {
  const row = await db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM rating_events WHERE group_id = ?").bind(groupId).first();
  return row?.next ?? 0;
}
async function findEvent(db, groupId, id) {
  return db.prepare("SELECT id, position, kind, payload, created_at, updated_at FROM rating_events WHERE id = ? AND group_id = ?").bind(id, groupId).first();
}
var insertResultSql = "INSERT INTO rating_results (event_id, owner_sub, group_id, slot, player_id, name, elo_before, elo_after, delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
async function recompute(db, groupId, from) {
  const players = await db.prepare("SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at, base_elo, deleted_at FROM players WHERE group_id = ? ORDER BY created_at ASC, id ASC").bind(groupId).all();
  const events = await loadEvents(db, groupId);
  const kFactor = await getKFactor(db, groupId);
  const legacyK = await getLegacyK(db, groupId, kFactor);
  const owner = await db.prepare("SELECT owner_sub FROM groups WHERE id = ?").bind(groupId).first();
  const ownerSub = owner?.owner_sub ?? groupId;
  const roster = players.results.map((player) => ({
    id: player.id,
    name: player.name,
    baseElo: player.base_elo
  }));
  const { elos, outcomes } = replay(events, roster, kFactor, legacyK);
  const statements = [];
  for (const player of players.results) {
    const elo = elos.get(player.id) ?? player.elo;
    const skill = skillFromElo(elo);
    if (elo !== player.elo || skill !== player.skill)
      statements.push(db.prepare("UPDATE players SET elo = ?, skill = ? WHERE id = ? AND group_id = ?").bind(elo, skill, player.id, groupId));
  }
  statements.push(db.prepare("DELETE FROM rating_results WHERE group_id = ? AND event_id IN (SELECT id FROM rating_events WHERE group_id = ? AND position >= ?)").bind(groupId, groupId, from));
  const names = new Map(players.results.map((player) => [player.id, player.name]));
  for (const event of events) {
    if (event.position < from)
      continue;
    const outcome = outcomes.get(event.id);
    if (!outcome)
      continue;
    if (outcome.kind === "match") {
      outcome.result.teams.forEach((team, teamIndex) => {
        team.players.forEach((player, slot) => {
          statements.push(db.prepare(insertResultSql).bind(event.id, ownerSub, groupId, `${teamIndex}:${slot}`, player.id, player.name, player.eloBefore, player.eloAfter, player.delta));
        });
      });
      continue;
    }
    const { playerId, eloBefore, eloAfter } = outcome.result;
    statements.push(db.prepare(insertResultSql).bind(event.id, ownerSub, groupId, "0", playerId, names.get(playerId) ?? "", eloBefore, eloAfter, eloAfter - eloBefore));
  }
  if (statements.length > 0)
    await db.batch(statements);
  const tags = await loadTags(db, groupId);
  const allowed = tags.map((tag) => tag.id);
  const emails = await loadEmailMap(db, groupId);
  return players.results.filter((player) => !player.deleted_at).map((player) => mapPlayer({
    ...player,
    elo: elos.get(player.id) ?? player.elo,
    skill: skillFromElo(elos.get(player.id) ?? player.elo)
  }, allowed, emails.get(player.id) ?? []));
}
async function countEvents(db, groupId) {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM rating_events WHERE group_id = ?").bind(groupId).first();
  return row?.total ?? 0;
}
async function compactLog(db, groupId, keep = SQUASH_KEEP) {
  const events = await loadEvents(db, groupId);
  if (events.length <= keep)
    return { removed: 0, kept: events.length };
  let cut = events.length - keep;
  for (let index = events.length - 1;index >= cut; index -= 1) {
    const event = events[index];
    if (event.kind === "match" && usesProvisionalK(eventFormula(event.payload))) {
      cut = index + 1;
      break;
    }
  }
  if (cut >= events.length)
    return { removed: 0, kept: events.length };
  const players = await db.prepare("SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at, base_elo, deleted_at FROM players WHERE group_id = ? ORDER BY created_at ASC, id ASC").bind(groupId).all();
  const kFactor = await getKFactor(db, groupId);
  const legacyK = await getLegacyK(db, groupId, kFactor);
  const roster = players.results.map((player) => ({
    id: player.id,
    name: player.name,
    baseElo: player.base_elo
  }));
  const { elos } = replay(events.slice(0, cut), roster, kFactor, legacyK);
  const oldest = `(SELECT id FROM rating_events WHERE group_id = ? ORDER BY position ASC, created_at ASC, id ASC LIMIT ${cut})`;
  const statements = [];
  for (const player of players.results) {
    const anchor = clampElo(elos.get(player.id) ?? player.base_elo);
    if (anchor === player.base_elo)
      continue;
    statements.push(db.prepare("UPDATE players SET base_elo = ? WHERE id = ? AND group_id = ?").bind(anchor, player.id, groupId));
  }
  statements.push(db.prepare(`DELETE FROM rating_results WHERE group_id = ? AND event_id IN ${oldest}`).bind(groupId, groupId), db.prepare(`DELETE FROM rating_events WHERE id IN ${oldest}`).bind(groupId), db.prepare("INSERT INTO group_squashes (group_id, removed, squashed_at) VALUES (?, ?, ?) ON CONFLICT(group_id) DO UPDATE SET removed = group_squashes.removed + excluded.removed, squashed_at = excluded.squashed_at").bind(groupId, cut, Date.now()), bumpRev(db, groupId));
  await db.batch(statements);
  return { removed: cut, kept: events.length - cut };
}
async function makeRoom(db, groupId) {
  if (await countEvents(db, groupId) < MAX_EVENTS)
    return true;
  const { removed } = await compactLog(db, groupId);
  return removed > 0;
}
async function matchViews(db, groupId) {
  const events = await loadEvents(db, groupId);
  const rows = await db.prepare("SELECT event_id, slot, player_id, name, elo_before, elo_after, delta FROM rating_results WHERE group_id = ?").bind(groupId).all();
  const results = new Map(rows.results.map((row) => [`${row.event_id}|${row.slot}`, row]));
  return events.map((event) => {
    if (event.kind === "adjust") {
      const row = results.get(`${event.id}|0`);
      return {
        id: event.id,
        kind: "adjust",
        position: event.position,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        playerId: event.payload.playerId,
        name: row?.name ?? "",
        reason: event.payload.reason,
        eloBefore: row?.elo_before ?? event.payload.elo,
        eloAfter: row?.elo_after ?? event.payload.elo,
        delta: row?.delta ?? 0
      };
    }
    const teams = event.payload.teams.map((team, teamIndex) => ({
      players: team.players.map((player, slot) => {
        const row = results.get(`${event.id}|${teamIndex}:${slot}`);
        return {
          id: player.tracked ? player.id : null,
          name: row?.name ?? player.name,
          damage: player.damage,
          tracked: player.tracked,
          elo: row?.elo_before ?? 0,
          eloBefore: row?.elo_before ?? 0,
          eloAfter: row?.elo_after ?? 0,
          delta: row?.delta ?? 0
        };
      })
    }));
    return {
      id: event.id,
      kind: "match",
      position: event.position,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      label: event.payload.label,
      winner: event.payload.winner,
      teams
    };
  });
}
async function trackedIdsExist(db, groupId, ids, includeArchived = false) {
  if (ids.length === 0)
    return true;
  const rows = await db.prepare(`SELECT id FROM players WHERE group_id = ?${includeArchived ? "" : " AND deleted_at IS NULL"} AND id IN (${ids.map(() => "?").join(", ")})`).bind(groupId, ...ids).all();
  return rows.results.length === new Set(ids).size;
}
function createApp(authenticate = currentUser) {
  const app = new Hono;
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  app.use("/api/*", bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: "Request is too large." }, 413)
  }));
  app.get("/api/health", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const db = c.env.DB;
    if (!db)
      return c.json({ ok: true, database: "unconfigured" });
    try {
      await db.prepare("SELECT 1 AS ok").first();
      const tables = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map((table) => `'${table}'`).join(", ")})`).all();
      return c.json({
        ok: true,
        database: "ok",
        schema: tables.results.length === REQUIRED_TABLES.length ? "ready" : "missing"
      });
    } catch (error) {
      console.error("Teammaker: database health check failed", error instanceof Error ? error.message : error);
      return c.json({ ok: false, database: "unreachable" }, 503);
    }
  });
  app.get("/api/session", async (c) => c.json({
    user: await authenticate(c.req.raw, c.env),
    mode: isLocalPreview(c.req.raw, c.env) ? "local" : c.env.FREEBUFF_CLIENT_ID && c.env.APP_ORIGIN ? "freebuff" : "setup",
    database: Boolean(c.env.DB)
  }));
  const guard = groupGuard(authenticate);
  app.get("/api/invites/:token", async (c) => {
    if (!c.env.DB)
      return c.json({ error: "This app is still being set up. Please try again later." }, 503);
    await ensureSchema(c.env.DB);
    const invite = await loadInvite(c.env.DB, c.req.param("token"));
    if (!invite)
      return c.json({ error: "That invite link is no longer valid." }, 404);
    const roster = await c.env.DB.prepare("SELECT id, name, username, elo FROM players WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC").bind(invite.groupId).all();
    return c.json({
      invite: {
        ...invite,
        players: roster.results.map((row) => ({
          id: row.id,
          name: row.name,
          username: row.username ?? "",
          elo: row.elo
        }))
      }
    });
  });
  app.use("/api/groups", sessionGuard(authenticate));
  app.use("/api/invites/:token/accept", sessionGuard(authenticate));
  app.use("/api/groups/:groupId", guard);
  app.use("/api/groups/:groupId/*", guard);
  app.get("/api/groups", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    await ensureGroupForUser(db, { sub: user.sub, name: user.name });
    if (user.name)
      await db.prepare("UPDATE group_members SET display_name = ?, updated_at = ? WHERE user_sub = ? AND display_name <> ?").bind(user.name, Date.now(), user.sub, user.name).run();
    return c.json({ groups: await listGroups(db, user.sub) });
  });
  app.post("/api/groups", async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = body && typeof body === "object" && !Array.isArray(body) ? readGroupName(body.name) : null;
    if (!name)
      return c.json({ error: "Group names are 1 to 40 characters." }, 400);
    const db = c.get("db");
    const user = c.get("user");
    if (await countOwnedGroups(db, user.sub) >= MAX_GROUPS)
      return c.json({ error: `You can own up to ${MAX_GROUPS} groups.` }, 400);
    return c.json({ group: await createGroup(db, { sub: user.sub, name: user.name }, name) }, 201);
  });
  app.get("/api/groups/:groupId", async (c) => {
    const detail = await loadGroupDetail(c.get("db"), c.get("groupId"), c.get("user").sub);
    return detail ? c.json({ group: detail }) : c.json({ error: "Group not found." }, 404);
  });
  app.patch("/api/groups/:groupId", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Nothing to update." }, 400);
    const patch = body;
    if (Object.keys(patch).some((key) => key !== "name" && key !== "kFactor") || Object.keys(patch).length === 0)
      return c.json({ error: "Nothing to update." }, 400);
    const sets = [];
    const values = [];
    if ("name" in patch) {
      const name = readGroupName(patch.name);
      if (!name)
        return c.json({ error: "Group names are 1 to 40 characters." }, 400);
      sets.push("name = ?");
      values.push(name);
    }
    if ("kFactor" in patch) {
      if (!isKFactor(patch.kFactor))
        return c.json({ error: "K must be a whole number from 8 to 64." }, 400);
      sets.push("k_factor = ?");
      values.push(patch.kFactor);
    }
    const db = c.get("db");
    const groupId = c.get("groupId");
    sets.push("updated_at = ?", "rev = rev + 1");
    values.push(Date.now(), groupId);
    await db.prepare(`UPDATE groups SET ${sets.join(", ")} WHERE id = ?`).bind(...values).run();
    const detail = await loadGroupDetail(db, groupId, c.get("user").sub);
    return detail ? c.json({ group: detail }) : c.json({ error: "Group not found." }, 404);
  });
  app.delete("/api/groups/:groupId", async (c) => {
    const now = Date.now();
    await c.get("db").prepare("UPDATE groups SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").bind(now, now, c.get("groupId")).run();
    return c.json({ ok: true });
  });
  app.get("/api/groups/:groupId/rev", async (c) => {
    const row = await c.get("db").prepare("SELECT rev FROM groups WHERE id = ? AND deleted_at IS NULL").bind(c.get("groupId")).first();
    return row ? c.json({ rev: row.rev }) : c.json({ error: "Group not found." }, 404);
  });
  app.post("/api/groups/:groupId/tags", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "A tag needs a label." }, 400);
    const record = body;
    if (Object.keys(record).some((key) => key !== "label" && key !== "short"))
      return c.json({ error: "A tag needs a label." }, 400);
    const label = readTagLabel(record.label);
    const short = readTagShort(record.short);
    if (!label || short === null)
      return c.json({ error: "Labels are 1 to 24 characters, short forms up to 3." }, 400);
    const db = c.get("db");
    const groupId = c.get("groupId");
    const tags = await loadTags(db, groupId);
    if (tags.length >= MAX_TAGS)
      return c.json({ error: `A group holds up to ${MAX_TAGS} tags.` }, 400);
    const id = crypto.randomUUID();
    const sort = tags.length;
    const now = Date.now();
    await db.batch([
      db.prepare("INSERT INTO group_tags (group_id, id, label, short, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(groupId, id, label, short, sort, now, now),
      bumpRev(db, groupId, now)
    ]);
    return c.json({ tag: { id, label, short, sort } }, 201);
  });
  app.patch("/api/groups/:groupId/tags/:tagId", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Nothing to update." }, 400);
    const patch = body;
    if (Object.keys(patch).some((key) => key !== "label" && key !== "short" && key !== "sort") || Object.keys(patch).length === 0)
      return c.json({ error: "Nothing to update." }, 400);
    const db = c.get("db");
    const groupId = c.get("groupId");
    const tagId = c.req.param("tagId");
    const current = await db.prepare("SELECT id FROM group_tags WHERE group_id = ? AND id = ?").bind(groupId, tagId).first();
    if (!current)
      return c.json({ error: "Tag not found." }, 404);
    const sets = [];
    const values = [];
    if ("label" in patch) {
      const label = readTagLabel(patch.label);
      if (!label)
        return c.json({ error: "Labels are 1 to 24 characters." }, 400);
      sets.push("label = ?");
      values.push(label);
    }
    if ("short" in patch) {
      const short = readTagShort(patch.short);
      if (short === null)
        return c.json({ error: "Short forms are up to 3 characters." }, 400);
      sets.push("short = ?");
      values.push(short);
    }
    if ("sort" in patch) {
      if (typeof patch.sort !== "number" || !Number.isInteger(patch.sort) || patch.sort < 0 || patch.sort > MAX_TAGS)
        return c.json({ error: "That order is not valid." }, 400);
      sets.push("sort = ?");
      values.push(patch.sort);
    }
    sets.push("updated_at = ?");
    values.push(Date.now(), groupId, tagId);
    await db.batch([
      db.prepare(`UPDATE group_tags SET ${sets.join(", ")} WHERE group_id = ? AND id = ?`).bind(...values),
      bumpRev(db, groupId)
    ]);
    return c.json({ ok: true });
  });
  app.delete("/api/groups/:groupId/tags/:tagId", async (c) => {
    const db = c.get("db");
    const groupId = c.get("groupId");
    const tagId = c.req.param("tagId");
    const current = await db.prepare("SELECT id FROM group_tags WHERE group_id = ? AND id = ?").bind(groupId, tagId).first();
    if (!current)
      return c.json({ error: "Tag not found." }, 404);
    const tags = await loadTags(db, groupId);
    const remaining = tags.filter((tag) => tag.id !== tagId).map((tag) => tag.id);
    const players = await db.prepare("SELECT id, tags FROM players WHERE group_id = ?").bind(groupId).all();
    const statements = [];
    for (const player of players.results) {
      let parsed;
      try {
        parsed = JSON.parse(player.tags);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed) || !parsed.includes(tagId))
        continue;
      statements.push(db.prepare("UPDATE players SET tags = ?, updated_at = ? WHERE id = ? AND group_id = ?").bind(JSON.stringify(normalizeTags(parsed, remaining)), Date.now(), player.id, groupId));
    }
    statements.push(db.prepare("DELETE FROM group_tags WHERE group_id = ? AND id = ?").bind(groupId, tagId), bumpRev(db, groupId));
    await db.batch(statements);
    return c.json({ ok: true, tags: remaining });
  });
  app.post("/api/groups/:groupId/invites", async (c) => {
    const body = await c.req.json().catch(() => null);
    const role = body && typeof body === "object" && !Array.isArray(body) ? readRole(body.role) : null;
    if (!role)
      return c.json({ error: "Pick editor or viewer for the invite." }, 400);
    const db = c.get("db");
    const groupId = c.get("groupId");
    const token = newInviteToken();
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.prepare("INSERT INTO group_invites (id, group_id, role, token_hash, created_by_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, groupId, role, await hashInviteToken(token), c.get("user").sub, now).run();
    const origin = appOrigin(c.req.raw, c.env) ?? new URL(c.req.url).origin;
    return c.json({ invite: { id, role, createdAt: now, url: `${origin}/join/${token}` } }, 201);
  });
  app.get("/api/groups/:groupId/invites", async (c) => {
    const rows = await c.get("db").prepare("SELECT id, role, created_at FROM group_invites WHERE group_id = ? AND revoked_at IS NULL ORDER BY created_at DESC").bind(c.get("groupId")).all();
    return c.json({
      invites: rows.results.map((row) => ({
        id: row.id,
        role: row.role === "editor" ? "editor" : "viewer",
        createdAt: row.created_at
      }))
    });
  });
  app.delete("/api/groups/:groupId/invites/:inviteId", async (c) => {
    const row = await c.get("db").prepare("UPDATE group_invites SET revoked_at = ? WHERE id = ? AND group_id = ? AND revoked_at IS NULL RETURNING id").bind(Date.now(), c.req.param("inviteId"), c.get("groupId")).first();
    return row ? c.json({ ok: true }) : c.json({ error: "Invite not found." }, 404);
  });
  app.get("/api/groups/:groupId/members", async (c) => {
    const detail = await loadGroupDetail(c.get("db"), c.get("groupId"), c.get("user").sub);
    return detail ? c.json({ members: detail.members }) : c.json({ error: "Group not found." }, 404);
  });
  app.patch("/api/groups/:groupId/members/:userId", async (c) => {
    const body = await c.req.json().catch(() => null);
    const role = body && typeof body === "object" && !Array.isArray(body) ? readRole(body.role) : null;
    if (!role)
      return c.json({ error: "Pick editor or viewer." }, 400);
    const db = c.get("db");
    const groupId = c.get("groupId");
    const userId = c.req.param("userId");
    const owner = await db.prepare("SELECT owner_sub FROM groups WHERE id = ?").bind(groupId).first();
    if (owner?.owner_sub === userId)
      return c.json({ error: "The owner keeps their role." }, 400);
    const changed = await db.prepare("UPDATE group_members SET role = ?, updated_at = ? WHERE group_id = ? AND user_sub = ? RETURNING user_sub").bind(role, Date.now(), groupId, userId).first();
    if (!changed)
      return c.json({ error: "Member not found." }, 404);
    await bumpRev(db, groupId).run();
    return c.json({ ok: true });
  });
  app.delete("/api/groups/:groupId/members/:userId", async (c) => {
    const db = c.get("db");
    const groupId = c.get("groupId");
    const userId = c.req.param("userId");
    const owner = await db.prepare("SELECT owner_sub FROM groups WHERE id = ?").bind(groupId).first();
    if (owner?.owner_sub === userId)
      return c.json({ error: "The owner cannot be removed." }, 400);
    const removed = await db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_sub = ? RETURNING user_sub").bind(groupId, userId).first();
    if (!removed)
      return c.json({ error: "Member not found." }, 404);
    await bumpRev(db, groupId).run();
    return c.json({ ok: true });
  });
  app.post("/api/invites/:token/accept", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const invite = await loadInvite(db, c.req.param("token"));
    if (!invite)
      return c.json({ error: "That invite link is no longer valid." }, 404);
    const body = await c.req.json().catch(() => null);
    let draft = null;
    if (body !== null) {
      if (typeof body !== "object" || Array.isArray(body))
        return c.json({ error: "Choose a player to connect." }, 400);
      const record = body;
      if (record.claim !== undefined) {
        const parsed = readClaimDraft(record, user);
        if (!parsed.draft)
          return c.json({ error: parsed.error }, 400);
        draft = parsed.draft;
      } else if ("note" in record || "email" in record) {
        return c.json({ error: "Choose a player to connect." }, 400);
      }
    }
    const now = Date.now();
    const statements = [];
    const owner = await db.prepare("SELECT owner_sub FROM groups WHERE id = ?").bind(invite.groupId).first();
    if (owner?.owner_sub !== user.sub) {
      const members = await db.prepare("SELECT COUNT(*) AS total FROM group_members WHERE group_id = ?").bind(invite.groupId).first();
      if ((members?.total ?? 0) + 1 > MAX_MEMBERS)
        return c.json({ error: "That group is full." }, 400);
      statements.push(db.prepare(`INSERT INTO group_members (group_id, user_sub, role, display_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(group_id, user_sub) DO NOTHING`).bind(invite.groupId, user.sub, invite.role, user.name ?? "", now, now));
    }
    let requestId = null;
    if (draft) {
      const filed = await filePlayerRequest(db, invite.groupId, user, draft, now);
      if (!filed.ok)
        return c.json({ error: filed.error }, filed.status);
      requestId = filed.id;
      statements.push(filed.statement);
    }
    statements.push(bumpRev(db, invite.groupId, now));
    await db.batch(statements);
    return c.json({
      group: { id: invite.groupId, name: invite.name, role: invite.role },
      request: requestId ? { id: requestId } : null
    });
  });
  app.get("/api/groups/:groupId/player-requests", async (c) => {
    const db = c.get("db");
    const groupId = c.get("groupId");
    const user = c.get("user");
    const editor = c.get("role") !== "viewer";
    const rows = await db.prepare(`SELECT r.id, r.requester_sub, r.requester_name, r.email, r.kind,
                r.player_id, r.name, r.username, r.note, r.created_at,
                p.name AS player_name
         FROM group_player_requests r
         LEFT JOIN players p ON p.id = r.player_id AND p.group_id = r.group_id
         WHERE r.group_id = ? AND r.status = 'pending'${editor ? "" : " AND r.requester_sub = ?"}
         ORDER BY r.created_at ASC, r.id ASC`).bind(...editor ? [groupId] : [groupId, user.sub]).all();
    return c.json({ requests: rows.results.map((row) => mapRequest(row, user.sub)) });
  });
  app.post("/api/groups/:groupId/player-requests", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Choose a player to connect." }, 400);
    const parsed = readClaimDraft(body, c.get("user"));
    if (!parsed.draft)
      return c.json({ error: parsed.error }, 400);
    const db = c.get("db");
    const groupId = c.get("groupId");
    const now = Date.now();
    const filed = await filePlayerRequest(db, groupId, c.get("user"), parsed.draft, now);
    if (!filed.ok)
      return c.json({ error: filed.error }, filed.status);
    await db.batch([filed.statement, bumpRev(db, groupId, now)]);
    return c.json({ request: { id: filed.id } }, 201);
  });
  app.post("/api/groups/:groupId/player-requests/:requestId/approve", async (c) => {
    if (c.get("role") === "viewer")
      return c.json({ error: "Only an editor can review player requests." }, 403);
    const db = c.get("db");
    const groupId = c.get("groupId");
    const id = c.req.param("requestId");
    const row = await db.prepare("SELECT id, requester_sub, requester_name, email, kind, player_id, name, username, note, created_at FROM group_player_requests WHERE id = ? AND group_id = ? AND status = 'pending'").bind(id, groupId).first();
    if (!row)
      return c.json({ error: "Request not found." }, 404);
    const now = Date.now();
    const claimed = await db.prepare(`UPDATE group_player_requests SET status = 'approved', decided_by_sub = ?, decided_at = ?, updated_at = ?
         WHERE id = ? AND group_id = ? AND status = 'pending' RETURNING id`).bind(c.get("user").sub, now, now, id, groupId).first();
    if (!claimed)
      return c.json({ error: "That request was already handled." }, 409);
    const applied = await applyPlayerRequest(db, groupId, row, now);
    if (!applied.ok) {
      await db.prepare("UPDATE group_player_requests SET status = 'pending', decided_by_sub = NULL, decided_at = NULL, updated_at = ? WHERE id = ? AND group_id = ?").bind(Date.now(), id, groupId).run();
      return c.json({ error: applied.error }, applied.status);
    }
    await db.batch([...applied.statements, bumpRev(db, groupId, now)]);
    return c.json({ ok: true, playerId: applied.playerId });
  });
  app.delete("/api/groups/:groupId/player-requests/:requestId", async (c) => {
    const db = c.get("db");
    const groupId = c.get("groupId");
    const id = c.req.param("requestId");
    const row = await db.prepare("SELECT requester_sub FROM group_player_requests WHERE id = ? AND group_id = ?").bind(id, groupId).first();
    if (!row)
      return c.json({ error: "Request not found." }, 404);
    if (c.get("role") === "viewer" && row.requester_sub !== c.get("user").sub)
      return c.json({ error: "Only an editor can review player requests." }, 403);
    await db.batch([
      db.prepare("DELETE FROM group_player_requests WHERE id = ? AND group_id = ?").bind(id, groupId),
      bumpRev(db, groupId)
    ]);
    return c.json({ ok: true });
  });
  app.post("/api/groups/:groupId/players/:playerId/emails", async (c) => {
    const db = c.get("db");
    const groupId = c.get("groupId");
    const playerId = c.req.param("playerId");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Enter an email address." }, 400);
    const record = body;
    if (Object.keys(record).some((key) => key !== "email"))
      return c.json({ error: "Enter an email address." }, 400);
    const email = readEmail(record.email);
    if (!email)
      return c.json({ error: "That does not look like an email address." }, 400);
    const player = await db.prepare("SELECT id FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL").bind(playerId, groupId).first();
    if (!player)
      return c.json({ error: "Player not found." }, 404);
    const emails = await loadPlayerEmailList(db, groupId, playerId);
    if (emails.includes(email))
      return c.json({ ok: true, emails });
    if (emails.length >= MAX_EMAILS_PER_PLAYER)
      return c.json({ error: `A player holds up to ${MAX_EMAILS_PER_PLAYER} emails.` }, 400);
    const now = Date.now();
    await db.batch([
      linkEmailStatement(db, groupId, playerId, email, c.get("user").sub, now),
      bumpRev(db, groupId, now)
    ]);
    return c.json({ ok: true, emails: await loadPlayerEmailList(db, groupId, playerId) }, 201);
  });
  app.delete("/api/groups/:groupId/players/:playerId/emails/:email", async (c) => {
    const db = c.get("db");
    const groupId = c.get("groupId");
    const playerId = c.req.param("playerId");
    const email = readEmail(c.req.param("email"));
    if (!email)
      return c.json({ error: "That email is not connected." }, 404);
    const player = await db.prepare("SELECT id FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL").bind(playerId, groupId).first();
    if (!player)
      return c.json({ error: "Player not found." }, 404);
    const removed = await db.prepare("DELETE FROM group_player_emails WHERE group_id = ? AND player_id = ? AND email = ? RETURNING email").bind(groupId, playerId, email).first();
    if (!removed)
      return c.json({ error: "That email is not connected." }, 404);
    await bumpRev(db, groupId).run();
    return c.json({
      ok: true,
      emails: await loadPlayerEmailList(db, groupId, playerId)
    });
  });
  app.get("/api/groups/:groupId/players", async (c) => {
    const db = c.get("db");
    const groupId = c.get("groupId");
    const tags = (await loadTags(db, groupId)).map((tag) => tag.id);
    return c.json({ players: await loadPlayers(db, groupId, tags) });
  });
  app.post("/api/groups/:groupId/players", async (c) => {
    const db = c.get("db");
    const groupId = c.get("groupId");
    const allowed = (await loadTags(db, groupId)).map((tag) => tag.id);
    const body = await c.req.json().catch(() => null);
    const drafts = readDrafts(body, allowed);
    if (!drafts)
      return c.json({ error: "Each player needs a name, a skill from 1 to 10 and known tags." }, 400);
    const existing = await db.prepare("SELECT COUNT(*) AS total FROM players WHERE group_id = ? AND deleted_at IS NULL").bind(groupId).first();
    if ((existing?.total ?? 0) + drafts.length > ROSTER_LIMIT)
      return c.json({ error: "A roster holds up to 200 players." }, 400);
    const createdAt = Date.now();
    const players = drafts.map((draft, index) => ({
      id: crypto.randomUUID(),
      name: draft.name,
      username: draft.username,
      skill: draft.skill,
      elo: clampElo(draft.skill * 100),
      tags: draft.tags,
      createdAt: createdAt + index,
      updatedAt: createdAt + index
    }));
    await db.batch([
      ...players.map((player) => db.prepare("INSERT INTO players (id, owner_sub, group_id, name, username, skill, elo, base_elo, tags, sitting_out, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)").bind(player.id, c.get("user").sub, groupId, player.name, player.username ?? "", player.skill, player.elo, player.elo, JSON.stringify(player.tags), player.createdAt, player.updatedAt)),
      bumpRev(db, groupId)
    ]);
    return c.json({ players }, 201);
  });
  app.patch("/api/groups/:groupId/players/:playerId", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Nothing to update." }, 400);
    const patch = body;
    if (Object.keys(patch).some((key) => !["name", "username", "skill", "elo", "tags"].includes(key)))
      return c.json({
        error: "Nothing to update. Sitting out is saved on each device, not in the group."
      }, 400);
    const db = c.get("db");
    const groupId = c.get("groupId");
    const id = c.req.param("playerId");
    const current = await db.prepare("SELECT id, elo FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL").bind(id, groupId).first();
    if (!current)
      return c.json({ error: "Player not found." }, 404);
    const allowed = (await loadTags(db, groupId)).map((tag) => tag.id);
    const sets = [];
    const values = [];
    let targetElo = null;
    let reason = "Manual rating";
    if ("name" in patch) {
      const name = readName(patch.name);
      if (!name)
        return c.json({ error: "Names are 1 to 40 characters." }, 400);
      sets.push("name = ?");
      values.push(name);
    }
    if ("username" in patch) {
      const username = readUsername(patch.username);
      if (username === null)
        return c.json({ error: "Usernames are up to 32 characters." }, 400);
      sets.push("username = ?");
      values.push(username);
    }
    if ("skill" in patch && "elo" in patch)
      return c.json({ error: "Set either the 1-10 rating or elo, not both." }, 400);
    if ("skill" in patch) {
      const skill = readSkill(patch.skill);
      if (skill === null)
        return c.json({ error: "Skills are whole numbers from 1 to 10." }, 400);
      targetElo = skill * 100;
      reason = "1-10 rating";
    }
    if ("elo" in patch) {
      const elo = readElo(patch.elo);
      if (elo === null)
        return c.json({ error: "Elo is a whole number from 100 to 1000." }, 400);
      targetElo = elo;
      reason = "Advanced elo edit";
    }
    let logAdjustment = false;
    if (targetElo !== null) {
      sets.push("elo = ?", "skill = ?");
      values.push(targetElo, skillFromElo(targetElo));
      const history = await db.prepare("SELECT COUNT(*) AS total FROM rating_results WHERE group_id = ? AND player_id = ?").bind(groupId, id).first();
      logAdjustment = (history?.total ?? 0) > 0;
      if (!logAdjustment) {
        sets.push("base_elo = ?");
        values.push(targetElo);
      }
    }
    if ("tags" in patch) {
      const tags = readTags(patch.tags, allowed);
      if (!tags)
        return c.json({ error: "Those tags are not in this group." }, 400);
      sets.push("tags = ?");
      values.push(JSON.stringify(tags));
    }
    if (sets.length === 0)
      return c.json({ error: "Nothing to update." }, 400);
    sets.push("updated_at = ?");
    values.push(Date.now(), id, groupId);
    await db.batch([
      db.prepare(`UPDATE players SET ${sets.join(", ")} WHERE id = ? AND group_id = ?`).bind(...values),
      bumpRev(db, groupId)
    ]);
    if (targetElo !== null && logAdjustment && targetElo !== current.elo) {
      await makeRoom(db, groupId);
      const position = await nextPosition(db, groupId);
      const now = Date.now();
      await db.prepare("INSERT INTO rating_events (id, owner_sub, group_id, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), c.get("user").sub, groupId, position, "adjust", JSON.stringify({ playerId: id, elo: targetElo, reason }), now, now).run();
      const players = await recompute(db, groupId, position);
      return c.json({ player: players.find((entry) => entry.id === id) ?? null });
    }
    const row = await db.prepare("SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL").bind(id, groupId).first();
    if (!row)
      return c.json({ error: "Player not found." }, 404);
    return c.json({
      player: mapPlayer(row, allowed, await loadPlayerEmailList(db, groupId, id))
    });
  });
  app.delete("/api/groups/:groupId/players/:playerId", async (c) => {
    const db = c.get("db");
    const groupId = c.get("groupId");
    const id = c.req.param("playerId");
    const player = await db.prepare("SELECT id FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL").bind(id, groupId).first();
    if (!player)
      return c.json({ error: "Player not found." }, 404);
    const now = Date.now();
    await db.batch([
      db.prepare("UPDATE players SET deleted_at = ?, updated_at = ? WHERE id = ? AND group_id = ?").bind(now, now, id, groupId),
      db.prepare("DELETE FROM group_player_emails WHERE group_id = ? AND player_id = ?").bind(groupId, id),
      bumpRev(db, groupId, now)
    ]);
    return c.json({ ok: true });
  });
  app.post("/api/groups/:groupId/players/:playerId/elo", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Nothing to update." }, 400);
    const record = body;
    if (Object.keys(record).some((key) => key !== "elo" && key !== "reason"))
      return c.json({ error: "Nothing to update." }, 400);
    const elo = readElo(record.elo);
    if (elo === null)
      return c.json({ error: "Elo is a whole number from 100 to 1000." }, 400);
    if (record.reason !== undefined && (typeof record.reason !== "string" || record.reason.trim().length > MAX_REASON))
      return c.json({ error: "That reason is too long." }, 400);
    const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : "Manual elo edit";
    const db = c.get("db");
    const groupId = c.get("groupId");
    const id = c.req.param("playerId");
    const player = await db.prepare("SELECT id, elo FROM players WHERE id = ? AND group_id = ? AND deleted_at IS NULL").bind(id, groupId).first();
    if (!player)
      return c.json({ error: "Player not found." }, 404);
    await makeRoom(db, groupId);
    const position = await nextPosition(db, groupId);
    const now = Date.now();
    await db.prepare("INSERT INTO rating_events (id, owner_sub, group_id, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), c.get("user").sub, groupId, position, "adjust", JSON.stringify({ playerId: id, elo, reason }), now, now).run();
    const players = await recompute(db, groupId, position);
    await bumpRev(db, groupId).run();
    return c.json({
      player: players.find((entry) => entry.id === id) ?? null,
      players
    });
  });
  app.get("/api/groups/:groupId/matches", async (c) => {
    const db = c.get("db");
    const groupId = c.get("groupId");
    const squash = await db.prepare("SELECT removed, squashed_at FROM group_squashes WHERE group_id = ?").bind(groupId).first();
    return c.json({
      kFactor: await getKFactor(db, groupId),
      squashed: squash ? { removed: squash.removed, at: squash.squashed_at } : null,
      events: await matchViews(db, groupId)
    });
  });
  app.post("/api/groups/:groupId/matches", async (c) => {
    const body = await c.req.json().catch(() => null);
    const input = readMatchInput(body);
    if (!input)
      return c.json({ error: MATCH_ERROR }, 400);
    const db = c.get("db");
    const groupId = c.get("groupId");
    const tracked = input.teams.flatMap((team) => team.players.filter((player) => player.tracked).map((player) => player.id));
    if (!await trackedIdsExist(db, groupId, tracked))
      return c.json({ error: "Those players are no longer on this group's roster." }, 400);
    if (!await makeRoom(db, groupId))
      return c.json({ error: `The log holds ${MAX_EVENTS} events. Delete one to add another.` }, 400);
    const position = await nextPosition(db, groupId);
    const id = crypto.randomUUID();
    const now = Date.now();
    const kFactor = await getKFactor(db, groupId);
    await pinLegacyK(db, groupId, kFactor);
    const payload = {
      ...input,
      formula: FLAT_K_FORMULA,
      k: kFactor
    };
    await db.prepare("INSERT INTO rating_events (id, owner_sub, group_id, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, c.get("user").sub, groupId, position, "match", JSON.stringify(payload), now, now).run();
    const players = await recompute(db, groupId, position);
    await bumpRev(db, groupId).run();
    return c.json({ match: { id, position }, players }, 201);
  });
  app.patch("/api/groups/:groupId/matches/:matchId", async (c) => {
    const db = c.get("db");
    const groupId = c.get("groupId");
    const id = c.req.param("matchId");
    const row = await findEvent(db, groupId, id);
    if (!row || row.kind !== "match")
      return c.json({ error: "Match not found." }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Nothing to update." }, 400);
    const patch = body;
    if (Object.keys(patch).some((key) => key !== "input" && key !== "position") || Object.keys(patch).length === 0)
      return c.json({ error: "Nothing to update." }, 400);
    if ("position" in patch && (typeof patch.position !== "number" || !Number.isInteger(patch.position)))
      return c.json({ error: "That position is not valid." }, 400);
    let from = row.position;
    if ("input" in patch) {
      const input = readMatchInput(patch.input);
      if (!input)
        return c.json({ error: MATCH_ERROR }, 400);
      const tracked = input.teams.flatMap((team) => team.players.filter((player) => player.tracked).map((player) => player.id));
      if (!await trackedIdsExist(db, groupId, tracked, true))
        return c.json({ error: "Those players are no longer on this group's roster." }, 400);
      let marker = {};
      try {
        const existing = JSON.parse(row.payload);
        const version = eventFormula(existing);
        if (version !== 1) {
          marker = { formula: version };
          if (isKFactor(existing.k))
            marker.k = existing.k;
        }
      } catch {}
      const nextInput = { ...input, ...marker };
      await db.prepare("UPDATE rating_events SET payload = ?, updated_at = ? WHERE id = ? AND group_id = ?").bind(JSON.stringify(nextInput), Date.now(), id, groupId).run();
    }
    if ("position" in patch) {
      const all = await db.prepare("SELECT id FROM rating_events WHERE group_id = ? ORDER BY position ASC, created_at ASC, id ASC").bind(groupId).all();
      const ids = all.results.map((entry) => entry.id);
      const current = ids.indexOf(id);
      const target = Math.max(0, Math.min(ids.length - 1, Math.trunc(patch.position)));
      if (current !== -1 && target !== current) {
        ids.splice(current, 1);
        ids.splice(target, 0, id);
        from = Math.min(from, current, target);
        await db.batch(ids.map((eventId, index) => db.prepare("UPDATE rating_events SET position = ? WHERE id = ? AND group_id = ?").bind(index, eventId, groupId)));
      }
    }
    const players = await recompute(db, groupId, from);
    await bumpRev(db, groupId).run();
    return c.json({ ok: true, players });
  });
  app.delete("/api/groups/:groupId/matches/:matchId", async (c) => {
    const db = c.get("db");
    const groupId = c.get("groupId");
    const id = c.req.param("matchId");
    const row = await findEvent(db, groupId, id);
    if (!row)
      return c.json({ error: "Match not found." }, 404);
    await db.batch([
      db.prepare("DELETE FROM rating_results WHERE event_id = ? AND group_id = ?").bind(id, groupId),
      db.prepare("DELETE FROM rating_events WHERE id = ? AND group_id = ?").bind(id, groupId)
    ]);
    const players = await recompute(db, groupId, row.position);
    await bumpRev(db, groupId).run();
    return c.json({ ok: true, players });
  });
  app.get("/api/groups/:groupId/settings", async (c) => c.json({ kFactor: await getKFactor(c.get("db"), c.get("groupId")) }));
  app.put("/api/groups/:groupId/settings", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Nothing to update." }, 400);
    const kFactor = body.kFactor;
    if (!isKFactor(kFactor))
      return c.json({ error: "K must be a whole number from 8 to 64." }, 400);
    const db = c.get("db");
    const groupId = c.get("groupId");
    await pinLegacyK(db, groupId, await getKFactor(db, groupId));
    await db.batch([
      db.prepare("UPDATE groups SET k_factor = ?, updated_at = ? WHERE id = ?").bind(kFactor, Date.now(), groupId),
      bumpRev(db, groupId)
    ]);
    const tags = (await loadTags(db, groupId)).map((tag) => tag.id);
    return c.json({
      kFactor,
      players: await loadPlayers(db, groupId, tags)
    });
  });
  app.get("/api/groups/:groupId/rounds", async (c) => {
    const result = await c.get("db").prepare("SELECT id, config, created_at FROM rounds WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT 60").bind(c.get("groupId")).all();
    return c.json({
      rounds: result.results.map((row) => mapRound(row)).filter((round) => round !== null)
    });
  });
  app.notFound((c) => c.req.path === "/api" || c.req.path.startsWith("/api/") ? c.json({ error: "Endpoint not found." }, 404) : c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text("Not found", 404));
  app.onError((_error, c) => c.json({ error: "Something went wrong. Please try again." }, 500));
  return app;
}
async function loadInvite(db, token) {
  if (!token || token.length > 128)
    return null;
  const row = await db.prepare(`SELECT i.group_id, i.role, g.name FROM group_invites i
       JOIN groups g ON g.id = i.group_id
       WHERE i.token_hash = ? AND i.revoked_at IS NULL AND g.deleted_at IS NULL
         AND (i.expires_at IS NULL OR i.expires_at > ?)`).bind(await hashInviteToken(token), Date.now()).first();
  if (!row)
    return null;
  return {
    groupId: row.group_id,
    name: row.name,
    role: row.role === "editor" ? "editor" : "viewer"
  };
}

// server/vercel.ts
function connectDatabase(url, authToken) {
  try {
    return createLibsqlDatabase(url, authToken);
  } catch (error) {
    console.error("Teammaker: database connection failed", error);
    return;
  }
}
function readEnv() {
  const url = process.env.TURSO_DATABASE_URL;
  return {
    DB: url ? connectDatabase(url, process.env.TURSO_AUTH_TOKEN) : undefined,
    FREEBUFF_CLIENT_ID: process.env.FREEBUFF_CLIENT_ID,
    FREEBUFF_ISSUER: process.env.FREEBUFF_ISSUER,
    APP_ORIGIN: process.env.APP_ORIGIN
  };
}
var env;
var environment = () => env ??= readEnv();
var app = createApp();
async function handler(request) {
  try {
    const pass = (req) => Promise.resolve(app.fetch(req, environment()));
    const auth = getAuth(environment());
    return await (auth ? auth.wrap(pass)(request) : pass(request));
  } catch (error) {
    console.error("Teammaker: request failed", error);
    return Response.json({ error: "Sign-in setup is unavailable. Please try again later." }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
var config = { maxDuration: 30 };
var vercel_default = getRequestListener(handler);
export {
  config,
  vercel_default as default
};
