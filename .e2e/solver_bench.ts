/** Solver benchmarks: wall time and completeness as the roster grows. */
import { solve } from '../src/shared/balance'

const make = (count: number, tagEvery = 0) =>
  Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    skill: 1 + ((i * 7) % 10),
    tags: tagEvery && i % tagEvery === 0 ? ['sniper'] : [],
  }))

function time(label: string, players: ReturnType<typeof make>, teamCount: number, tolerance: number) {
  const started = performance.now()
  const result = solve(players, { teamCount, tolerance })
  const ms = performance.now() - started
  console.log(
    `${label.padEnd(34)} ${ms.toFixed(0).padStart(5)} ms  valid=${String(result.validCount).padStart(3)}  ` +
      `shown=${result.arrangements.length}  exhaustive=${result.exhaustive}  spread=${result.arrangements[0]?.spread ?? '-'}`,
  )
  return { ms, result }
}

console.log('--- tolerance sweep, 12 players / 3 teams ---')
for (const tolerance of [0, 1, 3, 6, 20]) time(`t=${tolerance}`, make(12), 3, tolerance)

console.log('--- roster size sweep, tolerance 5 ---')
for (const count of [8, 12, 20, 30, 40]) time(`${count} players / 3 teams`, make(count), 3, 5)
for (const count of [20, 30, 40]) time(`${count} players / 6 teams`, make(count), 6, 5)
for (const count of [30, 40]) time(`${count} players / 8 teams`, make(count), 8, 10)

console.log('--- roles on (1 sniper in 4) vs off ---')
const tagged = make(30, 4)
time('roles on, 30 / 6', tagged, 6, 6)
const started = performance.now()
solve(tagged, { teamCount: 6, tolerance: 6, spreadRoles: false })
console.log(`roles off, 30 / 6`.padEnd(34), `${(performance.now() - started).toFixed(0).padStart(5)} ms`)

console.log('--- repeated runs (cache-free stability) ---')
const suite = make(30)
time('run 1', suite, 6, 6)
time('run 2', suite, 6, 6)
time('run 3', suite, 6, 6)

console.log('--- fallback cost: impossible tolerance ---')
const wall = make(12)
time('12 / 3 teams, tolerance 0 (impossible)', wall, 3, 0).result.arrangements.length
