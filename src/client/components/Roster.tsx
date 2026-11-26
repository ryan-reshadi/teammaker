import { useState } from 'react'
import { roleLabel } from '../../shared/roles'
import type { Player } from '../../shared/types'
import type { PlayerDraft, PlayerPatch } from '../store'
import { RolePicker } from './RolePicker'
import { SkillPicker } from './SkillPicker'

type Props = {
  players: Player[]
  suggestions: string[]
  disabled?: boolean
  onAdd: (drafts: PlayerDraft[]) => Promise<void>
  onUpdate: (id: string, patch: PlayerPatch) => Promise<void>
  onRemove: (id: string) => Promise<void>
}

const parseNames = (text: string) =>
  text
    .split(/[\n,]+/)
    .map((name) => name.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 50)

export function Roster({
  players,
  suggestions,
  disabled,
  onAdd,
  onUpdate,
  onRemove,
}: Props) {
  const [draftName, setDraftName] = useState('')
  const [draftSkill, setDraftSkill] = useState(5)
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [roleEditor, setRoleEditor] = useState<string | null>(null)
  const [bulk, setBulk] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const total = players.reduce((sum, player) => sum + player.skill, 0)
  const benched = players.filter((player) => player.sittingOut).length
  const average = players.length ? (total / players.length).toFixed(1) : '0'

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = draftName.trim()
    if (!name) return
    setDraftName('')
    const tags = draftTags
    setDraftTags([])
    await onAdd([{ name, skill: draftSkill, tags }])
  }

  const addBulk = async (event: React.FormEvent) => {
    event.preventDefault()
    const names = parseNames(bulkText)
    if (!names.length) return
    setBulkText('')
    setBulk(false)
    await onAdd(names.map((name) => ({ name, skill: 5 })))
  }

  const commitName = (player: Player) => {
    const name = editingName.trim()
    setEditingId(null)
    if (name && name !== player.name) void onUpdate(player.id, { name })
  }

  return (
    <section className="panel roster" aria-labelledby="roster-title">
      <div className="panel-head">
        <div>
          <h2 id="roster-title">Roster</h2>
          <p className="sub">
            <strong>{players.length}</strong> {players.length === 1 ? 'player' : 'players'} ·{' '}
            <strong>{total}</strong> total skill · avg <strong>{average}</strong>
            {benched > 0 && <> · {benched} sitting out</>}
          </p>
        </div>
      </div>

      <form className="add-form" onSubmit={add}>
        <input
          className="input"
          value={draftName}
          maxLength={40}
          placeholder="Add a player…"
          aria-label="New player name"
          disabled={disabled}
          onChange={(event) => setDraftName(event.target.value)}
        />
        <div className="add-row">
          <SkillPicker
            value={draftSkill}
            onChange={setDraftSkill}
            label="Skill for the new player"
          />
          <button
            className="primary"
            disabled={disabled || !draftName.trim() || players.length >= 200}
          >
            Add
          </button>
        </div>
        <div className="draft-roles">
          <span className="draft-roles-label">Roles for the new player</span>
          <RolePicker
            value={draftTags}
            onChange={setDraftTags}
            label="Roles for the new player"
          />
        </div>
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
            disabled={disabled}
            onChange={(event) => setBulkText(event.target.value)}
          />
          <div className="bulk-actions">
            <button className="primary" disabled={disabled || !parseNames(bulkText).length}>
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

      {players.length === 0 ? (
        <p className="empty-state">
          Add your players and rate each one from 1 to 10. Skill 5 is a good
          starting guess — you can fine-tune it any time.
        </p>
      ) : (
        <ul className="player-list">
          {players.map((player) => (
            <li
              key={player.id}
              className={`player-row${player.sittingOut ? ' benched' : ''}`}
            >
              {editingId === player.id ? (
                <input
                  className="player-name-input"
                  autoFocus
                  maxLength={40}
                  value={editingName}
                  aria-label={`Name for ${player.name}`}
                  onChange={(event) => setEditingName(event.target.value)}
                  onBlur={() => commitName(player)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitName(player)
                    }
                    if (event.key === 'Escape') setEditingId(null)
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="player-name"
                  title="Rename"
                  onClick={() => {
                    setEditingId(player.id)
                    setEditingName(player.name)
                  }}
                >
                  <span className="player-name-text">{player.name}</span>
                  {suggestions.includes(player.id) && (
                    <span className="suggest-badge">bench?</span>
                  )}
                </button>
              )}
              <SkillPicker
                value={player.skill}
                onChange={(skill) => void onUpdate(player.id, { skill })}
                label={`Skill for ${player.name}`}
              />
              <button
                type="button"
                className="sit-toggle"
                aria-pressed={player.sittingOut}
                title={
                  player.sittingOut
                    ? `${player.name} is sitting out — bring them back in`
                    : `Sit ${player.name} out of this round`
                }
                onClick={() =>
                  void onUpdate(player.id, { sittingOut: !player.sittingOut })
                }
              >
                <span className="sit-dot" aria-hidden="true" />
                {player.sittingOut ? 'Out' : 'Sit out'}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${player.name}`}
                title={`Remove ${player.name}`}
                onClick={() => void onRemove(player.id)}
              >
                ×
              </button>
              <div className="player-roles">
                {roleEditor === player.id ? (
                  <div className="role-editor">
                    <RolePicker
                      value={player.tags}
                      onChange={(tags) => void onUpdate(player.id, { tags })}
                      label={`Roles for ${player.name}`}
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
                    aria-label={`Roles for ${player.name}: ${
                      player.tags.length
                        ? player.tags.map(roleLabel).join(', ')
                        : 'none yet'
                    }`}
                    onClick={() => setRoleEditor(player.id)}
                  >
                    {player.tags.length ? (
                      player.tags.map((tag) => (
                        <span key={tag} className="role-chip">
                          {roleLabel(tag)}
                        </span>
                      ))
                    ) : (
                      <span className="role-empty">+ roles</span>
                    )}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
