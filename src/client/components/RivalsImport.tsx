import { useEffect, useMemo, useRef, useState } from 'react'
import type { MatchInput } from '../../shared/elo'
import type {
  RosterMatchStatus,
  RivalsScan,
} from '../../shared/rivals'
import type { Player } from '../../shared/types'
import type { RivalsConfig } from '../store'
import {
  buildImportInput,
  choosePlayer,
  draftFromScan,
  draftStatuses,
  markRandom,
  moveRow,
  removeRow,
  rowCandidates,
  setDamage,
  setLabel,
  setUsername,
  setWinner,
  swapTeams,
  type ImportDraft,
} from '../rivalsImport'

type Props = {
  players: Player[]
  onConfig: () => Promise<RivalsConfig>
  onScan: (file: File) => Promise<RivalsScan>
  onSave: (input: MatchInput) => Promise<void>
  onRefresh: () => Promise<void>
}

type Stage = 'idle' | 'scanning' | 'review' | 'saving' | 'uncertain'

const STATUS_LABEL: Record<RosterMatchStatus, string> = {
  matched: 'Matched',
  suggested: 'Suggested match',
  unmatched: 'Unmatched',
  manual: 'Manually assigned',
  review: 'Needs review',
}

const STATUS_TONE: Record<RosterMatchStatus, string> = {
  matched: 'good',
  suggested: 'warn',
  unmatched: '',
  manual: 'good',
  review: 'warn',
}

const percent = (value: number) => `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`

/**
 * Upload → OCR → review → the existing match form. Nothing here records a
 * match itself: a confirmed review becomes a plain `MatchInput` and goes
 * through the same authenticated route the manual form uses.
 */
export function RivalsImport({
  players,
  onConfig,
  onScan,
  onSave,
  onRefresh,
}: Props) {
  const [stage, setStage] = useState<Stage>('idle')
  const [draft, setDraft] = useState<ImportDraft | null>(null)
  const [preview, setPreview] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [config, setConfig] = useState<RivalsConfig | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const previewRef = useRef('')

  useEffect(() => {
    let live = true
    void onConfig()
      .then((next) => {
        if (live) setConfig(next)
      })
      .catch(() => {
        if (live) setConfig(null)
      })
    return () => {
      live = false
    }
  }, [onConfig])

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    },
    [],
  )

  const statuses = useMemo(
    () => (draft ? draftStatuses(draft, players) : {}),
    [draft, players],
  )
  const outcome = useMemo(
    () => (draft ? buildImportInput(draft, players) : null),
    [draft, players],
  )

  const clearPreview = () => {
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current)
      previewRef.current = ''
    }
    setPreview('')
  }

  const reset = () => {
    clearPreview()
    setDraft(null)
    setStage('idle')
    setError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const runScan = async (file: File) => {
    clearPreview()
    const url = URL.createObjectURL(file)
    previewRef.current = url
    setPreview(url)
    setStage('scanning')
    setError('')
    setNotice('')
    try {
      const scan = await onScan(file)
      setDraft(draftFromScan(scan, players))
      setStage('review')
    } catch (problem) {
      clearPreview()
      setDraft(null)
      setStage('idle')
      setError(
        problem instanceof Error
          ? problem.message
          : 'That screenshot could not be read.',
      )
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const chooseFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const limit = config?.maxBytes ?? 8 * 1024 * 1024
    const types = config?.acceptedTypes ?? ['image/png', 'image/jpeg', 'image/webp']
    const looksImage =
      types.includes(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name)
    if (!looksImage) {
      setError('Choose a PNG, JPEG or WebP screenshot.')
      return
    }
    if (file.size > limit) {
      setError(`That screenshot is larger than ${Math.round(limit / 1024 / 1024)} MB.`)
      return
    }
    void runScan(file)
  }

  const update = (next: ImportDraft) => setDraft(next)

  const submit = async () => {
    if (!draft || !outcome?.ok || busy.current) return
    busy.current = true
    setStage('saving')
    setError('')
    setNotice('')
    try {
      await onSave(outcome.input)
      reset()
      setNotice('Match logged — check the log below before trusting the ratings.')
    } catch (problem) {
      // The endpoint has no idempotency key, so an uncertain outcome is never
      // retried automatically: the log is the source of truth.
      setStage('uncertain')
      setError(
        `${
          problem instanceof Error
            ? problem.message
            : 'That match could not be confirmed.'
        } Nothing was retried — check the match log before saving again.`,
      )
      void onRefresh().catch(() => undefined)
    } finally {
      busy.current = false
    }
  }

  const checkLog = async () => {
    try {
      await onRefresh()
      setStage('review')
      setError('')
      setNotice('Log refreshed. Confirm the match is not already there, then save.')
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : 'The match log could not be refreshed.',
      )
    }
  }

  if (stage === 'idle' || stage === 'scanning')
    return (
      <div className="match-form rivals-import">
        {config && !config.configured && (
          <p className="notice">
            Screenshot import needs an OCR service. Set OCR_SERVICE_URL and
            OCR_SERVICE_TOKEN for this deployment, then try again.
          </p>
        )}
        <div className="rivals-upload">
          <label className="rivals-drop" htmlFor="rivals-file">
            <span className="rivals-drop-title">
              Import from RIVALS Screenshot
            </span>
            <span className="rivals-drop-hint">
              Upload a screenshot of the in-game Tab scoreboard. Teams are read
              from the row colours (gold and purple), damage from the DMG column
              and the winner from the two team scores.
            </span>
            <input
              id="rivals-file"
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={stage === 'scanning' || config?.configured === false}
              onChange={chooseFile}
            />
          </label>
          <p className="hint">
            PNG, JPEG or WebP up to 8 MB. The image is sent once to the OCR
            service and is never stored.
          </p>
        </div>
        {stage === 'scanning' && (
          <div className="rivals-scanning">
            {preview && (
              <img className="rivals-preview" src={preview} alt="Uploaded scoreboard" />
            )}
            <p className="rivals-progress" role="status">
              Reading the scoreboard…
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p className="notice">{notice}</p>}
      </div>
    )

  if (!draft) return null

  const colors = draft.colors
  const teamName = (slot: number) =>
    `Team ${slot + 1} · ${colors[slot] === 'gold' ? 'Gold' : 'Purple'}`

  return (
    <div className="match-form rivals-import">
      <div className="rivals-summary">
        {preview && (
          <img className="rivals-preview" src={preview} alt="RIVALS scoreboard screenshot" />
        )}
        <div className="rivals-summary-body">
          <p className="rivals-score">
            <span className="rivals-score-team">{teamName(0)}</span>
            <strong>{draft.scores[0] ?? '?'}</strong>
            <span className="rivals-score-dash">—</span>
            <strong>{draft.scores[1] ?? '?'}</strong>
            <span className="rivals-score-team">{teamName(1)}</span>
          </p>
          <p className="hint">
            Tier scores and the winner are read from the top of the scoreboard.
            A tie or an unreadable score needs a manual winner.
          </p>
          <div className="rivals-summary-actions">
            <input
              className="input"
              value={draft.label}
              maxLength={60}
              aria-label="Match label"
              onChange={(event) => update(setLabel(draft, event.target.value))}
            />
            <button
              type="button"
              className="quiet"
              onClick={() => update(swapTeams(draft))}
            >
              Swap teams
            </button>
          </div>
        </div>
      </div>

      <div className="match-teams">
        {[0, 1].map((slot) => (
          <div className="match-team" key={slot}>
            <div className="match-team-head">
              <div className="match-team-actions">
                <span className="match-team-name">{teamName(slot)}</span>
                <span className="chip">{draft.scores[slot] ?? '?'}</span>
              </div>
              <label className="winner-choice">
                <input
                  type="radio"
                  name="rivals-winner"
                  checked={draft.winner === slot}
                  onChange={() => update(setWinner(draft, slot))}
                />
                Winner
              </label>
            </div>
            <ul className="match-player-list">
              {draft.rows
                .filter((row) => row.teamSlot === slot)
                .map((row) => {
                  const status = statuses[row.key] ?? 'unmatched'
                  const candidates = rowCandidates(row, players).candidates
                  const suggested = new Map(candidates.map((entry) => [entry.id, entry.score]))
                  return (
                    <li className="match-player rivals-row" key={row.key}>
                      <div className="rivals-row-fields">
                        <input
                          className="input"
                          value={row.username}
                          maxLength={64}
                          placeholder="Username"
                          aria-label="Detected username"
                          onChange={(event) =>
                            update(setUsername(draft, row.key, event.target.value))
                          }
                        />
                        <select
                          className="input"
                          aria-label={`Roster player for ${row.username || 'this row'}`}
                          value={
                            row.choice?.kind === 'roster' ? row.choice.playerId : ''
                          }
                          onChange={(event) =>
                            update(choosePlayer(draft, row.key, event.target.value))
                          }
                        >
                          <option value="">Not matched…</option>
                          {players.map((player) => {
                            const score = suggested.get(player.id)
                            const suffix =
                              score !== undefined && score < 1
                                ? ` · similar ${percent(score)}`
                                : ''
                            return (
                              <option key={player.id} value={player.id}>
                                {player.name}
                                {player.username ? ` (${player.username})` : ''}
                                {suffix}
                              </option>
                            )
                          })}
                        </select>
                        <input
                          className="damage-input"
                          type="text"
                          inputMode="numeric"
                          placeholder="dmg"
                          aria-label={`Damage for ${row.username || 'this row'}`}
                          value={row.damage}
                          onChange={(event) =>
                            update(setDamage(draft, row.key, event.target.value))
                          }
                        />
                      </div>
                      <div className="rivals-row-meta">
                        <span className={`chip ${STATUS_TONE[status]}`.trim()}>
                          {STATUS_LABEL[status]}
                        </span>
                        <span className="rivals-confidence">
                          name {percent(row.usernameConfidence)} · dmg{' '}
                          {percent(row.damageConfidence)}
                        </span>
                        {row.issues.map((issue, index) => (
                          <span className="rivals-issue" key={index}>
                            {issue}
                          </span>
                        ))}
                        <div className="rivals-row-actions">
                          <button
                            type="button"
                            className="quiet"
                            onClick={() => update(markRandom(draft, row.key))}
                          >
                            {row.choice?.kind === 'random'
                              ? 'Untracked random'
                              : 'Mark random'}
                          </button>
                          <button
                            type="button"
                            className="quiet"
                            onClick={() =>
                              update(moveRow(draft, row.key, slot === 0 ? 1 : 0))
                            }
                          >
                            To team {slot === 0 ? 2 : 1}
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Remove ${row.username || 'row'} from the match`}
                            onClick={() => update(removeRow(draft, row.key))}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    </li>
                  )
                })}
            </ul>
          </div>
        ))}
      </div>

      {stage === 'uncertain' && error && (
        <div className="rivals-uncertain" role="alert">
          <p className="error">{error}</p>
          <button type="button" className="quiet" onClick={() => void checkLog()}>
            Check the match log
          </button>
        </div>
      )}

      {stage !== 'uncertain' && error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}

      {outcome && !outcome.ok && (
        <ul className="rivals-errors" role="alert">
          {outcome.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      <div className="match-actions">
        <button
          type="button"
          className="primary"
          disabled={stage === 'saving' || stage === 'uncertain' || !outcome?.ok}
          onClick={() => void submit()}
        >
          {stage === 'saving' ? 'Logging…' : 'Log match'}
        </button>
        <button type="button" className="quiet" onClick={reset}>
          Reject screenshot
        </button>
        <span className="hint">
          Review every row: OCR can misread names and damage, and nothing is
          submitted until this form is valid.
        </span>
      </div>
    </div>
  )
}
