import { solve, type SolverRequest, type SolverResponse } from '../shared/balance'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SolverRequest>) => void) | null
  postMessage: (message: SolverResponse) => void
}

scope.onmessage = (event) => {
  const request = event.data
  try {
    scope.postMessage({
      id: request.id,
      result: solve(request.players, request.options),
    })
  } catch (error) {
    scope.postMessage({
      id: request.id,
      error:
        error instanceof Error
          ? error.message
          : 'These teams could not be balanced.',
    })
  }
}
