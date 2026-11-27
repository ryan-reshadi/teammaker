import type { Round } from '../../shared/types'
import { teamColor } from '../colors'

type Props = {
  rounds: Round[]
  onRemove: (id: string) => Promise<void>
}

const formatWhen = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

export function History({ rounds, onRemove }: Props) {
  return (
    <section className="panel history" aria-labelledby="history-title">
      <div className="panel-head">
        <div>
          <h2 id="history-title">Saved rounds</h2>
          <p className="sub">
            {rounds.length
              ? `${rounds.length} kept · snapshots of saved teams`
              : 'Nothing saved yet'}
          </p>
        </div>
      </div>

      {rounds.length === 0 ? (
        <p className="empty-state">
          Save a round you like and it lands here as a snapshot of the teams and
          the bench.
        </p>
      ) : (
        <ul className="round-list">
          {rounds.map((round) => (
            <li key={round.id}>
              <details className="round-row">
                <summary>
                  <span className="round-when">{formatWhen(round.createdAt)}</span>
                  <span className="round-meta">
                    <span>
                      {round.config.teamCount} teams · spread {round.config.spread}{' '}
                    </span>
                    <span className="round-meta-sub">
                      tolerance ±{Math.round(round.config.tolerance)} elo
                      {round.config.benchedIds.length > 0 &&
                        ` · ${round.config.benchedIds.length} sat out`}
                    </span>
                  </span>
                  <span className="round-caret" aria-hidden="true">
                    +
                  </span>
                </summary>
                <div className="round-teams">
                  {round.config.teams.map((team, index) => (
                    <div className="round-team" key={index}>
                      <span
                        className="round-team-name"
                        style={{ color: teamColor(index) }}
                      >
                        Team {index + 1}
                      </span>
                      <span className="round-team-players">
                        {team.players.map((player) => player.name).join(', ') || '—'}
                      </span>
                      <span className="round-team-sum">{team.sum}</span>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="buried-link"
                  onClick={() => void onRemove(round.id)}
                >
                  Delete this round
                </button>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
