import { useEffect, useState, type CSSProperties } from 'react'
import type { PairRule, SolveResult, SolverTeam } from '../../shared/balance'
import { expectationsFromStrengths } from '../../shared/elo'
import {
  roleCoverage,
  tagLabel,
  tagShort,
} from '../../shared/roles'
import type { GroupTag, Player, RoundConfig } from '../../shared/types'
import { teamColor } from '../colors'
import { syncPairRules } from '../pairRules'
import { solveInWorker } from '../solverClient'
import { describeSolveResult } from '../solvePresentation'
import { ResultStatus } from './ResultStatus'

function countRoles(players: SolverTeam['players'], tagIds: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const player of players)
    for (const tag of player.tags ?? [])
      if (tagIds.includes(tag)) counts[tag] = (counts[tag] ?? 0) + 1
  return counts
}

type Props = {
  players: Player[]
  tags: GroupTag[]
  sitOutIds: string[]
  teamCount: number
  tolerance: number
  onTeamCount: (value: number) => void
  onTolerance: (value: number) => void
  suggestions: string[]
  benchNote: string
  onSitOut: (ids: string[]) => void
  onSaveRound: (config: RoundConfig) => Promise<void>
  saved: string
}

function TeamColumn({
  team,
  index,
  max,
  odds,
  tags,
}: {
  team: SolverTeam
  index: number
  max: number
  odds: number
  tags: GroupTag[]
}) {
  const roles = countRoles(team.players, tags.map((tag) => tag.id))
  return (
    <div
      className="team"
      style={
        {
          '--team-color': teamColor(index),
          '--team-index': index,
        } as CSSProperties
      }
    >
      <div className="team-head">
        <span className="team-name">Team {index + 1}</span>
        <span className="team-sum">{team.sum}</span>
      </div>
      <div className="team-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(6, (team.sum / max) * 100)}%` }} />
      </div>
      <div className="team-odds-row">
        <span className="team-odds">{Math.round(odds * 100)}%</span>
        <span className="team-odds-label">win odds</span>
      </div>
      {Object.keys(roles).length > 0 && (
        <div className="team-roles">
          {Object.entries(roles).map(([role, count]) => (
            <span className="team-role" key={role} title={`${tagLabel(tags, role)}${count > 1 ? ` ×${count}` : ''}`}>
              {tagShort(tags, role)}
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

export function Build({
  players,
  tags,
  sitOutIds,
  teamCount,
  tolerance,
  onTeamCount,
  onTolerance,
  suggestions,
  benchNote,
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
  const [roleAllowance, setRoleAllowance] = useState(0)
  const [pairRules, setPairRules] = useState<PairRule[]>([])
  const [pairA, setPairA] = useState('')
  const [pairB, setPairB] = useState('')
  const [pairKind, setPairKind] = useState<PairRule['kind']>('together')
  const [pairNotice, setPairNotice] = useState('')

  const benched = new Set(sitOutIds)
  const available = players.filter((player) => !benched.has(player.id))
  const hasRoles = tags.length > 0 && available.some((player) => player.tags.length > 0)
  const { rules: activePairRules, notice: pairDrop } = syncPairRules(
    pairRules,
    available.map((player) => player.id),
  )
  useEffect(() => {
    if (!pairDrop) return
    setPairRules(activePairRules)
    setPairNotice(pairDrop)
  }, [activePairRules, pairDrop])
  const playerName = (id: string) =>
    players.find((player) => player.id === id)?.name ?? 'Player'
  const pairSignature = activePairRules
    .map((rule) => `${rule.kind}:${[rule.a, rule.b].sort().join('+')}`)
    .sort()
    .join(',')
  const currentSignature = `${teamCount}:${tolerance}:${spreadRoles}:${roleAllowance}:${pairSignature}:${players
    .map(
      (player) =>
                `${player.id}${player.elo}${benched.has(player.id) ? 'x' : ''}${player.tags.join('+')}`,
      )
      .join('|')}`
  const stale = Boolean(result) && signature !== currentSignature
  const arrangements = result?.arrangements ?? []
  const shown = arrangements[index] ?? null
  const max = shown ? Math.max(...shown.teams.map((team) => team.sum), 1) : 1
  const description = result ? describeSolveResult(result, index) : null
  const odds = shown
    ? expectationsFromStrengths(shown.teams.map((team) => team.sum))
    : []

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
        {
          teamCount,
          tolerance,
          spreadRoles: hasRoles ? spreadRoles : false,
          roleAllowance: hasRoles && spreadRoles ? roleAllowance : 0,
          pairRules: activePairRules,
          tagIds: tags.map((tag) => tag.id),
        },
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

  const addPairRule = () => {
    if (!pairA || !pairB || pairA === pairB) {
      setError('Pick two different players for a pair rule.')
      return
    }
    const duplicate = pairRules.some(
      (rule) =>
        (rule.a === pairA && rule.b === pairB) ||
        (rule.a === pairB && rule.b === pairA),
    )
    if (duplicate) {
      setError('That pair already has a rule.')
      return
    }
    setPairRules((previous) => [...previous, { a: pairA, b: pairB, kind: pairKind }])
    setPairA('')
    setPairB('')
    setPairNotice('')
    setError('')
  }

  const removePairRule = (index: number) => {
    setPairRules((previous) => previous.filter((_rule, position) => position !== index))
    setPairNotice('')
  }

  const clearPairRules = () => {
    setPairRules([])
    setPairNotice('')
    setError('')
    // A failed search is only about those rules; clear it with them so the
    // warning does not outlive the rules that caused it.
    if (result?.constraintFailure) {
      setResult(null)
      setSignature('')
      setIndex(0)
    }
  }

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
            {suggestions.length} on the bench. Fewest sits {benchNote}:{' '}
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

      {hasRoles && spreadRoles && (
        <label className="role-allowance">
          <span className="control-label">Role preference</span>
          <select
            className="input"
            value={roleAllowance}
            onChange={(event) => setRoleAllowance(Number(event.target.value))}
          >
            <option value={0}>Tightest first</option>
            <option value={50}>Prefer roles within 50 elo</option>
            <option value={100}>Prefer roles within 100 elo</option>
          </select>
          <span className="hint">
            How much extra spread to accept for better role coverage.
          </span>
        </label>
      )}

      <details className="pair-rules">
        <summary>
          Pair rules
          {activePairRules.length > 0 && ` · ${activePairRules.length}`}
        </summary>
        <p className="hint">
          Hard rules: every shown split keeps these players together or apart.
        </p>
        <div className="pair-rule-form">
          <select
            className="input"
            value={pairA}
            aria-label="First player for the pair rule"
            onChange={(event) => setPairA(event.target.value)}
          >
            <option value="">Player…</option>
            {available.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            value={pairKind}
            aria-label="Pair rule relationship"
            onChange={(event) =>
              setPairKind(event.target.value === 'apart' ? 'apart' : 'together')
            }
          >
            <option value="together">with</option>
            <option value="apart">apart from</option>
          </select>
          <select
            className="input"
            value={pairB}
            aria-label="Second player for the pair rule"
            onChange={(event) => setPairB(event.target.value)}
          >
            <option value="">Player…</option>
            {available.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>
          <button type="button" className="quiet" onClick={addPairRule}>
            Add
          </button>
        </div>
        {activePairRules.length > 0 && (
          <ul className="pair-rule-list">
            {activePairRules.map((rule) => (
              <li key={`${rule.a}:${rule.b}:${rule.kind}`}>
                <span>
                  {playerName(rule.a)}{' '}
                  {rule.kind === 'together' ? 'with' : 'apart from'}{' '}
                  {playerName(rule.b)}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove pair rule for ${playerName(rule.a)} and ${playerName(rule.b)}`}
                  onClick={() => removePairRule(pairRules.indexOf(rule))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {pairRules.length > 0 && (
          <button type="button" className="quiet" onClick={clearPairRules}>
            Clear pair rules
          </button>
        )}
      </details>
      {pairNotice && (
        <p className="hint pair-notice" role="status">
          {pairNotice}
        </p>
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
        ) : !result || !description ? (
          <p className="empty-state">
            Rate your players, choose how many teams you need, then generate.
            We count the splits that fit your tolerance and show the most
            different ones.
          </p>
        ) : !shown ? (
          <div className="warning constraint-failure">
            <p>{description.notice ?? 'No split matches your pair rules.'}</p>
            <div className="warning-actions">
              {description.offerTolerance && (
                <button
                  type="button"
                  className="quiet"
                  onClick={() => onTolerance(Math.min(2000, tolerance + 100))}
                >
                  Widen tolerance by 100
                </button>
              )}
              {description.offerClearPairs && (
                <button type="button" className="quiet" onClick={clearPairRules}>
                  Clear pair rules
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="result-head">
              <span className="arrangement-count">
                Arrangement {index + 1} of {arrangements.length}
              </span>
              {arrangements.length > 1 && (
                <div className="pager">
                  <button
                    type="button"
                    aria-label="Previous arrangement"
                    onClick={() =>
                      setIndex((index - 1 + arrangements.length) % arrangements.length)
                    }
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    aria-label="Next arrangement"
                    onClick={() => setIndex((index + 1) % arrangements.length)}
                  >
                    ›
                  </button>
                </div>
              )}
            </div>

            <ResultStatus
              view={description}
              spread={shown.spread}
              withinTolerance={shown.withinTolerance}
              totalElo={shown.teams.reduce((sum, team) => sum + team.sum, 0)}
              onWiden={() => onTolerance(shown.spread)}
            />

            <div className="teams" key={`${signature}-${index}`}>
              {shown.teams.map((team, position) => (
                <TeamColumn
                  key={position}
                  team={team}
                  index={position}
                  max={max}
                  odds={odds[position] ?? 0}
                  tags={tags}
                />
              ))}
            </div>
            <p className="caption odds-caption">
              Win odds are elo-only pre-match estimates; roles and damage can
              change the outcome.
            </p>
            {result.roleAllowance > 0 && (
              <p className="caption role-first-caption">
                Role-first ranking: splits up to {result.roleAllowance} elo looser
                than the tightest stay eligible, then the fullest role coverage
                wins.
              </p>
            )}

            {description.coverage && (
              <p className="caption">{description.coverage}</p>
            )}
            {hasRoles &&
              (() => {
                const { missing } = roleCoverage(
                  shown.teams,
                  tags.map((tag) => tag.id),
                )
                if (missing.length === 0)
                  return (
                    <p className="caption role-gaps good">
                      Every shared role is on every team.
                    </p>
                  )
                const shownGaps = missing.slice(0, 3).map(
                  (gap) => `Team ${gap.teamIndex + 1} has no ${tagLabel(tags, gap.role)}`,
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
                      .filter((player) => benched.has(player.id))
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
