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
    skill INTEGER NOT NULL,
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
  `CREATE INDEX IF NOT EXISTS rounds_owner ON rounds(owner_sub, created_at DESC, id DESC)`
];
var TAG_COLUMN = `ALTER TABLE players ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`;
var TABLES = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('players', 'rounds')`;
var COLUMNS = "SELECT name FROM pragma_table_info('players')";
var ensureTags = async (db) => {
  const columns = await db.prepare(COLUMNS).all();
  if (!columns.results.some((column) => column.name === "tags"))
    await db.prepare(TAG_COLUMN).run();
};
var bootstrap = async (db) => {
  const tables = await db.prepare(TABLES).all();
  if (tables.results.length < 2) {
    await db.batch(schema.map((sql) => db.prepare(sql)));
    await ensureTags(db);
    return;
  }
  await ensureTags(db);
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
  skill: row.skill,
  tags: parseTags(row.tags),
  sittingOut: row.sitting_out === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});
var mapRound = (row) => {
  try {
    const config = JSON.parse(row.config);
    if (!config || !Array.isArray(config.teams))
      return null;
    return {
      id: row.id,
      createdAt: row.created_at,
      config: {
        ...config,
        teams: config.teams.map((team) => ({
          ...team,
          players: (team.players ?? []).map((player) => ({
            ...player,
            tags: normalizeTags(player.tags)
          }))
        }))
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
var readName = (value) => {
  if (typeof value !== "string")
    return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 40 ? name : null;
};
var readSkill = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10 ? value : null;
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
    if (Object.keys(entry).some((key) => key !== "name" && key !== "skill" && key !== "tags"))
      return null;
    const name = readName(entry.name);
    const skill = readSkill(entry.skill);
    const tags = readTags(entry.tags);
    if (!name || skill === null || !tags)
      return null;
    drafts.push({ name, skill, tags });
  }
  return drafts;
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
      const skill = readSkill(player.skill);
      const tags = readTags(player.tags);
      if (!name || skill === null || !tags)
        return null;
      players.push({ id: player.id, name, skill, tags });
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
  if (Object.keys(config).some((key) => !["teamCount", "tolerance", "spread", "teams", "benchedIds"].includes(key)))
    return null;
  const { teamCount, tolerance, spread } = config;
  if (typeof teamCount !== "number" || !Number.isInteger(teamCount) || teamCount < 1 || teamCount > 8)
    return null;
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100)
    return null;
  if (typeof spread !== "number" || !Number.isFinite(spread) || spread < 0 || spread > 500)
    return null;
  const teams = readTeams(config.teams);
  if (!teams || teams.length !== teamCount)
    return null;
  const benchedIds = Array.isArray(config.benchedIds) ? config.benchedIds.filter((id) => typeof id === "string" && id.length <= 64).slice(0, ROSTER_LIMIT) : [];
  return { teamCount, tolerance, spread, teams, benchedIds };
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
      const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('players', 'rounds')").all();
      return c.json({
        ok: true,
        database: "ok",
        schema: tables.results.length === 2 ? "ready" : "missing"
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
  app.get("/api/players", async (c) => {
    const result = await c.get("db").prepare("SELECT id, name, skill, tags, sitting_out, created_at, updated_at FROM players WHERE owner_sub = ? ORDER BY created_at ASC, id ASC").bind(c.get("user").sub).all();
    return c.json({ players: result.results.map(mapPlayer) });
  });
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
      skill: draft.skill,
      tags: draft.tags,
      sittingOut: false,
      createdAt: createdAt + index,
      updatedAt: createdAt + index
    }));
    await db.batch(players.map((player) => db.prepare("INSERT INTO players (id, owner_sub, name, skill, tags, sitting_out, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)").bind(player.id, owner, player.name, player.skill, JSON.stringify(player.tags), player.createdAt, player.updatedAt)));
    return c.json({ players }, 201);
  });
  app.patch("/api/players/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Nothing to update." }, 400);
    const patch = body;
    if (Object.keys(patch).some((key) => !["name", "skill", "tags", "sittingOut"].includes(key)))
      return c.json({ error: "Nothing to update." }, 400);
    const sets = [];
    const values = [];
    if ("name" in patch) {
      const name = readName(patch.name);
      if (!name)
        return c.json({ error: "Names are 1 to 40 characters." }, 400);
      sets.push("name = ?");
      values.push(name);
    }
    if ("skill" in patch) {
      const skill = readSkill(patch.skill);
      if (skill === null)
        return c.json({ error: "Skills are whole numbers from 1 to 10." }, 400);
      sets.push("skill = ?");
      values.push(skill);
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
    values.push(Date.now(), c.req.param("id"), c.get("user").sub);
    const row = await c.get("db").prepare(`UPDATE players SET ${sets.join(", ")} WHERE id = ? AND owner_sub = ? RETURNING id, name, skill, tags, sitting_out, created_at, updated_at`).bind(...values).first();
    return row ? c.json({ player: mapPlayer(row) }) : c.json({ error: "Player not found." }, 404);
  });
  app.delete("/api/players/:id", async (c) => {
    const removed = await c.get("db").prepare("DELETE FROM players WHERE id = ? AND owner_sub = ? RETURNING id").bind(c.req.param("id"), c.get("user").sub).first();
    return removed ? c.json({ ok: true }) : c.json({ error: "Player not found." }, 404);
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
