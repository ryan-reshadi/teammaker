import { useState } from 'react'
import {
  clampElo,
  skillFromElo,
  type RatingEventView,
} from '../../shared/elo'
import { playerHistory, sparklinePoints } from '../../shared/history'
import { tagLabel } from '../../shared/roles'
import type { GroupTag, Player } from '../../shared/types'
import type { PlayerDraft, PlayerPatch } from '../store'
import { RolePicker } from './RolePicker'
import { SkillPicker } from './SkillPicker'

type Props = {
  players: Player[]
  events: RatingEventView[]
  kFactor: number
  tags: GroupTag[]
  /** The device's local sit-out set for this group. */
  sitOutIds: string[]
  suggestions: string[]
  canEdit: boolean
  onAdd: (drafts: PlayerDraft[]) => Promise<void>
  onUpdate: (id: string, patch: PlayerPatch) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onToggleSit: (id: string) => void
}

const parseNames = (text: string) =>
  text
    .split(/[\n,]+/)
    .map((name) => name.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 50)

export function Roster({
  players,
  events,
  kFactor,
  tags,
  sitOutIds,
  suggestions,
  canEdit,
  onAdd,
  onUpdate,
  onRemove,
  onToggleSit,
}: Props) {
  const [draftName, setDraftName] = useState('')
  const [draftUsername, setDraftUsername] = useState('')
  const [draftSkill, setDraftSkill] = useState(5)
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [roleEditor, setRoleEditor] = useState<string | null>(null)
  const [eloEditor, setEloEditor] = useState<string | null>(null)
  const [eloDraft, setEloDraft] = useState('')
  const [bulk, setBulk] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [editing, setEditing] = useState<{
    id: string
    name: string
    username: string
  } | null>(null)
  const [historyFor, setHistoryFor] = useState<string | null>(null)

  const sitting = new Set(sitOutIds)
  const total = players.reduce((sum, player) => sum + player.elo, 0)
  const benched = players.filter((player) => sitting.has(player.id)).length
  const average = players.length ? Math.round(total / players.length) : 0

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canEdit) return
    const name = draftName.trim()
    if (!name) return
    const username = draftUsername.trim()
    setDraftName('')
    setDraftUsername('')
    const nextTags = draftTags
    setDraftTags([])
    await onAdd([{ name, username, skill: draftSkill, tags: nextTags }])
  }

  const addBulk = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canEdit) return
    const names = parseNames(bulkText)
    if (!names.length) return
    setBulkText('')
    setBulk(false)
    await onAdd(names.map((name) => ({ name, skill: 5 })))
  }

  /** Details only: the patch carries no rating, so elo and the log stay put. */
  const commitDetails = (player: Player) => {
    if (editing?.id !== player.id || !canEdit) return
    const name = editing.name.trim()
    const username = editing.username.trim()
    setEditing(null)
    if (!name) return
    const patch: PlayerPatch = {}
    if (name !== player.name) patch.name = name
    if (username !== (player.username ?? '')) patch.username = username
    if (Object.keys(patch).length > 0) void onUpdate(player.id, patch)
  }

  const editorKeyDown = (player: Player) => (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitDetails(player)
    }
    if (event.key === 'Escape') setEditing(null)
  }

  const openElo = (player: Player) => {
    if (!canEdit) return
    setEloDraft(String(player.elo))
    setEloEditor(player.id)
  }

  const commitElo = (player: Player) => {
    if (!canEdit) return
    const parsed = Number(eloDraft)
    setEloEditor(null)
    if (!Number.isFinite(parsed)) return
    const elo = clampElo(parsed)
    if (elo !== player.elo) void onUpdate(player.id, { elo })
  }

  return (
    <section className="panel roster" aria-labelledby="roster-title">
      <div className="panel-head">
        <div>
          <h2 id="roster-title">Roster</h2>
          <p className="sub">
            <strong>{players.length}</strong> {players.length === 1 ? 'player' : 'players'} ·{' '}
            <strong>{total}</strong> total elo · avg <strong>{average}</strong>
            {benched > 0 && <> · {benched} sitting out</>}
          </p>
        </div>
        {!canEdit && <span className="chip">View only</span>}
      </div>

      {canEdit && (
        <>
          <form className="add-form" onSubmit={add}>
            <input
              className="input"
              value={draftName}
              maxLength={40}
              placeholder="Add a player…"
              aria-label="New player name"
              onChange={(event) => setDraftName(event.target.value)}
            />
            <input
              className="input"
              value={draftUsername}
              maxLength={32}
              placeholder="Username (optional)…"
              aria-label="New player username"
              onChange={(event) => setDraftUsername(event.target.value)}
            />
            <div className="add-row">
              <SkillPicker
                value={draftSkill}
                onChange={setDraftSkill}
                label="Starting rating for the new player"
              />
              <button
                className="primary"
                disabled={!draftName.trim() || players.length >= 200}
              >
                Add
              </button>
            </div>
            {tags.length > 0 && (
              <div className="draft-roles">
                <span className="draft-roles-label">Tags for the new player</span>
                <RolePicker
                  tags={tags}
                  value={draftTags}
                  onChange={setDraftTags}
                  label="Tags for the new player"
                />
              </div>
            )}
          </form>

          {bulk ? (
            <form className="bulk-form" onSubmit={addBulk}>
              <label htmlFor="bulk-names">
                One name per line or separated by commas — everyone joins at 5.
              </label>
              <textarea
                id="bulk-names"
                rows={4}
                value={bulkText}
                onChange={(event) => setBulkText(event.target.value)}
              />
              <div className="bulk-actions">
                <button className="primary" disabled={!parseNames(bulkText).length}>
                  Add {parseNames(bulkText).length || ''} players
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => {
                    setBulk(false)
                    setBulkText('')
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="buried-link" onClick={() => setBulk(true)}>
              Add several at once
            </button>
          )}
        </>
      )}

      {players.length === 0 ? (
        <p className="empty-state">
          {canEdit
            ? 'Add your players and rate each one from 1 to 10. That rating seeds their elo (100 points a point); matches tune it from there.'
            : 'This group has no players yet. Someone with edit access can add them.'}
        </p>
      ) : (
        <ul className="player-list">
          {players.map((player) => {
            const band = skillFromElo(player.elo)
            const history = playerHistory(events, player.id)
            const trend =
              history.length > 0
                ? [history[0]!.eloBefore, ...history.map((entry) => entry.eloAfter)]
                : [player.elo]
            const isSitting = sitting.has(player.id)
            return (
              <li key={player.id} className={`player-row${isSitting ? ' benched' : ''}`}>
                <div className="player-main">
                  {editing?.id === player.id && canEdit ? (
                    <div className="player-details-editor">
                      <input
                        className="player-name-input"
                        autoFocus
                        maxLength={40}
                        value={editing.name}
                        placeholder="Name"
                        aria-label={`Name for ${player.name}`}
                        onChange={(event) =>
                          setEditing({ ...editing, name: event.target.value })
                        }
                        onKeyDown={editorKeyDown(player)}
                      />
                      <input
                        className="player-name-input"
                        maxLength={32}
                        value={editing.username}
                        placeholder="Username (optional)"
                        aria-label={`Username for ${player.name}`}
                        onChange={(event) =>
                          setEditing({ ...editing, username: event.target.value })
                        }
                        onKeyDown={editorKeyDown(player)}
                      />
                      <div className="player-details-actions">
                        <button
                          type="button"
                          className="primary"
                          disabled={!editing.name.trim()}
                          onClick={() => commitDetails(player)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="player-name"
                      title={canEdit ? 'Edit name and username' : player.name}
                      disabled={!canEdit}
                      onClick={() =>
                        setEditing({
                          id: player.id,
                          name: player.name,
                          username: player.username ?? '',
                        })
                      }
                    >
                      <span className="player-name-line">
                        <span className="player-name-text">{player.name}</span>
                        {suggestions.includes(player.id) && (
                          <span className="suggest-badge">bench?</span>
                        )}
                      </span>
                      {player.username && (
                        <span className="player-username">{player.username}</span>
                      )}
                    </button>
                  )}
                </div>
                <div className="player-rating">
                  <SkillPicker
                    value={band}
                    onChange={(skill) => {
                      if (!canEdit) return
                      if (skill !== band) void onUpdate(player.id, { skill })
                    }}
                    label={`Rating for ${player.name}`}
                  />
                  <div className="elo-actions">
                    {eloEditor === player.id && canEdit ? (
                      <input
                        className="elo-input"
                        type="number"
                        min={100}
                        max={1000}
                        step={1}
                        autoFocus
                        value={eloDraft}
                        aria-label={`Elo for ${player.name}`}
                        onChange={(event) => setEloDraft(event.target.value)}
                        onBlur={() => commitElo(player)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            event.currentTarget.blur()
                          }
                          if (event.key === 'Escape') setEloEditor(null)
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="elo-badge"
                        disabled={!canEdit}
                        aria-label={`Advanced elo for ${player.name}: ${player.elo}`}
                        title={
                          canEdit
                            ? `Advanced · edit ${player.elo} elo directly`
                            : `${player.name} has ${player.elo} elo`
                        }
                        onClick={() => openElo(player)}
                      >
                        {player.elo}
                      </button>
                    )}
                    <button
                      type="button"
                      className="history-button"
                      aria-label={`Rating history for ${player.name}`}
                      aria-expanded={historyFor === player.id}
                      title="Rating history"
                      onClick={() =>
                        setHistoryFor(historyFor === player.id ? null : player.id)
                      }
                    >
                      ↗
                    </button>
                  </div>
                </div>
                <div className="player-foot">
                  <div className="player-roles">
                    {roleEditor === player.id && canEdit ? (
                      <div className="role-editor">
                        <RolePicker
                          tags={tags}
                          value={player.tags}
                          onChange={(next) => void onUpdate(player.id, { tags: next })}
                          label={`Tags for ${player.name}`}
                        />
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => setRoleEditor(null)}
                        >
                          Done
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="role-summary"
                        disabled={!canEdit}
                        aria-label={`Tags for ${player.name}: ${
                          player.tags.length
                            ? player.tags.map((tag) => tagLabel(tags, tag)).join(', ')
                            : 'none yet'
                        }`}
                        onClick={() => setRoleEditor(player.id)}
                      >
                        {player.tags.length ? (
                          player.tags.map((tag) => (
                            <span key={tag} className="role-chip">
                              {tagLabel(tags, tag)}
                            </span>
                          ))
                        ) : (
                          <span className="role-empty">
                            {tags.length ? '+ tags' : 'no tags in this group'}
                          </span>
                        )}
                      </button>
                    )}
                  </div>
                  <div className="player-actions">
                    <button
                      type="button"
                      className="sit-toggle"
                      aria-pressed={isSitting}
                      title={
                        isSitting
                          ? `${player.name} is sitting out on this device — bring them back in`
                          : `Sit ${player.name} out of this round on this device`
                      }
                      onClick={() => onToggleSit(player.id)}
                    >
                      <span className="sit-dot" aria-hidden="true" />
                      {isSitting ? 'Out' : 'Sit out'}
                    </button>
                    {canEdit && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${player.name}`}
                        title={`Remove ${player.name}`}
                        onClick={() => void onRemove(player.id)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
                {historyFor === player.id && (
                  <div className="player-history">
                    <div className="player-history-head">
                      <strong>Rating history</strong>
                      <span className="muted">K {kFactor}</span>
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => setHistoryFor(null)}
                      >
                        Close
                      </button>
                    </div>
                    {history.length > 0 && (
                      <svg
                        className="elo-spark"
                        viewBox="0 0 180 40"
                        role="img"
                        aria-label={`Elo trend for ${player.name}`}
                      >
                        <polyline points={sparklinePoints(trend, 180, 40)} />
                      </svg>
                    )}
                    {history.length === 0 ? (
                      <p className="history-empty">
                        No rated matches yet. Log a match and this player's
                        before/after elo lands here.
                      </p>
                    ) : (
                      <ul className="history-list">
                        {[...history].reverse().map((entry) => (
                          <li key={`${entry.id}:${entry.position}`}>
                            <span className="history-when">
                              {new Date(entry.createdAt).toLocaleDateString(
                                undefined,
                                { month: 'short', day: 'numeric' },
                              )}
                            </span>
                            <span className="history-label">
                              {entry.label}
                              {entry.kind === 'match'
                                ? entry.won
                                  ? ' · won'
                                  : ' · lost'
                                : ''}
                            </span>
                            <span className="history-elo">
                              {entry.eloBefore} → {entry.eloAfter}
                            </span>
                            <span className={entry.delta >= 0 ? 'good' : 'bad'}>
                              {entry.delta > 0 ? '+' : ''}
                              {entry.delta}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
