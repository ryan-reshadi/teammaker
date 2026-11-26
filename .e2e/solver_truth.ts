/**
 * Is the returned arrangement the tightest one that exists? Compare the solver
 * (which stops at a 200-result cap) against exhaustive enumeration.
 */
import { solve, teamSizes } from '../src/shared/balance'

type Player = { id: string; name: string; skill: number; tags: string[] }

function bruteMinSpread(players: Player[], teamCount: number): number {
  const sizes = teamSizes(players.length, teamCount)
  const assign = new Array(players.length).fill(-1)
  const sums = new Array(teamCount).fill(0)
  const counts = new Array(teamCount).fill(0)
  let best = Number.POSITIVE_INFINITY
  const walk = (i: number) => {
    if (i === players.length) {
      const max = Math.max(...sums)
      const min = Math.min(...sums)
      if (max - min < best) best = max - min
      return
    }
    for (let t = 0; t < teamCount; t++) {
      if (counts[t] >= sizes[t]) continue
      assign[i] = t
      counts[t]++
      sums[t] += players[i].skill
      walk(i + 1)
      sums[t] -= players[i].skill
      counts[t]--
    }
  }
  walk(0)
  return best
}

const cases: { label: string; skills: number[]; teams: number; tolerance: number }[] = [
  { label: 'perfect 34s exists, tolerance 10', skills: [10, 10, 10, 9, 9, 9, 8, 8, 8, 7, 7, 7], teams: 3, tolerance: 10 },
  { label: 'perfect 20s exists, tolerance 8', skills: [10, 10, 9, 9, 8, 8, 7, 7, 6, 6, 5, 5], teams: 3, tolerance: 8 },
  { label: 'equal 5s, tolerance 0', skills: Array(12).fill(5), teams: 3, tolerance: 0 },
  { label: 'wide 1..10, tolerance 6', skills: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 9], teams: 3, tolerance: 6 },
  { label: '16 players, tolerance 6', skills: [10, 9, 9, 8, 8, 8, 7, 7, 7, 7, 6, 6, 5, 4, 3, 2], teams: 4, tolerance: 6 },
]

for (const item of cases) {
  const players: Player[] = item.skills.map((skill, index) => ({
    id: `p${index}`,
    name: `P${index}`,
    skill,
    tags: [],
  }))
  const truth = bruteMinSpread(players, item.teams)
  const started = performance.now()
  const result = solve(players, { teamCount: item.teams, tolerance: item.tolerance })
  const ms = performance.now() - started
  const got = result.arrangements[0]?.spread ?? null
  console.log(
    `${item.label.padEnd(38)} truth=${truth}  solver=${got}  ${got === truth ? 'OK' : 'MISMATCH'}  ` +
      `valid=${result.validCount} exhaustive=${result.exhaustive} ${ms.toFixed(1)}ms`,
  )
}

console.log('--- hard instances (budget behaviour) ---')
for (const [count, teams, tolerance] of [[30, 8, 0], [40, 8, 0], [30, 8, 2], [40, 6, 1], [24, 6, 0]]) {
  const players: Player[] = Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    skill: 1 + ((i * 3) % 10),
    tags: [],
  }))
  const started = performance.now()
  const result = solve(players, { teamCount: teams, tolerance })
  const ms = performance.now() - started
  console.log(
    `${count} players / ${teams} teams / t=${tolerance}`.padEnd(38) +
      `${ms.toFixed(0).padStart(5)} ms  valid=${String(result.validCount).padStart(3)} exhaustive=${result.exhaustive} spread=${result.arrangements[0]?.spread ?? '-'}`,
  )
}
