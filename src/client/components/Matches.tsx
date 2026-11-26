import { useEffect, useMemo, useState } from 'react'
import {
  MAX_DAMAGE,
  MAX_MATCH_PLAYERS,
  MIN_K_FACTOR,
  MAX_K_FACTOR,
  type MatchEventView,
  type MatchInput,
  type RatingEventView,
} from '../../shared/elo'
import type { Player } from '../../shared/types'

type Props = {
  players: Player[]
  events: RatingEventView[]
  kFactor: number
  remote: boolean
  onSave: (input: MatchInput, id?: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onMove: (id: string, position: number) => Promise<void>
  onKFactor: (kFactor: number) => Promise<void>
}

type DraftPlayer = {
  key: string
  id: string
  name: string
  tracked: boolean
  damage: string
}

type DraftTeam = DraftPlayer[]

const emptyTeams = (): [DraftTeam, DraftTeam] => [[], []]

const formatWhen = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

const signed = (value: number) => (value > 0 ? `+${value}` : `${value}`)

export function Matches({
  players,
  events,
  kFactor,
  remote,
  onSave,
  onDelete,
  onMove,
  onKFactor,
}: Props) {
  const [label, setLabel] = useState('')
  const [teams, setTeams] = useState<[DraftTeam, DraftTeam]>(emptyTeams)
  const [winner, setWinner] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [kDraft, setKDraft] = useState(String(kFactor))

  useEffect(() => setKDraft(String(kFactor)), [kFactor])

  const used = useMemo(
    () => new Set(teams.flat().filter((player) => player.tracked).map((player) => player.id)),
    [teams],
  )
  const available = players.filter((player) => !used.has(player.id))
  const trackedCount = teams.flat().filter((player) => player.tracked).length

  const reset = () => {
    setLabel('')
    setTeams(emptyTeams())
    setWinner(0)
    setEditing(null)
    setError('')
  }

  const startEdit = (event: MatchEventView) => {
    setEditing(event.id)
    setLabel(event.label)
    setWinner(event.winner)
    setTeams(
      event.teams.map((team) =>
        team.players.map((player) => ({
          key: crypto.randomUUID(),
          id: player.id ?? crypto.randomUUID(),
          name: player.name,
          tracked: player.tracked,
          damage: String(player.damage),
        })),
      ) as [DraftTeam, DraftTeam],
    )
    setError('')
  }

  const addTracked = (team: number, id: string) => {
    const player = players.find((entry) => entry.id === id)
    if (!player) return
    setTeams((previous) => {
      const next: [DraftTeam, DraftTeam] = [[...previous[0]], [...previous[1]]]
      if (next[team].length >= MAX_MATCH_PLAYERS) return previous
      next[team].push({
        key: crypto.randomUUID(),
        id: player.id,
        name: player.name,
        tracked: true,
        damage: '',
      })
      return next
    })
  }

  const addRandom = (team: number) => {
    setTeams((previous) => {
      const next: [DraftTeam, DraftTeam] = [[...previous[0]], [...previous[1]]]
      if (next[team].length >= MAX_MATCH_PLAYERS) return previous
      const taken = next[team].filter((entry) => !entry.tracked).length + 1
      const key = crypto.randomUUID()
      next[team].push({
        key,
        id: key,
        name: `Random ${taken}`,
        tracked: false,
        damage: '',
      })
      return next
    })
  }

  const updateDamage = (team: number, key: string, damage: string) => {
    setTeams((previous) => {
      const next: [DraftTeam, DraftTeam] = [[...previous[0]], [...previous[1]]]
      next[team] = next[team].map((player) =>
        player.key === key ? { ...player, damage } : player,
      )
      return next
    })
  }

  const remove = (team: number, key: string) => {
    setTeams((previous) => {
      const next: [DraftTeam, DraftTeam] = [[...previous[0]], [...previous[1]]]
      next[team] = next[team].filter((player) => player.key !== key)
      return next
    })
  }

  const save = async (submit: React.FormEvent) => {
    submit.preventDefault()
    if (!remote || saving) return
    if (teams.some((team) => team.length === 0 || team.length > MAX_MATCH_PLAYERS)) {
      setError(`Each team needs 1 to ${MAX_MATCH_PLAYERS} players.`)
      return
    }
    if (trackedCount === 0) {
      setError('Add at least one player from your roster.')
      return
    }
    const damages = teams.map((team) =>
      team.map((player) => player.damage.trim()),
    )
    if (damages.some((team) => team.some((damage) => damage === '' || !/^\d+$/.test(damage)))) {
      setError('Enter whole-number damage for every player.')
      return
    }
    const numbers = damages.map((team) => team.map(Number))
    if (numbers.some((team) => team.some((damage) => damage < 0 || damage > MAX_DAMAGE))) {
      setError(`Damage is 0 to ${MAX_DAMAGE.toLocaleString()}.`)
      return
    }
    if (numbers.flat().reduce((sum, damage) => sum + damage, 0) === 0) {
      setError('A match needs some damage on the board.')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSave(
        {
          label: label.trim().slice(0, 60),
          winner,
          teams: teams.map((team, teamIndex) => ({
            players: team.map((player, slot) => ({
              id: player.id,
              name: player.name,
              damage: numbers[teamIndex]![slot]!,
              tracked: player.tracked,
            })),
          })),
        },
        editing ?? undefined,
      )
      reset()
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : 'That match could not be saved.',
      )
    } finally {
      setSaving(false)
    }
  }

  const run = async (action: () => Promise<void>) => {
    try {
      await action()
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : 'That change could not be saved.',
      )
    }
  }

  const applyK = async () => {
    const value = Number(kDraft)
    if (!Number.isInteger(value) || value < MIN_K_FACTOR || value > MAX_K_FACTOR) {
      setError(`K is a whole number from ${MIN_K_FACTOR} to ${MAX_K_FACTOR}.`)
      return
    }
    setError('')
    try {
      await onKFactor(value)
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : 'That K could not be saved.',
      )
    }
  }

  const ordered = [...events].sort(
    (a, b) => a.position - b.position || a.createdAt - b.createdAt,
  )
  const shown = [...ordered].reverse()

  return (
    <section className="panel matches" aria-labelledby="matches-title">
      <div className="panel-head">
        <div>
          <h2 id="matches-title">Matches</h2>
          <p className="sub">
            {events.length
              ? `${events.length} logged · elo tunes from damage and the result`
              : 'Log damage after a match; elo follows.'}
          </p>
        </div>
        {remote && (
          <div className="k-control">
            <label htmlFor="k-factor">K</label>
            <input
              id="k-factor"
              className="k-input"
              type="number"
              min={MIN_K_FACTOR}
              max={MAX_K_FACTOR}
              step={1}
              value={kDraft}
              onChange={(event) => setKDraft(event.target.value)}
            />
            <button type="button" className="quiet" onClick={() => void applyK()}>
              Apply
            </button>
          </div>
        )}
      </div>

      {!remote ? (
        <p className="empty-state">
          Sign in to log matches, tune elo and keep a rating history. Ratings on
          this device still work.
        </p>
      ) : (
        <form className="match-form" onSubmit={save}>
          <div className="match-form-head">
            <input
              className="input"
              value={label}
              maxLength={60}
              placeholder="Label (optional) — e.g. Tuesday scrim"
              aria-label="Match label"
              onChange={(event) => setLabel(event.target.value)}
            />
            {editing && (
              <span className="chip warn">Editing a logged match</span>
            )}
          </div>

          <div className="match-teams">
            {teams.map((team, teamIndex) => (
              <div className="match-team" key={teamIndex}>
                <div className="match-team-head">
                  <span className="match-team-name">Team {teamIndex + 1}</span>
                  <label className="winner-choice">
                    <input
                      type="radio"
                      name="winner"
                      checked={winner === teamIndex}
                      onChange={() => setWinner(teamIndex)}
                    />
                    Winner
                  </label>
                </div>
                <ul className="match-player-list">
                  {team.map((player) => (
                    <li className="match-player" key={player.key}>
                      <span className="match-player-name">
                        {player.name}
                        {!player.tracked && <span className="rand-tag">random</span>}
                      </span>
                      <input
                        className="damage-input"
                        type="number"
                        min={0}
                        max={MAX_DAMAGE}
                        step={1}
                        inputMode="numeric"
                        placeholder="dmg"
                        aria-label={`Damage for ${player.name}`}
                        value={player.damage}
                        onChange={(event) =>
                          updateDamage(teamIndex, player.key, event.target.value)
                        }
                      />
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${player.name} from this match`}
                        onClick={() => remove(teamIndex, player.key)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="match-add">
                  <select
                    className="input"
                    value=""
                    aria-label={`Add a player to team ${teamIndex + 1}`}
                    onChange={(event) => addTracked(teamIndex, event.target.value)}
                  >
                    <option value="">Add from roster…</option>
                    {available.map((player) => (
                      <option key={player.id} value={player.id}>
                        {player.name} · {player.elo}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => addRandom(teamIndex)}
                  >
                    + Random
                  </button>
                </div>
              </div>
            ))}
          </div>

          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}

          <div className="match-actions">
            <button className="primary" disabled={saving || players.length === 0}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Log match'}
            </button>
            {editing && (
              <button type="button" className="quiet" onClick={reset}>
                Cancel
              </button>
            )}
            <span className="hint">
              Damage is normalized by the number of enemies faced, so uneven teams
              are compared fairly.
            </span>
          </div>
        </form>
      )}

      {events.length > 0 && (
        <ul className="match-log">
          {shown.map((event) => {
            const index = ordered.findIndex((entry) => entry.id === event.id)
            if (event.kind === 'adjust') {
              return (
                <li className="match-row adjustment" key={event.id}>
                  <div className="match-row-head">
                    <span className="match-when">{formatWhen(event.createdAt)}</span>
                    <span className="match-title">
                      Manual · {event.name || 'player'}
                    </span>
                    <span className="match-score">
                      {event.eloBefore} → {event.eloAfter}{' '}
                      <span className={event.delta >= 0 ? 'good' : 'bad'}>
                        {signed(event.delta)}
                      </span>
                    </span>
                    <span className="match-reason">{event.reason}</span>
                  </div>
                </li>
              )
            }
            return (
              <li className="match-row" key={event.id}>
                <details>
                  <summary>
                    <span className="match-when">{formatWhen(event.createdAt)}</span>
                    <span className="match-title">
                      {event.label || 'Match'}
                      <span className="match-sub">
                        {event.teams
                          .map((team) => team.players.map((player) => player.name).join(', '))
                          .join(' vs ')}
                      </span>
                    </span>
                    <span className="match-score">
                      Team {event.winner + 1} won
                    </span>
                    <span className="match-caret" aria-hidden="true">
                      +
                    </span>
                  </summary>
                  <div className="match-detail">
                    {event.teams.map((team, teamIndex) => (
                      <div className="match-detail-team" key={teamIndex}>
                        <span className="match-detail-name">
                          Team {teamIndex + 1}
                          {teamIndex === event.winner ? ' · won' : ''}
                        </span>
                        <ul>
                          {team.players.map((player, slot) => (
                            <li key={`${teamIndex}:${slot}`}>
                              <span>
                                {player.name}
                                {!player.tracked && (
                                  <span className="rand-tag">random</span>
                                )}
                              </span>
                              <span className="match-detail-dmg">{player.damage}</span>
                              <span className="match-detail-elo">
                                {player.tracked
                                  ? `${player.eloBefore} → ${player.eloAfter}`
                                  : `~${player.elo}`}
                              </span>
                              <span className={player.delta >= 0 ? 'good' : 'bad'}>
                                {player.tracked ? signed(player.delta) : '—'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    <div className="match-row-actions">
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => startEdit(event)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="quiet"
                        disabled={index <= 0}
                        onClick={() => void run(() => onMove(event.id, index - 1))}
                      >
                        Earlier
                      </button>
                      <button
                        type="button"
                        className="quiet"
                        disabled={index >= ordered.length - 1}
                        onClick={() => void run(() => onMove(event.id, index + 1))}
                      >
                        Later
                      </button>
                      <button
                        type="button"
                        className="quiet danger"
                        onClick={() => void run(() => onDelete(event.id))}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </details>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
