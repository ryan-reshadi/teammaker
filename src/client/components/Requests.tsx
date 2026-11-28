import { useState } from 'react'
import type { GroupPlayerRequest, InvitePlayer } from '../../shared/types'

/** A claim on a roster player, or a proposal for a new one. */
export type Claim =
  | { kind: 'link'; playerId: string }
  | { kind: 'create'; name: string; username: string }

export type ClaimPayload = { claim: Claim; note: string; email: string }

const problem = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.'

/** The same shape the server stores: one @, a dot in the domain, no spaces. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * "Which player are you": claim someone already on the roster, or ask for a new
 * player. There is no elo control — a new player starts at 0 and an existing
 * one keeps the rating its history earned. Nothing is applied here: the caller
 * sends it as a request.
 */
export function PlayerClaimForm({
  players,
  accountEmail,
  submitLabel,
  busy,
  onSubmit,
}: {
  players: InvitePlayer[]
  /** The signed-in account's email; when empty the visitor types one. */
  accountEmail?: string
  submitLabel: string
  busy: boolean
  onSubmit: (payload: ClaimPayload) => void
}) {
  const [mode, setMode] = useState<'link' | 'create'>(
    players.length > 0 ? 'link' : 'create',
  )
  const [playerId, setPlayerId] = useState('')
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')

  const account = accountEmail?.trim() ?? ''
  const typedEmail = email.trim()
  // The address is normalised here, so the request carries what D1 will store.
  const chosenEmail = (account || typedEmail).toLowerCase()
  const emailReady = EMAIL_SHAPE.test(chosenEmail)
  const ready =
    emailReady &&
    (mode === 'link'
      ? Boolean(playerId)
      : Boolean(name.trim() && username.trim()))

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    onSubmit({
      claim:
        mode === 'link'
          ? { kind: 'link', playerId }
          : { kind: 'create', name: name.trim(), username: username.trim() },
      note: note.trim(),
      email: chosenEmail,
    })
  }

  return (
    <form className="claim-form" onSubmit={submit}>
      <div
        className="claim-modes"
        role="radiogroup"
        aria-label="Which player are you?"
      >
        {players.length > 0 && (
          <label className="claim-mode">
            <input
              type="radio"
              name="claim-mode"
              checked={mode === 'link'}
              onChange={() => setMode('link')}
            />
            I'm already on the roster
          </label>
        )}
        <label className="claim-mode">
          <input
            type="radio"
            name="claim-mode"
            checked={mode === 'create'}
            onChange={() => setMode('create')}
          />
          I'm new here
        </label>
      </div>

      {mode === 'link' ? (
        <label className="field">
          <span>Your player</span>
          <select
            className="input"
            value={playerId}
            aria-label="Your player on the roster"
            onChange={(event) => setPlayerId(event.target.value)}
          >
            <option value="">Choose your player…</option>
            {players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
                {player.username ? ` (@${player.username})` : ''} —{' '}
                {player.elo} elo
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label className="field">
            <span>Display name</span>
            <input
              className="input"
              maxLength={40}
              placeholder="Name on the roster"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Username</span>
            <input
              className="input"
              maxLength={32}
              placeholder="Handle"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <p className="hint">
            A new player starts at 0 elo with no tags. Editors can rate them
            after their first match.
          </p>
        </>
      )}

      <label className="field">
        <span>Email to connect</span>
        {account ? (
          <span className="claim-email">{account}</span>
        ) : (
          <>
            <input
              className="input"
              type="email"
              maxLength={254}
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            {typedEmail !== '' && !emailReady && (
              <span className="hint claim-email-hint">
                That does not look like an email address yet.
              </span>
            )}
          </>
        )}
      </label>

      <label className="field">
        <span>Note for the group (optional)</span>
        <textarea
          className="input claim-note"
          rows={3}
          maxLength={280}
          placeholder="Say who you are, so an editor knows it's you."
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      <button className="primary" disabled={!ready || busy}>
        {busy ? 'Sending…' : submitLabel}
      </button>
    </form>
  )
}

/** Editors apply or dismiss the pending claims on roster players. */
export function RequestsDialog({
  requests,
  onClose,
  onApprove,
  onDismiss,
}: {
  requests: GroupPlayerRequest[]
  onClose: () => void
  onApprove: (id: string) => Promise<void>
  onDismiss: (id: string) => Promise<void>
}) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const run = async (id: string, action: () => Promise<void>) => {
    setBusy(id)
    setError('')
    try {
      await action()
    } catch (problemValue) {
      setError(problem(problemValue))
    } finally {
      setBusy('')
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Player requests"
    >
      <div className="dialog request-dialog">
        <h2>Player requests</h2>
        <p className="hint">
          People who joined with a link can ask to be connected to a player.
          Approving applies the change; nothing is connected until you do.
        </p>
        {requests.length === 0 ? (
          <p className="empty-state">No requests are waiting.</p>
        ) : (
          <ul className="request-list">
            {requests.map((request) => (
              <li key={request.id}>
                <div className="request-line">
                  <strong>{request.requesterName}</strong>
                  <span className="muted">{request.email}</span>
                  <span className="muted">
                    {new Date(request.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p>
                  {request.kind === 'create'
                    ? `Add “${request.name}”${request.username ? ` (@${request.username})` : ''} as a new player at 0 elo.`
                    : `Connect this email to “${request.playerName ?? 'a player that has since been removed'}”.`}
                </p>
                {request.note && (
                  <p className="request-note">“{request.note}”</p>
                )}
                <div className="request-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void run(request.id, () => onApprove(request.id))
                    }
                  >
                    {busy === request.id ? 'Applying…' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    className="quiet danger"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void run(request.id, () => onDismiss(request.id))
                    }
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The same claim form for a member who joined without connecting, or who wants
 * a different player later.
 */
export function ConnectDialog({
  players,
  accountEmail,
  onClose,
  onSubmit,
}: {
  players: InvitePlayer[]
  accountEmail?: string
  onClose: () => void
  onSubmit: (payload: ClaimPayload) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  const submit = async (payload: ClaimPayload) => {
    setBusy(true)
    setError('')
    try {
      await onSubmit(payload)
      setSent(true)
    } catch (problemValue) {
      setError(problem(problemValue))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Connect a player"
    >
      <div className="dialog claim-dialog">
        <h2>Connect a player</h2>
        {sent ? (
          <>
            <p>Request sent. A group editor will apply it.</p>
            <div className="dialog-actions">
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="hint">
              Ask an editor to connect your email to the player you play as.
              Nothing changes until they approve it.
            </p>
            <PlayerClaimForm
              players={players}
              accountEmail={accountEmail}
              submitLabel="Send request"
              busy={busy}
              onSubmit={(payload) => void submit(payload)}
            />
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" className="quiet" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
