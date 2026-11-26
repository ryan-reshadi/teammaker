import { useState, type CSSProperties } from 'react'
import type { SolveResult, SolverTeam } from '../../shared/balance'
import {
  normalizeTags,
  roleCoverage,
  roleLabel,
  roleShort,
} from '../../shared/roles'
import type { Player, RoundConfig } from '../../shared/types'
import { teamColor } from '../colors'
import { solveInWorker } from '../solverClient'

function countRoles(players: SolverTeam['players']): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const player of players)
    for (const tag of normalizeTags(player.tags))
      counts[tag] = (counts[tag] ?? 0) + 1
  return counts
}

type Props = {
  players: Player[]
  teamCount: number
  tolerance: number
  onTeamCount: (value: number) => void
  onTolerance: (value: number) => void
  suggestions: string[]
  onSitOut: (ids: string[]) => void
  onSaveRound: (config: RoundConfig) => Promise<void>
  saved: string
}

function TeamColumn({ team, index, max }: { team: SolverTeam; index: number; max: number }) {
  const roles = countRoles(team.players)
  return (
    <div
      className="team"
      style={{ '--team-color': teamColor(index) } as CSSProperties}
    >
      <div className="team-head">
        <span className="team-name">Team {index + 1}</span>
        <span className="team-sum">{team.sum}</span>
      </div>
      <div className="team-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(6, (team.sum / max) * 100)}%` }} />
      </div>
      {Object.keys(roles).length > 0 && (
        <div className="team-roles">
          {Object.entries(roles).map(([role, count]) => (
            <span className="team-role" key={role} title={`${roleLabel(role)}${count > 1 ? ` ×${count}` : ''}`}>
              {roleShort(role)}
              {count > 1 ? count : ''}
            </span>
          ))}
        </div>
      )}
      <ul className="team-list">
        {team.players.map((player) => (
          <li key={player.id}>
            <span className="team-player">{player.name}</span>
            <span className="team-skill">{player.elo}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const toleranceHint = (tolerance: number) =>
  tolerance === 0
    ? 'Only a perfect split counts.'
    : tolerance <= 50
      ? 'Very tight — under half a rating point between teams.'
      : tolerance <= 150
        ? 'Balanced, with room to move.'
        : 'Loose — more combinations, more lopsided teams.'

function coverage(result: SolveResult, shown: number): string {
  if (result.validCount === 0) return ''
  const splits = `${result.validCount} valid ${result.validCount === 1 ? 'split' : 'splits'}`
  if (!result.exhaustive)
    return `Found ${splits} — showing the ${shown} most different before the search wrapped up.`
  if (result.validCount > shown) return `${splits} fit — showing ${shown} of the most different.`
  return `All ${splits} shown.`
}

export function Build({
  players,
  teamCount,
  tolerance,
  onTeamCount,
  onTolerance,
  suggestions,
  onSitOut,
  onSaveRound,
  saved,
}: Props) {
  const [result, setResult] = useState<SolveResult | null>(null)
  const [signature, setSignature] = useState('')
  const [index, setIndex] = useState(0)
  const [solving, setSolving] = useState(false)
  const [error, setError] = useState('')
  const [spreadRoles, setSpreadRoles] = useState(true)

  const available = players.filter((player) => !player.sittingOut)
  const hasRoles = available.some((player) => player.tags.length > 0)
  const currentSignature = `${teamCount}:${tolerance}:${spreadRoles}:${players
    .map(
      (player) =>
        `${player.id}${player.elo}${player.sittingOut ? 'x' : ''}${player.tags.join('+')}`,
    )
    .join('|')}`
  const stale = Boolean(result) && signature !== currentSignature
  const shown = result?.arrangements[index] ?? null
  const max = shown ? Math.max(...shown.teams.map((team) => team.sum), 1) : 1

  async function generate() {
    if (solving) return
    if (available.length < teamCount) {
      setError(`You need at least ${teamCount} available players.`)
      return
    }
    setSolving(true)
    setError('')
    try {
      const next = await solveInWorker(
        available.map((player) => ({
          id: player.id,
          name: player.name,
          elo: player.elo,
          tags: player.tags,
        })),
        { teamCount, tolerance, spreadRoles: hasRoles ? spreadRoles : false },
      )
      setResult(next)
      setSignature(currentSignature)
      setIndex(0)
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : 'These teams could not be balanced.',
      )
    } finally {
      setSolving(false)
    }
  }

  const suggestedNames = players
    .filter((player) => suggestions.includes(player.id))
    .map((player) => player.name)

  return (
    <section className="panel build" aria-labelledby="build-title">
      <div className="panel-head">
        <div>
          <h2 id="build-title">Build</h2>
          <p className="sub">
            {available.length} available · {teamCount} teams · tolerance ±{tolerance} elo
          </p>
        </div>
      </div>

      <div className="controls">
        <div className="control">
          <span className="control-label" id="teams-label">
            Teams
          </span>
          <div className="stepper" role="group" aria-labelledby="teams-label">
            <button
              type="button"
              aria-label="Fewer teams"
              disabled={teamCount <= 2}
              onClick={() => onTeamCount(teamCount - 1)}
            >
              −
            </button>
            <output aria-live="polite">{teamCount}</output>
            <button
              type="button"
              aria-label="More teams"
              disabled={teamCount >= 8}
              onClick={() => onTeamCount(teamCount + 1)}
            >
              +
            </button>
          </div>
        </div>
        <div className="control grow">
          <label className="control-label" htmlFor="tolerance">
            Tolerance <span className="control-value">±{tolerance} elo</span>
          </label>
          <input
            id="tolerance"
            className="range"
            type="range"
            min={0}
            max={2000}
            step={25}
            value={tolerance}
            onChange={(event) => onTolerance(Number(event.target.value))}
          />
          <p className="hint">{toleranceHint(tolerance)}</p>
        </div>
      </div>

      {suggestions.length > 0 && (
        <div className="suggestion">
          <p>
            {available.length} available across {teamCount} teams leaves{' '}
            {suggestions.length} on the bench. Fewest rounds sat:{' '}
            <strong>{suggestedNames.join(', ')}</strong>.
          </p>
          <button type="button" className="quiet" onClick={() => onSitOut(suggestions)}>
            Sit them out
          </button>
        </div>
      )}

      {hasRoles && (
        <label className="role-toggle">
          <input
            type="checkbox"
            checked={spreadRoles}
            onChange={(event) => setSpreadRoles(event.target.checked)}
          />
          <span>
            <strong>Spread roles</strong> — among equally balanced splits, prefer
            the ones that give every team each shared role.
          </span>
        </label>
      )}

      <div className="build-actions">
        <button
          type="button"
          className="primary generate"
          onClick={() => void generate()}
          disabled={solving}
        >
          {solving ? 'Balancing…' : result ? 'Generate again' : 'Generate teams'}
        </button>
        {stale && (
          <span className="stale">Roster changed — generate again to update.</span>
        )}
      </div>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="results" aria-live="polite">
        {solving && !shown ? (
          <div className="skeleton" aria-label="Balancing teams">
            <span />
            <span />
            <span />
          </div>
        ) : !shown ? (
          <p className="empty-state">
            Rate your players, choose how many teams you need, then generate.
            Every split that fits your tolerance shows up here.
          </p>
        ) : (
          <>
            <div className="result-head">
              <span className="arrangement-count">
                Arrangement {index + 1} of {result!.arrangements.length}
              </span>
              {result!.arrangements.length > 1 && (
                <div className="pager">
                  <button
                    type="button"
                    aria-label="Previous arrangement"
                    onClick={() =>
                      setIndex((index - 1 + result!.arrangements.length) % result!.arrangements.length)
                    }
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    aria-label="Next arrangement"
                    onClick={() => setIndex((index + 1) % result!.arrangements.length)}
                  >
                    ›
                  </button>
                </div>
              )}
            </div>

            <div className="result-meta">
              <span className={`chip${shown.withinTolerance ? ' good' : ' warn'}`}>
                Spread {shown.spread}
              </span>
                              <span className="muted">
                Total elo {shown.teams.reduce((sum, team) => sum + team.sum, 0)}
              </span>
            </div>

            {!shown.withinTolerance && (
              <div className="warning">
                <p>
                  No split fits a spread of {tolerance}. The closest achievable is{' '}
                  <strong>{shown.spread}</strong>.
                </p>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => onTolerance(Math.ceil(shown.spread))}
                >
                  Allow a spread of {Math.ceil(shown.spread)}
                </button>
              </div>
            )}

            <div className="teams" key={`${signature}-${index}`}>
              {shown.teams.map((team, position) => (
                <TeamColumn
                  key={position}
                  team={team}
                  index={position}
                  max={max}
                />
              ))}
            </div>

            <p className="caption">{coverage(result!, result!.arrangements.length)}</p>
            {hasRoles &&
              (() => {
                const { missing } = roleCoverage(shown.teams)
                if (missing.length === 0)
                  return (
                    <p className="caption role-gaps good">
                      Every shared role is on every team.
                    </p>
                  )
                const shownGaps = missing.slice(0, 3).map(
                  (gap) => `Team ${gap.teamIndex + 1} has no ${roleLabel(gap.role)}`,
                )
                return (
                  <p className="caption role-gaps">
                    Role gaps: {shownGaps.join(' · ')}
                    {missing.length > 3 ? ` · +${missing.length - 3} more` : ''}
                  </p>
                )
              })()}

            <div className="result-actions">
              {/* A stale arrangement no longer matches the roster: saving it
                  would record a player both on a team and on the bench. */}
              <button
                type="button"
                className="primary"
                disabled={stale || solving}
                title={
                  stale
                    ? 'The roster changed — generate again before saving.'
                    : undefined
                }
                onClick={() =>
                  void onSaveRound({
                    version: 2,
                    teamCount,
                    tolerance,
                    spread: shown.spread,
                    teams: shown.teams.map((team) => ({
                      sum: team.sum,
                      players: team.players.map((player) => ({
                        id: player.id,
                        name: player.name,
                        elo: player.elo,
                        tags: player.tags,
                      })),
                    })),
                    benchedIds: players
                      .filter((player) => player.sittingOut)
                      .map((player) => player.id),
                  })
                }
              >
                Save round
              </button>
              {saved && <span className="saved">{saved}</span>}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
