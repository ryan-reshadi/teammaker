import { useEffect, useMemo, useRef, useState } from 'react'
import type { MatchInput } from '../../shared/elo'
import {
  RIVALS_ACCEPTED_TYPES,
  RIVALS_MAX_BYTES,
  type RosterMatchStatus,
  type RivalsScan,
} from '../../shared/rivals'
import type { Player } from '../../shared/types'
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
  onScan: (
    file: File,
    onProgress?: (message: string) => void,
    signal?: AbortSignal,
  ) => Promise<RivalsScan>
  onSave: (input: MatchInput) => Promise<void>
  onRefresh: () => Promise<void>
  /** How long a scan may run before it is stopped. Tests pass a short budget. */
  scanTimeoutMs?: number
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
 * A cold import downloads ~28 MB of engine and models before it reads anything,
 * which is minutes on a slow connection — so the ceiling is deliberately far
 * above any honest scan. It is the backstop that stops a wedged engine from
 * parking the panel on "Reading the scoreboard…" with no way out; the Cancel
 * button is the fast path for someone who is merely impatient.
 */
const SCAN_TIMEOUT_MS = 300_000

/**
 * Upload → OCR → review → the existing match form. Nothing here records a
 * match itself: a confirmed review becomes a plain `MatchInput` and goes
 * through the same authenticated route the manual form uses.
 */
export function RivalsImport({
  players,
  onScan,
  onSave,
  onRefresh,
  scanTimeoutMs = SCAN_TIMEOUT_MS,
}: Props) {
  const [stage, setStage] = useState<Stage>('idle')
  const [draft, setDraft] = useState<ImportDraft | null>(null)
  const [preview, setPreview] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [progress, setProgress] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const previewRef = useRef('')
  const scanRef = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      scanRef.current?.abort()
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    },
    [],
  )

  /**
   * Ctrl+V, while the panel is waiting for a screenshot.
   *
   * A capture is usually already on the clipboard — Print Screen and every
   * snipping tool put it there — so choosing it through the file picker again is
   * the slow path. The listener sits on the document because nothing in this
   * stage is focused and the drop zone cannot hold focus; it is attached only in
   * the idle stage, so a paste cannot replace a scan in progress or a review the
   * user is working through.
   */
  useEffect(() => {
    if (stage !== 'idle') return
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items
      if (!items) return
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        if (!item || item.kind !== 'file' || !item.type.startsWith('image/')) continue
        const file = item.getAsFile()
        if (!file) continue
        event.preventDefault()
        acceptFile(file)
        return
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [stage])

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
    setProgress('Preparing the screenshot…')
    setError('')
    setNotice('')

    // A scan cannot be interrupted mid-inference, so it stops between passes:
    // the scanner checks this signal before each OCR call. The timer is the
    // backstop that keeps a wedged import from parking the panel forever.
    const controller = new AbortController()
    scanRef.current = controller
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, scanTimeoutMs)

    try {
      const scan = await onScan(file, setProgress, controller.signal)
      // Cancelled after the last pass: `cancelScan` already reset the panel.
      if (controller.signal.aborted) return
      setDraft(draftFromScan(scan, players))
      setStage('review')
      setProgress('')
    } catch (problem) {
      if (controller.signal.aborted) {
        if (timedOut) {
          const seconds = Math.max(1, Math.round(scanTimeoutMs / 1000))
          setProgress('')
          clearPreview()
          setDraft(null)
          setStage('idle')
          setError(
            `The scan took longer than ${seconds} ${
              seconds === 1 ? 'second' : 'seconds'
            } and was stopped. Nothing was saved — try again, or log the match by hand.`,
          )
          if (inputRef.current) inputRef.current.value = ''
        }
        return
      }
      setProgress('')
      clearPreview()
      setDraft(null)
      setStage('idle')
      setError(
        problem instanceof Error
          ? problem.message
          : 'That screenshot could not be read.',
      )
      if (inputRef.current) inputRef.current.value = ''
    } finally {
      clearTimeout(timer)
      if (scanRef.current === controller) scanRef.current = null
    }
  }

  /**
   * Stops the scan and returns to the upload screen. The engine keeps whatever
   * pass it is in until that pass returns; its result is then discarded by the
   * aborted branch in `runScan`.
   */
  const cancelScan = () => {
    const controller = scanRef.current
    if (!controller) return
    scanRef.current = null
    controller.abort()
    setProgress('')
    clearPreview()
    setDraft(null)
    setStage('idle')
    setError('Scan cancelled. Nothing was saved.')
    if (inputRef.current) inputRef.current.value = ''
  }

  /**
   * One gate for every way a screenshot arrives: the file picker and the
   * clipboard are validated against the same type and size rules, so a pasted
   * image cannot skip a check an uploaded one has to pass.
   */
  const acceptFile = (file: File) => {
    const limit = RIVALS_MAX_BYTES
    const types: readonly string[] = RIVALS_ACCEPTED_TYPES
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

  const chooseFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) acceptFile(file)
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
        <div className="rivals-upload">
          <label className="rivals-drop" htmlFor="rivals-file">
            <span className="rivals-drop-title">
              Import from RIVALS Screenshot
            </span>
            <span className="rivals-drop-hint">
              Upload a screenshot of the in-game Tab scoreboard, or press Ctrl+V
              to paste one from the clipboard. Teams are read from the row
              colours (gold and purple), damage from the DMG column and the
              winner from the two team scores.
            </span>
            <input
              id="rivals-file"
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={stage === 'scanning'}
              onChange={chooseFile}
            />
          </label>
          <p className="hint">
            PNG, JPEG or WebP up to 8 MB. The screenshot is read on this device
            and is never uploaded or stored.
          </p>
        </div>
        {stage === 'scanning' && (
          <div className="rivals-scanning">
            {preview && (
              <img className="rivals-preview" src={preview} alt="Uploaded scoreboard" />
            )}
            <p className="rivals-progress" role="status">
              {progress || 'Reading the scoreboard…'}
            </p>
            <button type="button" className="quiet" onClick={cancelScan}>
              Cancel scan
            </button>
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
