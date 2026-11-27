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
import { isSameOriginRequest } from "@freebuff/auth";
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
  if (payload.formula === PLACEMENT_FORMULA)
    return PLACEMENT_FORMULA;
  return payload.formula === RATING_FORMULA ? RATING_FORMULA : 1;
}
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
        const playerK = formula !== 1 && player.tracked ? provisionalK(kFactor, priorMatches?.get(player.id) ?? 0) : kFactor;
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
function normalizeTags(value) {
  if (!Array.isArray(value))
    return [];
  const chosen = new Set;
  for (const item of value)
    if (typeof item === "string")
      chosen.add(item);
  return ROLE_IDS.filter((id) => chosen.has(id));
}
var ROLE_BITS = new Map(ROLE_IDS.map((id, index) => [id, 1 << index]));
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
  `CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    skill INTEGER NOT NULL,
    elo INTEGER NOT NULL DEFAULT 0,
    base_elo INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    sitting_out INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS players_owner ON players(owner_sub, created_at ASC, id ASC)`,
  `CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS rounds_owner ON rounds(owner_sub, created_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS rating_events (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
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
  )`
];
var TAG_COLUMN = `ALTER TABLE players ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`;
var USERNAME_COLUMN = `ALTER TABLE players ADD COLUMN username TEXT NOT NULL DEFAULT ''`;
var ELO_COLUMN = `ALTER TABLE players ADD COLUMN elo INTEGER NOT NULL DEFAULT 0`;
var BASE_ELO_COLUMN = `ALTER TABLE players ADD COLUMN base_elo INTEGER NOT NULL DEFAULT 0`;
var TABLES = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('players', 'rounds', 'rating_events', 'rating_results', 'settings', 'rating_meta')`;
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
  if (missing.length > 0)
    await db.batch(missing.map((sql) => db.prepare(sql)));
  if (!names.has("elo") || !names.has("base_elo")) {
    await db.prepare("UPDATE players SET elo = skill * 100, base_elo = skill * 100 WHERE elo = 0").run();
  }
};
var bootstrap = async (db) => {
  const tables = await db.prepare(TABLES).all();
  if (tables.results.length < 6) {
    await db.batch(schema.map((sql) => db.prepare(sql)));
  }
  await ensureColumns(db);
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
var parseTags = (value) => {
  if (!value)
    return [];
  try {
    return normalizeTags(JSON.parse(value));
  } catch {
    return [];
  }
};
var mapPlayer = (row) => ({
  id: row.id,
  name: row.name,
  username: row.username ?? "",
  skill: skillFromElo(row.elo),
  elo: row.elo,
  tags: parseTags(row.tags),
  sittingOut: row.sitting_out === 1,
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

// src/worker/app.ts
var ROSTER_LIMIT = 200;
var MAX_BATCH = 50;
var MAX_ROUNDS = 100;
var MAX_LABEL = 60;
var MAX_REASON = 80;
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
var readTags = (value) => {
  if (value === undefined)
    return [];
  if (!Array.isArray(value) || value.length > ROLE_IDS.length)
    return null;
  for (const item of value)
    if (typeof item !== "string" || !ROLE_IDS.includes(item))
      return null;
  return normalizeTags(value);
};
function readDrafts(body) {
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
    const tags = readTags(entry.tags);
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
function readTeams(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8)
    return null;
  const teams = [];
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return null;
    const team = item;
    if (!Array.isArray(team.players) || team.players.length > ROSTER_LIMIT)
      return null;
    if (typeof team.sum !== "number" || !Number.isFinite(team.sum))
      return null;
    const players = [];
    for (const raw of team.players) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return null;
      const player = raw;
      if (typeof player.id !== "string" || player.id.length > 64)
        return null;
      const name = readName(player.name);
      const elo = readElo(player.elo);
      const tags = readTags(player.tags);
      if (!name || elo === null || !tags)
        return null;
      players.push({ id: player.id, name, elo, tags });
    }
    total += players.length;
    if (total > ROSTER_LIMIT * 2)
      return null;
    teams.push({ players, sum: team.sum });
  }
  return teams;
}
function readRoundConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  const config = value;
  if (Object.keys(config).some((key) => !["version", "teamCount", "tolerance", "spread", "teams", "benchedIds"].includes(key)))
    return null;
  if (config.version !== 2)
    return null;
  const { teamCount, tolerance, spread } = config;
  if (typeof teamCount !== "number" || !Number.isInteger(teamCount) || teamCount < 1 || teamCount > 8)
    return null;
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 5000)
    return null;
  if (typeof spread !== "number" || !Number.isFinite(spread) || spread < 0 || spread > 1e4)
    return null;
  const teams = readTeams(config.teams);
  if (!teams || teams.length !== teamCount)
    return null;
  const benchedIds = Array.isArray(config.benchedIds) ? config.benchedIds.filter((id) => typeof id === "string" && id.length <= 64).slice(0, ROSTER_LIMIT) : [];
  return { version: 2, teamCount, tolerance, spread, teams, benchedIds };
}
async function loadEvents(db, owner) {
  const rows = await db.prepare("SELECT id, position, kind, payload, created_at, updated_at FROM rating_events WHERE owner_sub = ? ORDER BY position ASC, created_at ASC, id ASC").bind(owner).all();
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
async function getKFactor(db, owner) {
  const row = await db.prepare("SELECT k_factor FROM settings WHERE owner_sub = ?").bind(owner).first();
  return row && isKFactor(row.k_factor) ? row.k_factor : DEFAULT_K_FACTOR;
}
async function getLegacyK(db, owner, currentK) {
  const row = await db.prepare("SELECT legacy_k FROM rating_meta WHERE owner_sub = ?").bind(owner).first();
  return row && isKFactor(row.legacy_k) ? row.legacy_k : currentK;
}
async function pinLegacyK(db, owner, legacyK) {
  await db.prepare("INSERT INTO rating_meta (owner_sub, legacy_k, created_at) VALUES (?, ?, ?) ON CONFLICT(owner_sub) DO NOTHING").bind(owner, legacyK, Date.now()).run();
}
async function loadPlayers(db, owner) {
  const result = await db.prepare("SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at FROM players WHERE owner_sub = ? ORDER BY created_at ASC, id ASC").bind(owner).all();
  return result.results.map(mapPlayer);
}
async function nextPosition(db, owner) {
  const row = await db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM rating_events WHERE owner_sub = ?").bind(owner).first();
  return row?.next ?? 0;
}
async function findEvent(db, owner, id) {
  return db.prepare("SELECT id, position, kind, payload, created_at, updated_at FROM rating_events WHERE id = ? AND owner_sub = ?").bind(id, owner).first();
}
var insertResultSql = "INSERT INTO rating_results (event_id, owner_sub, slot, player_id, name, elo_before, elo_after, delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
async function recompute(db, owner, from) {
  const players = await db.prepare("SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at, base_elo FROM players WHERE owner_sub = ? ORDER BY created_at ASC, id ASC").bind(owner).all();
  const events = await loadEvents(db, owner);
  const kFactor = await getKFactor(db, owner);
  const legacyK = await getLegacyK(db, owner, kFactor);
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
      statements.push(db.prepare("UPDATE players SET elo = ?, skill = ? WHERE id = ? AND owner_sub = ?").bind(elo, skill, player.id, owner));
  }
  statements.push(db.prepare("DELETE FROM rating_results WHERE owner_sub = ? AND event_id IN (SELECT id FROM rating_events WHERE owner_sub = ? AND position >= ?)").bind(owner, owner, from));
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
          statements.push(db.prepare(insertResultSql).bind(event.id, owner, `${teamIndex}:${slot}`, player.id, player.name, player.eloBefore, player.eloAfter, player.delta));
        });
      });
      continue;
    }
    const { playerId, eloBefore, eloAfter } = outcome.result;
    statements.push(db.prepare(insertResultSql).bind(event.id, owner, "0", playerId, names.get(playerId) ?? "", eloBefore, eloAfter, eloAfter - eloBefore));
  }
  if (statements.length > 0)
    await db.batch(statements);
  return players.results.map((player) => mapPlayer({
    ...player,
    elo: elos.get(player.id) ?? player.elo,
    skill: skillFromElo(elos.get(player.id) ?? player.elo)
  }));
}
async function matchViews(db, owner) {
  const events = await loadEvents(db, owner);
  const rows = await db.prepare("SELECT event_id, slot, player_id, name, elo_before, elo_after, delta FROM rating_results WHERE owner_sub = ?").bind(owner).all();
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
async function trackedIdsExist(db, owner, ids) {
  if (ids.length === 0)
    return true;
  const rows = await db.prepare(`SELECT id FROM players WHERE owner_sub = ? AND id IN (${ids.map(() => "?").join(", ")})`).bind(owner, ...ids).all();
  return rows.results.length === new Set(ids).size;
}
function createApp(authenticate = currentUser) {
  const app = new Hono;
  app.get("/api/health", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const db = c.env.DB;
    if (!db)
      return c.json({ ok: true, database: "unconfigured" });
    try {
      await db.prepare("SELECT 1 AS ok").first();
      const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('players', 'rounds', 'rating_events', 'rating_results', 'settings', 'rating_meta')").all();
      return c.json({
        ok: true,
        database: "ok",
        schema: tables.results.length === 6 ? "ready" : "missing"
      });
    } catch (error) {
      console.error("Teammaker: database health check failed", error instanceof Error ? error.message : error);
      return c.json({ ok: false, database: "unreachable" }, 503);
    }
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  app.use("/api/*", bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: "Request is too large." }, 413)
  }));
  app.get("/api/session", async (c) => c.json({
    user: await authenticate(c.req.raw, c.env),
    mode: isLocalPreview(c.req.raw, c.env) ? "local" : c.env.FREEBUFF_CLIENT_ID && c.env.APP_ORIGIN ? "freebuff" : "setup",
    database: Boolean(c.env.DB)
  }));
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health" || c.req.path === "/api/session")
      return next();
    const user = await authenticate(c.req.raw, c.env);
    if (!user)
      return c.json({ error: "Sign in required." }, 401);
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = appOrigin(c.req.raw, c.env);
      if (!origin || !isSameOriginRequest(c.req.raw, origin))
        return c.json({ error: "Cross-origin request refused." }, 403);
    }
    if (!c.env.DB)
      return c.json({ error: "This app is still being set up. Please try again later." }, 503);
    await ensureSchema(c.env.DB);
    c.set("user", user);
    c.set("db", c.env.DB);
    await next();
  });
  app.get("/api/players", async (c) => c.json({ players: await loadPlayers(c.get("db"), c.get("user").sub) }));
  app.post("/api/players", async (c) => {
    const body = await c.req.json().catch(() => null);
    const drafts = readDrafts(body);
    if (!drafts)
      return c.json({ error: "Each player needs a name and a skill from 1 to 10." }, 400);
    const db = c.get("db");
    const owner = c.get("user").sub;
    const existing = await db.prepare("SELECT COUNT(*) AS total FROM players WHERE owner_sub = ?").bind(owner).first();
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
      sittingOut: false,
      createdAt: createdAt + index,
      updatedAt: createdAt + index
    }));
    await db.batch(players.map((player) => db.prepare("INSERT INTO players (id, owner_sub, name, username, skill, elo, base_elo, tags, sitting_out, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)").bind(player.id, owner, player.name, player.username ?? "", player.skill, player.elo, player.elo, JSON.stringify(player.tags), player.createdAt, player.updatedAt)));
    return c.json({ players }, 201);
  });
  app.patch("/api/players/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Nothing to update." }, 400);
    const patch = body;
    if (Object.keys(patch).some((key) => !["name", "username", "skill", "elo", "tags", "sittingOut"].includes(key)))
      return c.json({ error: "Nothing to update." }, 400);
    const id = c.req.param("id");
    const db = c.get("db");
    const owner = c.get("user").sub;
    const current = await db.prepare("SELECT id, elo FROM players WHERE id = ? AND owner_sub = ?").bind(id, owner).first();
    if (!current)
      return c.json({ error: "Player not found." }, 404);
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
      const history = await db.prepare("SELECT COUNT(*) AS total FROM rating_results WHERE owner_sub = ? AND player_id = ?").bind(owner, id).first();
      logAdjustment = (history?.total ?? 0) > 0;
      if (!logAdjustment) {
        sets.push("base_elo = ?");
        values.push(targetElo);
      }
    }
    if ("tags" in patch) {
      const tags = readTags(patch.tags);
      if (!tags)
        return c.json({ error: "Those roles are not recognised." }, 400);
      sets.push("tags = ?");
      values.push(JSON.stringify(tags));
    }
    if ("sittingOut" in patch) {
      if (typeof patch.sittingOut !== "boolean")
        return c.json({ error: "Sitting out must be true or false." }, 400);
      sets.push("sitting_out = ?");
      values.push(patch.sittingOut ? 1 : 0);
    }
    if (sets.length === 0)
      return c.json({ error: "Nothing to update." }, 400);
    sets.push("updated_at = ?");
    values.push(Date.now(), id, owner);
    await db.prepare(`UPDATE players SET ${sets.join(", ")} WHERE id = ? AND owner_sub = ?`).bind(...values).run();
    if (targetElo !== null && logAdjustment && targetElo !== current.elo) {
      const position = await nextPosition(db, owner);
      const now = Date.now();
      await db.prepare("INSERT INTO rating_events (id, owner_sub, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), owner, position, "adjust", JSON.stringify({ playerId: id, elo: targetElo, reason }), now, now).run();
      const players = await recompute(db, owner, position);
      return c.json({ player: players.find((entry) => entry.id === id) ?? null });
    }
    const row = await db.prepare("SELECT id, name, username, skill, elo, tags, sitting_out, created_at, updated_at FROM players WHERE id = ? AND owner_sub = ?").bind(id, owner).first();
    return row ? c.json({ player: mapPlayer(row) }) : c.json({ error: "Player not found." }, 404);
  });
  app.delete("/api/players/:id", async (c) => {
    const db = c.get("db");
    const owner = c.get("user").sub;
    const id = c.req.param("id");
    const player = await db.prepare("SELECT id FROM players WHERE id = ? AND owner_sub = ?").bind(id, owner).first();
    if (!player)
      return c.json({ error: "Player not found." }, 404);
    const matches = await db.prepare(`SELECT COUNT(*) AS total FROM rating_results r
         JOIN rating_events e ON e.id = r.event_id AND e.owner_sub = r.owner_sub
         WHERE r.owner_sub = ? AND r.player_id = ? AND e.kind = 'match'`).bind(owner, id).first();
    if ((matches?.total ?? 0) > 0)
      return c.json({
        error: "This player has match history. Delete or edit those matches before removing them."
      }, 409);
    const edits = await db.prepare("SELECT DISTINCT event_id FROM rating_results WHERE owner_sub = ? AND player_id = ?").bind(owner, id).all();
    const eventIds = edits.results.map((row) => row.event_id);
    const statements = [];
    if (eventIds.length > 0) {
      const marks = eventIds.map(() => "?").join(", ");
      statements.push(db.prepare(`DELETE FROM rating_results WHERE owner_sub = ? AND event_id IN (${marks})`).bind(owner, ...eventIds), db.prepare(`DELETE FROM rating_events WHERE owner_sub = ? AND id IN (${marks})`).bind(owner, ...eventIds));
    }
    statements.push(db.prepare("DELETE FROM players WHERE id = ? AND owner_sub = ?").bind(id, owner));
    await db.batch(statements);
    return c.json({ ok: true });
  });
  app.post("/api/players/:id/elo", async (c) => {
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
    const owner = c.get("user").sub;
    const id = c.req.param("id");
    const player = await db.prepare("SELECT id, elo FROM players WHERE id = ? AND owner_sub = ?").bind(id, owner).first();
    if (!player)
      return c.json({ error: "Player not found." }, 404);
    const position = await nextPosition(db, owner);
    const now = Date.now();
    await db.prepare("INSERT INTO rating_events (id, owner_sub, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), owner, position, "adjust", JSON.stringify({ playerId: id, elo, reason }), now, now).run();
    const players = await recompute(db, owner, position);
    return c.json({
      player: players.find((entry) => entry.id === id) ?? null,
      players
    });
  });
  app.get("/api/matches", async (c) => {
    const db = c.get("db");
    const owner = c.get("user").sub;
    return c.json({
      kFactor: await getKFactor(db, owner),
      events: await matchViews(db, owner)
    });
  });
  app.post("/api/matches", async (c) => {
    const body = await c.req.json().catch(() => null);
    const input = readMatchInput(body);
    if (!input)
      return c.json({
        error: MATCH_ERROR
      }, 400);
    const db = c.get("db");
    const owner = c.get("user").sub;
    const tracked = input.teams.flatMap((team) => team.players.filter((player) => player.tracked).map((player) => player.id));
    if (!await trackedIdsExist(db, owner, tracked))
      return c.json({ error: "Those players are no longer on your roster." }, 400);
    const count = await db.prepare("SELECT COUNT(*) AS total FROM rating_events WHERE owner_sub = ?").bind(owner).first();
    if ((count?.total ?? 0) >= MAX_EVENTS)
      return c.json({ error: `The log holds ${MAX_EVENTS} events. Delete one to add another.` }, 400);
    const position = await nextPosition(db, owner);
    const id = crypto.randomUUID();
    const now = Date.now();
    const kFactor = await getKFactor(db, owner);
    await pinLegacyK(db, owner, kFactor);
    const payload = {
      ...input,
      formula: RATING_FORMULA,
      k: kFactor
    };
    await db.prepare("INSERT INTO rating_events (id, owner_sub, position, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, owner, position, "match", JSON.stringify(payload), now, now).run();
    const players = await recompute(db, owner, position);
    return c.json({ match: { id, position }, players }, 201);
  });
  app.patch("/api/matches/:id", async (c) => {
    const db = c.get("db");
    const owner = c.get("user").sub;
    const id = c.req.param("id");
    const row = await findEvent(db, owner, id);
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
      if (!await trackedIdsExist(db, owner, tracked))
        return c.json({ error: "Those players are no longer on your roster." }, 400);
      let marker = {};
      try {
        const existing = JSON.parse(row.payload);
        if (existing.formula === 2) {
          marker = { formula: 2 };
          if (isKFactor(existing.k))
            marker.k = existing.k;
        }
      } catch {}
      const nextInput = { ...input, ...marker };
      await db.prepare("UPDATE rating_events SET payload = ?, updated_at = ? WHERE id = ? AND owner_sub = ?").bind(JSON.stringify(nextInput), Date.now(), id, owner).run();
    }
    if ("position" in patch) {
      const all = await db.prepare("SELECT id FROM rating_events WHERE owner_sub = ? ORDER BY position ASC, created_at ASC, id ASC").bind(owner).all();
      const ids = all.results.map((entry) => entry.id);
      const current = ids.indexOf(id);
      const target = Math.max(0, Math.min(ids.length - 1, Math.trunc(patch.position)));
      if (current !== -1 && target !== current) {
        ids.splice(current, 1);
        ids.splice(target, 0, id);
        from = Math.min(from, current, target);
        await db.batch(ids.map((eventId, index) => db.prepare("UPDATE rating_events SET position = ? WHERE id = ? AND owner_sub = ?").bind(index, eventId, owner)));
      }
    }
    const players = await recompute(db, owner, from);
    return c.json({ ok: true, players });
  });
  app.delete("/api/matches/:id", async (c) => {
    const db = c.get("db");
    const owner = c.get("user").sub;
    const id = c.req.param("id");
    const row = await findEvent(db, owner, id);
    if (!row)
      return c.json({ error: "Match not found." }, 404);
    await db.batch([
      db.prepare("DELETE FROM rating_results WHERE event_id = ? AND owner_sub = ?").bind(id, owner),
      db.prepare("DELETE FROM rating_events WHERE id = ? AND owner_sub = ?").bind(id, owner)
    ]);
    const players = await recompute(db, owner, row.position);
    return c.json({ ok: true, players });
  });
  app.get("/api/settings", async (c) => c.json({ kFactor: await getKFactor(c.get("db"), c.get("user").sub) }));
  app.put("/api/settings", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Nothing to update." }, 400);
    const kFactor = body.kFactor;
    if (!isKFactor(kFactor))
      return c.json({ error: "K must be a whole number from 8 to 64." }, 400);
    const db = c.get("db");
    const owner = c.get("user").sub;
    await pinLegacyK(db, owner, await getKFactor(db, owner));
    await db.prepare("INSERT INTO settings (owner_sub, k_factor, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_sub) DO UPDATE SET k_factor = excluded.k_factor, updated_at = excluded.updated_at").bind(owner, kFactor, Date.now()).run();
    const players = await loadPlayers(db, owner);
    return c.json({ kFactor, players });
  });
  app.get("/api/rounds", async (c) => {
    const result = await c.get("db").prepare("SELECT id, config, created_at FROM rounds WHERE owner_sub = ? ORDER BY created_at DESC, id DESC LIMIT 60").bind(c.get("user").sub).all();
    return c.json({
      rounds: result.results.map((row) => mapRound(row)).filter((round) => round !== null)
    });
  });
  app.post("/api/rounds", async (c) => {
    const body = await c.req.json().catch(() => null);
    const config = body && typeof body === "object" && !Array.isArray(body) ? readRoundConfig(body.config) : null;
    if (!config)
      return c.json({ error: "That round's teams could not be saved." }, 400);
    const db = c.get("db");
    const owner = c.get("user").sub;
    const round = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      config
    };
    await db.prepare("INSERT INTO rounds (id, owner_sub, config, created_at) VALUES (?, ?, ?, ?)").bind(round.id, owner, JSON.stringify(config), round.createdAt).run();
    await db.prepare("DELETE FROM rounds WHERE owner_sub = ? AND id NOT IN (SELECT id FROM rounds WHERE owner_sub = ? ORDER BY created_at DESC, id DESC LIMIT ?)").bind(owner, owner, MAX_ROUNDS).run();
    return c.json({ round }, 201);
  });
  app.delete("/api/rounds/:id", async (c) => {
    const removed = await c.get("db").prepare("DELETE FROM rounds WHERE id = ? AND owner_sub = ? RETURNING id").bind(c.req.param("id"), c.get("user").sub).first();
    return removed ? c.json({ ok: true }) : c.json({ error: "Round not found." }, 404);
  });
  app.notFound((c) => c.req.path === "/api" || c.req.path.startsWith("/api/") ? c.json({ error: "Endpoint not found." }, 404) : c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text("Not found", 404));
  app.onError((_error, c) => c.json({ error: "Something went wrong. Please try again." }, 500));
  return app;
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
