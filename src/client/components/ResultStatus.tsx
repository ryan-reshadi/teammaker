import type { SolvePresentation } from '../solvePresentation'

type Props = {
  view: SolvePresentation
  spread: number
  withinTolerance: boolean
  totalElo: number
  onWiden: () => void
}

/**
 * The only place the result header's best-effort marker and its explanation are
 * rendered. Both come straight from `view`, so a fallback cannot be shown with
 * the gating used for a normal arrangement.
 */
export function ResultStatus({
  view,
  spread,
  withinTolerance,
  totalElo,
  onWiden,
}: Props) {
  return (
    <>
      <div className="result-meta">
        <span className={`chip${withinTolerance ? ' good' : ' warn'}`}>
          Spread {spread}
        </span>
        {view.bestEffort && <span className="chip warn">Best effort</span>}
        <span className="muted">Total elo {totalElo}</span>
      </div>
      {view.notice && (
        <div className="warning">
          <p>{view.notice}</p>
          {view.offerTolerance && (
            <button type="button" className="quiet" onClick={onWiden}>
              Allow a spread of {spread}
            </button>
          )}
        </div>
      )}
    </>
  )
}
