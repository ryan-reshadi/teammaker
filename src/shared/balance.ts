/**
 * Pure, deterministic team balancing. No React, no DOM, no network — so the
 * same module runs in the browser Worker, in tests, and on the server.
 *
 * Ratings are elo (100 - 1000) integers, so sums and spreads stay exact.
 */

import { clampElo } from './elo'
import { normalizeTags } from './roles'

export type SolverPlayer = {
  id: string
  name: string
  elo: number
  tags?: string[]
}

export type SolverTeam = { players: SolverPlayer[]; sum: number }

export type Arrangement = {
  teams: SolverTeam[]
  spread: number
  withinTolerance: boolean
}

export type PairRule = {
  a: string
  b: string
  kind: 'together' | 'apart'
}

export type SolverOptions = {
  teamCount: number
  /** Maximum elo spread between the strongest and weakest team. */
  tolerance: number
  /** Hard rules: two players together, or never on the same team. */
  pairRules?: PairRule[]
  /**
   * When > 0 and roles are spread, splits up to this much looser than the
   * tightest are ranked by role coverage first. 0 keeps today's tie-break.
   */
  roleAllowance?: number
  /** How many valid splits the search keeps before it stops. */
  maxResults?: number
  /** How many splits are returned to the interface. */
  maxArrangements?: number
  timeBudgetMs?: number
  maxNodes?: number
  /**
   * Rank equally balanced splits by how evenly the role tags land across the
   * teams. Defaults to true; ignored when nobody has tags.
   */
  spreadRoles?: boolean
  /**
   * The group's tag ids, in display order. Coverage is indexed against this
   * list; without it the ids carried by the players are used.
   */
  tagIds?: string[]
}

export type SolveResult = {
  arrangements: Arrangement[]
  /**
   * Distinct valid splits found, before the variety filter. A lower bound when
   * `exhaustive` is false.
   */
  validCount: number
  /**
   * True when the search visited every branch, so `validCount` is exact and no
   * split was missed.
   */
  exhaustive: boolean
  playerCount: number
  teamCount: number
  tolerance: number
  totalElo: number
  /** Normalized pair rules applied to the search. */
  pairRules: number
  /** True when rules exist and no split could satisfy them. */
  constraintFailure: boolean
  /** The active role-first allowance; 0 means tightest-first. */
  roleAllowance: number
}

export type SolverRequest = {
  id: number
  players: SolverPlayer[]
  options: SolverOptions
}

export type SolverResponse = {
  id: number
  result?: SolveResult
  error?: string
}

const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

/** Team sizes as even as possible: the first teams take the extra players. */
export function teamSizes(playerCount: number, teamCount: number): number[] {
  if (teamCount <= 0) return []
  const base = Math.floor(playerCount / teamCount)
  const extra = playerCount % teamCount
  return Array.from({ length: teamCount }, (_, index) =>
    base + (index < extra ? 1 : 0),
  )
}

export function arrangementSpread(teams: { sum: number }[]): number {
  if (teams.length === 0) return 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const team of teams) {
    if (team.sum < min) min = team.sum
    if (team.sum > max) max = team.sum
  }
  return max - min
}

type Candidate = {
  assign: Int8Array
  spread: number
  /** Teams missing a role they could have had; 0 is ideal. */
  roleGap: number
  deviation: number
  key: string
}

const byTightness = (a: Candidate, b: Candidate) =>
  a.spread - b.spread ||
  a.roleGap - b.roleGap ||
  a.deviation - b.deviation ||
  (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

const byRoleFirst = (a: Candidate, b: Candidate) =>
  a.roleGap - b.roleGap ||
  a.spread - b.spread ||
  a.deviation - b.deviation ||
  (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

function movedPlayers(a: Int8Array, b: Int8Array): number {
  let moved = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) moved++
  return moved
}

/**
 * Keep the tightest split, then repeatedly take the candidate that is furthest
 * from everything already chosen, so a page full of results never shows the
 * same teams twice.
 */
function selectDiverse(
  sorted: Candidate[],
  limit: number,
  compare: (a: Candidate, b: Candidate) => number = byTightness,
): Candidate[] {
  if (sorted.length <= limit) return sorted
  const chosen = [sorted[0]]
  const rest = sorted.slice(1)
  while (chosen.length < limit && rest.length > 0) {
    let bestIndex = 0
    let bestDistance = -1
    for (let i = 0; i < rest.length; i++) {
      let nearest = Number.POSITIVE_INFINITY
      for (const pick of chosen) {
        const distance = movedPlayers(pick.assign, rest[i].assign)
        if (distance < nearest) nearest = distance
      }
      if (nearest > bestDistance) {
        bestDistance = nearest
        bestIndex = i
      }
    }
    chosen.push(rest.splice(bestIndex, 1)[0])
  }
  return chosen.sort(compare)
}

/**
 * Best-effort closest split: start greedily, then repeatedly swap two players
 * between teams to shrink the spread. Used when the search found no valid
 * split, so the interface can show something instead of an empty result. The
 * greedy start and local swaps are not guaranteed to reach the true minimum
 * spread.
 */
function tightestReachable(
  players: SolverPlayer[],
  sizes: number[],
  teamCount: number,
): Arrangement | null {
  if (players.length === 0 || players.length < teamCount) return null
  const order = [...players].sort((a, b) => b.elo - a.elo)
  const groups: SolverPlayer[][] = Array.from({ length: teamCount }, () => [])
  const sums = new Array<number>(teamCount).fill(0)
  for (const player of order) {
    let target = -1
    for (let t = 0; t < teamCount; t++) {
      if (groups[t].length >= sizes[t]) continue
      if (target === -1 || sums[t] < sums[target]) target = t
    }
    if (target === -1) return null
    groups[target].push(player)
    sums[target] += player.elo
  }

  const total = sums.reduce((sum, value) => sum + value, 0)
  const mean = total / teamCount
  const measure = (values: number[]) => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const value of values) {
      if (value < min) min = value
      if (value > max) max = value
    }
    return {
      spread: max - min,
      deviation: values.reduce((sum, value) => sum + (value - mean) ** 2, 0),
    }
  }
  const better = (a: { spread: number; deviation: number }, b: { spread: number; deviation: number }) =>
    a.spread < b.spread ||
    (a.spread === b.spread && a.deviation < b.deviation - 1e-9)

  let current = measure(sums)
  for (let step = 0; step < 500; step++) {
    let best: { i: number; j: number; a: number; b: number; next: typeof current } | null = null
    for (let i = 0; i < teamCount; i++) {
      for (let j = i + 1; j < teamCount; j++) {
        for (let a = 0; a < groups[i].length; a++) {
          for (let b = 0; b < groups[j].length; b++) {
            const delta = groups[i][a].elo - groups[j][b].elo
            if (delta === 0) continue
            const nextSums = sums.slice()
            nextSums[i] -= delta
            nextSums[j] += delta
            const next = measure(nextSums)
            if (better(next, current) && (!best || better(next, best.next)))
              best = { i, j, a, b, next }
          }
        }
      }
    }
    if (!best) break
    const leaving = groups[best.i][best.a]
    const arriving = groups[best.j][best.b]
    groups[best.i][best.a] = arriving
    groups[best.j][best.b] = leaving
    sums[best.i] += arriving.elo - leaving.elo
    sums[best.j] += leaving.elo - arriving.elo
    current = best.next
  }

  const teams = groups.map((list) => ({
    players: [...list].sort((a, b) => b.elo - a.elo || a.name.localeCompare(b.name)),
    sum: list.reduce((sum, player) => sum + player.elo, 0),
  }))
  const spread = arrangementSpread(teams)
  return { teams, spread, withinTolerance: false }
}

type IndexedPair = { a: number; b: number; together: boolean }

/** Unknown ids, self-pairs and malformed rules are ignored; apart wins a conflict. */
function indexPairRules(
  rules: PairRule[] | undefined,
  players: SolverPlayer[],
): IndexedPair[] {
  const index = new Map(players.map((player, position) => [player.id, position]))
  const found = new Map<string, IndexedPair>()
  for (const rule of rules ?? []) {
    const a = index.get(rule.a)
    const b = index.get(rule.b)
    if (a === undefined || b === undefined || a === b) continue
    const first = Math.min(a, b)
    const second = Math.max(a, b)
    const key = `${first}:${second}`
    const together = rule.kind === 'together'
    const existing = found.get(key)
    if (!existing) found.set(key, { a: first, b: second, together })
    else if (!together) existing.together = false
  }
  return [...found.values()]
}

export function solve(
  playersIn: SolverPlayer[],
  options: SolverOptions,
): SolveResult {
  // A group owns its tag list; without one, the tags present on the players
  // keep the solver useful (and the legacy role catalogue still resolves).
  const tagIds = options.tagIds
    ? [...new Set(options.tagIds)]
    : [...new Set(playersIn.flatMap((player) => player.tags ?? []))]
  const players = playersIn.map((player) => ({
    id: player.id,
    name: player.name,
    elo: clampElo(player.elo),
    tags: normalizeTags(player.tags, tagIds),
  }))
  const spreadRoles = options.spreadRoles !== false
  const teamCount = Math.min(8, Math.max(1, Math.round(options.teamCount)))
  const tolerance = Math.max(0, Number.isFinite(options.tolerance) ? options.tolerance : 0)
  const maxResults = options.maxResults ?? 200
  const maxArrangements = options.maxArrangements ?? 12
  const timeBudgetMs = options.timeBudgetMs ?? 300
  const maxNodes = options.maxNodes ?? 500_000
  const pairRules = indexPairRules(options.pairRules, players)
  const requestedAllowance = options.roleAllowance ?? 0
  const roleAllowance = Math.max(
    0,
    Math.round(Number.isFinite(requestedAllowance) ? requestedAllowance : 0),
  )

  const playerCount = players.length
  const totalElo = players.reduce((sum, player) => sum + player.elo, 0)
  const empty: SolveResult = {
    arrangements: [],
    validCount: 0,
    exhaustive: true,
    playerCount,
    teamCount,
    tolerance,
    totalElo,
    pairRules: pairRules.length,
    constraintFailure: false,
    roleAllowance: 0,
  }
  if (playerCount < teamCount) return empty

  const sizes = teamSizes(playerCount, teamCount)
  // Every team may hold up to the larger size; the leaf check requires exactly
  // `extra` teams to reach it. Fixing the sizes per index instead would force
  // the strongest players into the first teams and miss valid splits.
  const base = Math.floor(playerCount / teamCount)
  const extra = playerCount % teamCount
  const hi = extra > 0 ? base + 1 : base
  const order = players
    .map((_, index) => index)
    .sort((a, b) => players[b].elo - players[a].elo || a - b)

  // For a valid split every team sum must sit inside these bounds, because
  // max - min <= tolerance implies max <= (S + (n-1)t)/n and min >= (S - (n-1)t)/n.
  const upper = Math.floor((totalElo + (teamCount - 1) * tolerance) / teamCount)
  const lower = Math.ceil((totalElo - (teamCount - 1) * tolerance) / teamCount)

  const assign = new Int8Array(playerCount)
  const members: number[][] = Array.from({ length: teamCount }, () => [])
  const sums = new Array<number>(teamCount).fill(0)
  const tagBit = new Map(
    tagIds.slice(0, 31).map((id, index) => [id, 1 << index] as const),
  )
  const tagMasks = players.map((player) =>
    player.tags.reduce((mask, tag) => mask | (tagBit.get(tag) ?? 0), 0),
  )
  const anyTags = spreadRoles && tagMasks.some((mask) => mask !== 0)
  const togetherWith: number[][] = Array.from({ length: playerCount }, () => [])
  const apartFrom: number[][] = Array.from({ length: playerCount }, () => [])
  for (const rule of pairRules) {
    if (rule.together) {
      togetherWith[rule.a]!.push(rule.b)
      togetherWith[rule.b]!.push(rule.a)
    } else {
      apartFrom[rule.a]!.push(rule.b)
      apartFrom[rule.b]!.push(rule.a)
    }
  }
  const assigned = new Uint8Array(playerCount)
  const compatible = (playerIndex: number, team: number) => {
    for (const other of togetherWith[playerIndex]!)
      if (assigned[other] && assign[other] !== team) return false
    for (const other of apartFrom[playerIndex]!)
      if (assigned[other] && assign[other] === team) return false
    return true
  }
  const keys = new Set<string>()
  const found: Candidate[] = []
  let opened = 0
  let extras = 0
  let nodes = 0
  let cut = false
  const startedAt = now()

  // Teams missing a role that at least `teamCount` players could cover: the
  // secondary criterion once two splits are equally close on elo.
  const roleGapNow = () => {
    let gap = 0
    for (let bit = 0; bit < Math.min(tagIds.length, 31); bit++) {
      const mask = 1 << bit
      let total = 0
      let missing = 0
      for (let team = 0; team < teamCount; team++) {
        let count = 0
        for (const index of members[team])
          if (tagMasks[index]! & mask) count++
        total += count
        if (count === 0) missing++
      }
      if (total >= teamCount) gap += missing
    }
    return gap
  }

  const record = () => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const sum of sums) {
      if (sum < min) min = sum
      if (sum > max) max = sum
    }
    const spread = max - min
    if (spread > tolerance) return
    const mean = totalElo / teamCount
    let deviation = 0
    for (const sum of sums) deviation += (sum - mean) ** 2
    const key = members
      .map((list) => list.map((index) => players[index].id).sort().join(','))
      .join('|')
    if (keys.has(key)) return
    keys.add(key)
    found.push({
      assign: Int8Array.from(assign),
      spread,
      roleGap: anyTags ? roleGapNow() : 0,
      deviation,
      key,
    })
    if (found.length >= maxResults) cut = true
  }

  // The teams must end up as even as possible: every team has `base` players,
  // except exactly `extra` teams that have one more.
  const correctSizes = () => {
    if (opened !== teamCount) return false
    if (extra === 0) return true
    let larger = 0
    for (let team = 0; team < teamCount; team++) {
      const size = members[team].length
      if (size === hi) larger++
      else if (size !== base) return false
    }
    return larger === extra
  }

  const walk = (slot: number) => {
    if (cut) return
    if (slot === playerCount) {
      if (correctSizes()) record()
      return
    }
    if (++nodes % 1024 === 0) {
      if (now() - startedAt > timeBudgetMs || nodes > maxNodes) {
        cut = true
        return
      }
    }
    const playerIndex = order[slot]
    const elo = players[playerIndex].elo

    // Teams open in order, so a partition is produced exactly once and no team
    // can be empty in the middle. Try the emptiest team first: balanced splits
    // are then found early, which matters when the budget is short.
    const candidates: number[] = []
    for (let team = 0; team < opened; team++) {
      if (members[team].length < hi && sums[team] + elo <= upper)
        candidates.push(team)
    }
    if (opened < teamCount && sums[opened] + elo <= upper) candidates.push(opened)
    candidates.sort((a, b) => sums[a] - sums[b] || a - b)

    for (const team of candidates) {
      if (!compatible(playerIndex, team)) continue
      const opening = team === opened
      members[team].push(playerIndex)
      sums[team] += elo
      assign[playerIndex] = team
      assigned[playerIndex] = 1
      if (opening) opened++
      const full = members[team].length === hi
      if (full) extras++
      // A full team short of the lower bound can never be valid, and no more
      // than `extra` teams may take the larger size.
      const dead =
        (full && sums[team] < lower) || (extra > 0 && extras > extra)
      if (!dead) walk(slot + 1)
      if (full) extras--
      if (opening) opened--
      sums[team] -= elo
      members[team].pop()
      assigned[playerIndex] = 0
      if (cut) return
    }
  }

  walk(0)

  const sorted = [...found].sort(byTightness)
  const roleFirst = anyTags && roleAllowance > 0
  const ranked =
    roleFirst && sorted.length > 0
      ? (() => {
          const tightest = sorted[0]!.spread
          return sorted
            .filter((candidate) => candidate.spread <= tightest + roleAllowance)
            .sort(byRoleFirst)
        })()
      : sorted

  const arrangements = selectDiverse(
    ranked,
    maxArrangements,
    roleFirst ? byRoleFirst : byTightness,
  ).map(
    (candidate): Arrangement => {
      const teams = Array.from({ length: teamCount }, (_, team) => {
        const list = players
          .filter((_, index) => candidate.assign[index] === team)
          .sort((a, b) => b.elo - a.elo || a.name.localeCompare(b.name))
        return { players: list, sum: list.reduce((sum, player) => sum + player.elo, 0) }
      })
      const spread = arrangementSpread(teams)
      return { teams, spread, withinTolerance: spread <= tolerance }
    },
  )

  // `exhaustive` describes the search only: the fallback below is a best-effort
  // split and never makes an incomplete search look complete. Pair rules are
  // hard, so a fallback that violates them is never shown.
  const exhaustive = !cut
  if (arrangements.length === 0 && pairRules.length === 0) {
    const fallback = tightestReachable(players, sizes, teamCount)
    if (fallback)
      arrangements.push({
        ...fallback,
        withinTolerance: fallback.spread <= tolerance,
      })
  }
  const constraintFailure = pairRules.length > 0 && arrangements.length === 0

  return {
    arrangements,
    validCount: found.length,
    exhaustive,
    playerCount,
    teamCount,
    tolerance,
    totalElo,
    pairRules: pairRules.length,
    constraintFailure,
    roleAllowance: roleFirst ? roleAllowance : 0,
  }
}

/**
 * Who should sit when the available players do not divide evenly: fewest rounds
 * sat first, then the lowest elo, so the bench stays fair and the teams stay
 * as strong as possible.
 */
export function suggestSitOuts(
  players: { id: string; elo: number; sittingOut?: boolean }[],
  teamCount: number,
  sitCounts: Record<string, number>,
  /** The device's local sit-out set. Without it, `sittingOut` is used. */
  sitOutIds?: readonly string[],
): string[] {
  const benched = sitOutIds ? new Set(sitOutIds) : null
  const available = players.filter((player) =>
    benched ? !benched.has(player.id) : !player.sittingOut,
  )
  const needed = available.length % Math.max(1, teamCount)
  if (needed === 0 || available.length - needed < teamCount) return []
  return [...available]
    .sort(
      (a, b) =>
        (sitCounts[a.id] ?? 0) - (sitCounts[b.id] ?? 0) ||
        a.elo - b.elo ||
        a.id.localeCompare(b.id),
    )
    .slice(0, needed)
    .map((player) => player.id)
}
