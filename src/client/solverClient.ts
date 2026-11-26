import {
  solve,
  type SolveResult,
  type SolverOptions,
  type SolverPlayer,
  type SolverRequest,
  type SolverResponse,
} from '../shared/balance'

let worker: Worker | null = null
let sequence = 0
const pending = new Map<
  number,
  { resolve: (result: SolveResult) => void; reject: (error: Error) => void }
>()

function ensureWorker(): Worker {
  if (worker) return worker
  const next = new Worker(new URL('./solver.worker.ts', import.meta.url), {
    type: 'module',
  })
  next.onmessage = (event: MessageEvent<SolverResponse>) => {
    const entry = pending.get(event.data.id)
    if (!entry) return
    pending.delete(event.data.id)
    if (event.data.error) entry.reject(new Error(event.data.error))
    else if (event.data.result) entry.resolve(event.data.result)
    else entry.reject(new Error('The search returned nothing.'))
  }
  next.onerror = () => {
    for (const entry of pending.values())
      entry.reject(new Error('The balancing worker stopped.'))
    pending.clear()
    next.terminate()
    worker = null
  }
  worker = next
  return next
}

/**
 * Balance in a Worker so a large roster never blocks typing. If Workers are
 * unavailable the same pure solver runs inline instead.
 */
export async function solveInWorker(
  players: SolverPlayer[],
  options: SolverOptions,
): Promise<SolveResult> {
  try {
    const id = ++sequence
    const request: SolverRequest = { id, players, options }
    const instance = ensureWorker()
    return await new Promise<SolveResult>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      instance.postMessage(request)
      window.setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error('timeout'))
      }, 8000)
    })
  } catch {
    return solve(players, options)
  }
}
