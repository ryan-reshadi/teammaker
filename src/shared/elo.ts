/**
 * Pure, deterministic rating maths. No React, no DOM, no database — the same
 * module runs in the browser, in the Worker and in tests.
 *
 * Scale: 100 - 1000, where 100 points is one point on the old 1-10 control.
 * A player's elo is the only stored rating; `skill` is a derived mirror.
 */

export const ELO_MIN = 100
export const ELO_MAX = 1000
export const ELO_PER_SKILL = 100

export const DEFAULT_K_FACTOR = 32
export const MIN_K_FACTOR = 8
export const MAX_K_FACTOR = 64
/** New events carry this marker and their own K; unmarked events are v1. */
export const RATING_FORMULA = 2
/**
 * Placement-aware result term: a team is rated on where it finished instead of
 * on the winner flag alone. Nothing writes this marker yet, so the gate can read
 * it without changing how any stored event replays.
 */
export const PLACEMENT_FORMULA = 3
/**
 * Flat-K formula: the account K applies to every rated match, with no
 * provisional window. Events written before it carry 2 (or 3) and keep the
 * doubled K they were rated with, so their stored ratings replay unchanged.
 */
export const FLAT_K_FORMULA = 4
export const PROVISIONAL_MATCHES = 5
export const PROVISIONAL_K_MULTIPLIER = 2
/** The event log is a bookkeeping aid, not an archive; this bounds a replay. */
export const MAX_EVENTS = 1000
export const MAX_MATCH_PLAYERS = 10
export const MAX_MATCH_TEAMS = 8
export const MAX_DAMAGE = 100_000

/** How much of a player's performance swing the update carries. */
const PERFORMANCE_WEIGHT = 0.6
/** Softness of the log-share curve: higher spreads the same residual flatter. */
const PERFORMANCE_TAU = 0.7
/** An unknown player pulls the rating expectation at half a tracked player's weight. */
export const RANDOM_WEIGHT = 0.5
/** How far a random's damage can move their estimated rating from the lobby average. */
const RANDOM_SWING = 200

export const clampElo = (value: number): number => {
  if (!Number.isFinite(value)) return ELO_MIN
  return Math.min(ELO_MAX, Math.max(ELO_MIN, Math.round(value)))
}

/** The 1-10 control mirrors the elo band; 100 points is one point. */
export const skillFromElo = (elo: number): number =>
  Math.min(10, Math.max(1, Math.round(clampElo(elo) / ELO_PER_SKILL)))

export const eloFromSkill = (skill: number): number =>
  clampElo(Math.round(skill) * ELO_PER_SKILL)

export const isKFactor = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= MIN_K_FACTOR &&
  value <= MAX_K_FACTOR

/**
 * The pre-v4 provisional window: the first few rated matches used double K,
 * capped at the same maximum as the account setting. Only events written before
 * `FLAT_K_FORMULA` read this, so history replays exactly as it was rated; every
 * new match uses the account K as set. Adjustments never count.
 */
export function provisionalK(baseK: number, matchesPlayed: number): number {
  const k = isKFactor(baseK) ? baseK : DEFAULT_K_FACTOR
  return matchesPlayed < PROVISIONAL_MATCHES
    ? Math.min(MAX_K_FACTOR, k * PROVISIONAL_K_MULTIPLIER)
    : k
}

/**
 * Win shares from weighted team strengths. Two teams reduce to ordinary Elo;
 * with more teams every pair is measured and the expectations share out one
 * win, so the field stays zero-sum.
 */
export function expectationsFromStrengths(strengths: number[]): number[] {
  if (strengths.length === 0) return []
  if (strengths.length === 1) return [1]
  const versus = strengths.map((value, index) =>
    strengths.map((other, otherIndex) =>
      otherIndex === index ? 0 : 1 / (1 + 10 ** ((other - value) / 400)),
    ),
  )
  const totals = versus.map((row) => row.reduce((sum, value) => sum + value, 0))
  const total = totals.reduce((sum, value) => sum + value, 0)
  if (!(total > 0)) return strengths.map(() => 1 / strengths.length)
  return totals.map((value) => value / total)
}

/**
 * The middle value of a list; an even-length list averages its two middles. Used
 * as the lobby's damage reference, so half the field sits above it and half
 * below it whatever the spread.
 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

/**
 * The share of the finished field each team took, from its place (1 is first;
 * equal places are a tie). Every pair of teams hands out one point, split when
 * the two tied, so the shares always sum to one and the result term stays
 * zero-sum against the expectations whatever the field size. Two teams reduce
 * to a plain win (1) and loss (0), which is exactly the old outcome.
 */
export function placementScores(places: readonly number[]): number[] {
  const pairs = (places.length * (places.length - 1)) / 2
  if (pairs === 0) return places.map(() => 0)
  return places.map((place, index) => {
    const taken = places.reduce((sum, other, otherIndex) => {
      if (otherIndex === index) return sum
      if (place === other) return sum + 0.5
      return sum + (place < other ? 1 : 0)
    }, 0)
    return taken / pairs
  })
}

/** One whole place per team, from 1 to the size of the field. */
export function isPlacement(places: unknown, teams: number): places is number[] {
  return (
    Array.isArray(places) &&
    places.length === teams &&
    places.every(
      (place) =>
        typeof place === 'number' &&
        Number.isInteger(place) &&
        place >= 1 &&
        place <= teams,
    )
  )
}

/**
 * The formula an event was rated with. Only an explicit v3 marker turns on the
 * placement term: an event that carries places without it replays exactly as
 * it always did, which is what keeps every stored rating unchanged.
 */
export function eventFormula(payload: MatchInput): 1 | 2 | 3 | 4 {
  if (payload.formula === FLAT_K_FORMULA) return FLAT_K_FORMULA
  if (payload.formula === PLACEMENT_FORMULA) return PLACEMENT_FORMULA
  return payload.formula === RATING_FORMULA ? RATING_FORMULA : 1
}

export type MatchPlayerInput = {
  /** A roster id for a tracked player, or a client key for a random. */
  id: string
  name: string
  damage: number
  tracked: boolean
}

export type MatchTeamInput = { players: MatchPlayerInput[] }

export type MatchInput = {
  label: string
  /** Two to `MAX_MATCH_TEAMS` teams, in display order. */
  teams: MatchTeamInput[]
  /** Index of the winning team. */
  winner: number
  /**
   * Server-stamped rating formula. Absent on every event written before
   * versioning existed, which is how a replay knows to use the frozen legacy K.
   * Only the placement formula reads the finishing order below, and only the
   * pre-v4 formulas read the provisional window.
   */
  formula?: 2 | 3 | 4
  /**
   * Finishing place per team, 1 for first; equal values are a tie. Ignored
   * unless the event carries the placement formula.
   */
  places?: number[]
  /** Server-stamped base K for this event. */
  k?: number
}

export type MatchPlayerResult = {
  /** Roster id for a tracked player, null for a random. */
  id: string | null
  name: string
  damage: number
  tracked: boolean
  /** Rating used for the expectation: the player's elo, or a random's estimate. */
  elo: number
  eloBefore: number
  eloAfter: number
  delta: number
}

export type MatchTeamResult = { players: MatchPlayerResult[] }

export type MatchResult = {
  teams: MatchTeamResult[]
  winner: number
  /** Expected win probability for each team, from the weighted rating sums. */
  expected: number[]
}

export type AdjustInput = { playerId: string; elo: number; reason: string }

export type RatingEvent =
  | {
      id: string
      position: number
      kind: 'match'
      createdAt: number
      updatedAt: number
      payload: MatchInput
    }
  | {
      id: string
      position: number
      kind: 'adjust'
      createdAt: number
      updatedAt: number
      payload: AdjustInput
    }

export type MatchOutcome = { eventId: string; kind: 'match'; result: MatchResult }

export type AdjustOutcome = {
  eventId: string
  kind: 'adjust'
  result: { playerId: string; eloBefore: number; eloAfter: number }
}

export type RatingOutcome = MatchOutcome | AdjustOutcome

export type EloRosterPlayer = { id: string; name: string; elo: number }

export type ReplayResult = {
  /** Final elo for every roster player, including those in no event. */
  elos: Map<string, number>
  /** Per-event bookkeeping, keyed by event id. */
  outcomes: Map<string, RatingOutcome>
}

/** One row of the match log as the client sees it. */
export type MatchEventView = {
  id: string
  kind: 'match'
  position: number
  createdAt: number
  updatedAt: number
  label: string
  winner: number
  teams: { players: MatchPlayerResult[] }[]
}

export type AdjustEventView = {
  id: string
  kind: 'adjust'
  position: number
  createdAt: number
  updatedAt: number
  playerId: string
  name: string
  reason: string
  eloBefore: number
  eloAfter: number
  delta: number
}

export type RatingEventView = MatchEventView | AdjustEventView

export type MatchesResponse = { kFactor: number; events: RatingEventView[] }

export type MatchRoster = {
  id: string
  name: string
  /** Elo at creation. A replay starts here and applies every event in order. */
  baseElo: number
}

/** The weighted mean elo of the tracked players in the match. */
function knownAverage(teams: MatchTeamInput[], ratings: ReadonlyMap<string, number>): number {
  let total = 0
  let count = 0
  for (const team of teams) {
    for (const player of team.players) {
      if (!player.tracked) continue
      const elo = ratings.get(player.id)
      if (elo === undefined) continue
      total += elo
      count++
    }
  }
  return count > 0 ? total / count : (ELO_MIN + ELO_MAX) / 2
}

/**
 * A random has no rating, so the match's known elos set the baseline and their
 * relative damage moves it: double the tracked average damage is worth about
 * +150 elo, half is about -150, and it never leaves the scale.
 */
export function estimateRandomElo(
  averageKnown: number,
  damagePerEnemy: number,
  trackedDamagePerEnemy: number,
): number {
  if (damagePerEnemy <= 0) return clampElo(averageKnown - RANDOM_SWING)
  const factor =
    trackedDamagePerEnemy > 0 ? damagePerEnemy / trackedDamagePerEnemy : 1
  const shift = RANDOM_SWING * Math.tanh(Math.log(Math.max(factor, 1e-6)) / PERFORMANCE_TAU)
  return clampElo(averageKnown + shift)
}

/**
 * Rates one match from the current ratings, for two to `MAX_MATCH_TEAMS` teams.
 *
 * The result term is ordinary Elo on the weighted rating sums, so a five-stack
 * is favoured over a four-stack. With more than two teams each team is measured
 * against every other team and the expectations are normalized to share out one
 * win, so the field is zero-sum and a three-way lobby does not deflate ratings.
 * The performance term is centred on zero and compares each player's share of
 * the match's (size-normalized) damage with the share their rating predicts, so
 * a strong player on a losing team nets close to nothing instead of the full
 * loss. Damage is also measured against the entire lobby: out-damaging more than
 * half of everyone in the match is a floor on the term, so a bottom fragger on
 * the winning team who still beat most of the field is never treated as a
 * below-par performer and does not lose rating for it.
 *
 * A placement event rates each team on its place instead of the winner flag: the
 * result term becomes the share of the field that team finished above, so second
 * of three against equals is one win and one loss, which is exactly par.
 */
export function rateMatch(
  input: MatchInput,
  ratings: ReadonlyMap<string, number>,
  kFactor: number,
  options: {
    formula?: 1 | 2 | 3 | 4
    /** Tracked matches played before this event, for the pre-v4 provisional K. */
    priorMatches?: ReadonlyMap<string, number>
  } = {},
): { result: MatchResult; updates: Map<string, number> } {
  const teams = input.teams
  const updates = new Map<string, number>()
  const formula = options.formula ?? 1
  const priorMatches = options.priorMatches
  if (
    teams.length < 2 ||
    teams.length > MAX_MATCH_TEAMS ||
    teams.some((team) => team.players.length === 0) ||
    !Number.isInteger(input.winner) ||
    input.winner < 0 ||
    input.winner >= teams.length
  )
    return { result: { teams: [], winner: input.winner, expected: [] }, updates }

  const sizes = teams.map((team) => team.players.length)
  // A player faces everyone outside their own team, so with two teams this is
  // simply the other team's size.
  const enemiesFaced = sizes.map((_size, index) =>
    sizes.reduce((sum, size, other) => (other === index ? sum : sum + size), 0),
  )
  const averageKnown = knownAverage(teams, ratings)

  const damagePerEnemy = teams.map((team, index) =>
    team.players.map((player) => player.damage / Math.max(1, enemiesFaced[index]!)),
  )
  const trackedDamage = teams.flatMap((team, index) =>
    team.players
      .map((player, slot) => (player.tracked ? damagePerEnemy[index]![slot]! : null))
      .filter((value): value is number => value !== null),
  )
  const trackedAverage =
    trackedDamage.length > 0
      ? trackedDamage.reduce((sum, value) => sum + value, 0) / trackedDamage.length
      : 1

  const weights = teams.map((team) =>
    team.players.map((player) => (player.tracked ? 1 : RANDOM_WEIGHT)),
  )
  const elos = teams.map((team, index) =>
    team.players.map((player, slot) => {
      if (!player.tracked) {
        return estimateRandomElo(
          averageKnown,
          damagePerEnemy[index]![slot]!,
          trackedAverage,
        )
      }
      const rating = ratings.get(player.id)
      return rating === undefined ? clampElo(averageKnown) : clampElo(rating)
    }),
  )

  const strength = teams.map((team, index) =>
    team.players.reduce(
      (sum, _player, slot) => sum + weights[index]![slot]! * elos[index]![slot]!,
      0,
    ),
  )
  // Each team's head-to-head win chance against every other team, summed over
  // the field and normalized so the expectations share out one win between
  // them. For two teams the pair already sums to 1, which keeps the ordinary
  // Elo expectation exactly.
  const expected = expectationsFromStrengths(strength)
  // A placement event replaces the winner flag with the share of the field each
  // team finished above. Without a usable order it keeps the old term rather
  // than failing the replay.
  const placed =
    formula === PLACEMENT_FORMULA && isPlacement(input.places, teams.length)
      ? placementScores(input.places)
      : null

  const pool = teams.reduce(
    (sum, team, index) =>
      sum +
      team.players.reduce(
        (teamSum, _player, slot) =>
          teamSum + weights[index]![slot]! * damagePerEnemy[index]![slot]!,
        0,
      ),
    0,
  )
  const weightTotal = weights.flat().reduce((sum, weight) => sum + weight, 0)
  const ratingTotal = teams.reduce(
    (sum, team, index) =>
      sum +
      team.players.reduce(
        (teamSum, _player, slot) => teamSum + weights[index]![slot]! * elos[index]![slot]!,
        0,
      ),
    0,
  )

  // The middle damage rate of everyone in the match. It is the lobby reference
  // a player is judged against, not just their own team's damage.
  const lobbyMedian = median(damagePerEnemy.flat())

  const result: MatchResult = { teams: [], winner: input.winner, expected }
  teams.forEach((team, index) => {
    result.teams.push({
      players: team.players.map((player, slot) => {
        const weight = weights[index]![slot]!
        const before = elos[index]![slot]!
        const rate = damagePerEnemy[index]![slot]!
        const actualShare = pool > 0 ? (weight * rate) / pool : 0
        const equalShare = weightTotal > 0 ? weight / weightTotal : 0
        const ratingShare = ratingTotal > 0 ? (weight * before) / ratingTotal : 0
        const expectedShare = 0.5 * equalShare + 0.5 * ratingShare
        // How the player did against what their rating (and an equal share of
        // the lobby) predicted.
        const predicted =
          expectedShare > 0 && actualShare > 0
            ? Math.tanh(Math.log(actualShare / expectedShare) / PERFORMANCE_TAU)
            : -1
        // How the player's damage stands against the entire lobby: positive for
        // anyone who out-damaged more than half the field, whichever team that
        // damage came on.
        const againstLobby =
          lobbyMedian > 0
            ? rate > 0
              ? Math.tanh(Math.log(rate / lobbyMedian) / PERFORMANCE_TAU)
              : -1
            : 0
        // The lobby comparison is a floor on the performance term: beating more
        // than half of the field is never scored as a below-par performance, so
        // a bottom fragger on the winning team whose damage still clears most of
        // the lobby keeps (and gains) rating instead of paying for the win.
        // Exactly at the middle is not "above most", so the rating term stands.
        const performance = againstLobby > 0 ? Math.max(predicted, againstLobby) : predicted
        const outcome = placed ? placed[index]! : index === input.winner ? 1 : 0
        const playerK =
          formula !== 1 && formula !== FLAT_K_FORMULA && player.tracked
            ? provisionalK(kFactor, priorMatches?.get(player.id) ?? 0)
            : kFactor
        const delta = Math.round(
          playerK * (outcome - expected[index]! + PERFORMANCE_WEIGHT * performance),
        )
        const after = player.tracked ? clampElo(before + delta) : before
        if (player.tracked) updates.set(player.id, after)
        return {
          id: player.tracked ? player.id : null,
          name: player.name,
          damage: player.damage,
          tracked: player.tracked,
          elo: before,
          eloBefore: before,
          eloAfter: after,
          delta: player.tracked ? after - before : 0,
        }
      }),
    })
  })
  return { result, updates }
}

/**
 * Replays the whole log in order. The starting point is each player's creation
 * elo, so editing, reordering, deleting or re-rating anywhere in the timeline
 * produces exactly the ratings that history would have produced.
 */
export function replay(
  events: RatingEvent[],
  roster: MatchRoster[],
  kFactor: number,
  /** The K that produced the stored ratings before versioning existed. */
  legacyK = kFactor,
): ReplayResult {
  const elos = new Map<string, number>()
  for (const player of roster) elos.set(player.id, clampElo(player.baseElo))
  const outcomes = new Map<string, RatingOutcome>()
  const matchesPlayed = new Map<string, number>()
  const ordered = [...events].sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

  for (const event of ordered) {
    if (event.kind === 'adjust') {
      const before = elos.get(event.payload.playerId) ?? clampElo(event.payload.elo)
      const after = clampElo(event.payload.elo)
      elos.set(event.payload.playerId, after)
      outcomes.set(event.id, {
        eventId: event.id,
        kind: 'adjust',
        result: { playerId: event.payload.playerId, eloBefore: before, eloAfter: after },
      })
      continue
    }
    const formula = eventFormula(event.payload)
    const eventK =
      formula !== 1 && isKFactor(event.payload.k) ? event.payload.k : legacyK
    const { result, updates } = rateMatch(event.payload, elos, eventK, {
      formula,
      priorMatches: matchesPlayed,
    })
    for (const [id, elo] of updates) elos.set(id, elo)
    if (result.teams.length > 0) {
      const seen = new Set<string>()
      for (const team of event.payload.teams)
        for (const player of team.players)
          if (player.tracked) seen.add(player.id)
      for (const id of seen)
        matchesPlayed.set(id, (matchesPlayed.get(id) ?? 0) + 1)
    }
    outcomes.set(event.id, { eventId: event.id, kind: 'match', result })
  }

  return { elos, outcomes }
}
