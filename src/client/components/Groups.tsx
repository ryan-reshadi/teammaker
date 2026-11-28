import { useEffect, useState } from 'react'
import type {
  GroupDetail,
  GroupInvite,
  GroupInvitePreview,
  GroupTag,
} from '../../shared/types'
import { PlayerClaimForm, type ClaimPayload } from './Requests'

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok)
    throw new Error(body.error || 'That change could not be saved.')
  return body
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const problem = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.'

const roleLabel = (role: string) =>
  role === 'owner' ? 'Owner' : role === 'editor' ? 'Can edit' : 'View only'

export function NewGroupDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await onCreate(name.trim())
      onClose()
    } catch (problemValue) {
      setError(problem(problemValue))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="New group">
      <form className="dialog" onSubmit={submit}>
        <h2>New group</h2>
        <p className="hint">
          A group is a roster, its elo history and its own skill tags. Make one
          per game or friend circle.
        </p>
        <input
          className="input"
          autoFocus
          maxLength={40}
          placeholder="Group name — e.g. Tuesday RIVALS"
          aria-label="Group name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {error && <p role="alert" className="error">{error}</p>}
        <div className="dialog-actions">
          <button className="primary" disabled={!name.trim() || busy}>
            {busy ? 'Creating…' : 'Create group'}
          </button>
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

export function ShareDialog({
  group,
  onClose,
  onChanged,
}: {
  group: GroupDetail
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [invites, setInvites] = useState<GroupInvite[]>([])
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer')
  const [created, setCreated] = useState<{ url: string; role: string } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const base = `/api/groups/${encodeURIComponent(group.id)}`

  const loadInvites = async () => {
    try {
      const body = await api<{ invites: GroupInvite[] }>(`${base}/invites`)
      setInvites(body.invites)
    } catch (problemValue) {
      setError(problem(problemValue))
    }
  }

  useEffect(() => {
    void loadInvites()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id])

  const create = async () => {
    setError('')
    setCreated(null)
    try {
      const body = await api<{ invite: GroupInvite }>(
        `${base}/invites`,
        json('POST', { role }),
      )
      setCreated({ url: body.invite.url ?? '', role })
      await loadInvites()
    } catch (problemValue) {
      setError(problem(problemValue))
    }
  }

  const copy = async () => {
    if (!created?.url) return
    try {
      await navigator.clipboard.writeText(created.url)
      setNotice('Link copied')
    } catch {
      setNotice('Select the link and copy it')
    }
    window.setTimeout(() => setNotice(''), 2500)
  }

  const revoke = async (id: string) => {
    setError('')
    try {
      await api(`${base}/invites/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await loadInvites()
    } catch (problemValue) {
      setError(problem(problemValue))
    }
  }

  const changeRole = async (id: string, next: 'editor' | 'viewer') => {
    setError('')
    try {
      await api(`${base}/members/${encodeURIComponent(id)}`, json('PATCH', { role: next }))
      await onChanged()
    } catch (problemValue) {
      setError(problem(problemValue))
    }
  }

  const remove = async (id: string) => {
    setError('')
    try {
      await api(`${base}/members/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await onChanged()
    } catch (problemValue) {
      setError(problem(problemValue))
    }
  }

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Share group">
      <div className="dialog share-dialog">
        <h2>Share “{group.name}”</h2>
        <p className="hint">
          Anyone signed in who opens the link joins this group. Owner-only
          controls stay here; members can be changed or removed at any time.
        </p>

        <div className="share-create">
          <select
            className="input"
            value={role}
            aria-label="Role for the new invite link"
            onChange={(event) =>
              setRole(event.target.value === 'editor' ? 'editor' : 'viewer')
            }
          >
            <option value="viewer">Can view and build teams</option>
            <option value="editor">Can edit players, elo and matches</option>
          </select>
          <button type="button" className="primary" onClick={() => void create()}>
            Create invite link
          </button>
        </div>
        {created && (
          <div className="invite-link">
            <input
              className="input"
              readOnly
              aria-label="Invite link"
              value={created.url}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="quiet" onClick={() => void copy()}>
              {notice || 'Copy'}
            </button>
            <span className="hint">{roleLabel(created.role)}</span>
          </div>
        )}

        {invites.length > 0 && (
          <div className="share-section">
            <h3>Active links</h3>
            <ul className="member-list">
              {invites.map((invite) => (
                <li key={invite.id}>
                  <span>{roleLabel(invite.role)}</span>
                  <span className="muted">
                    {new Date(invite.createdAt).toLocaleDateString()}
                  </span>
                  <button
                    type="button"
                    className="quiet danger"
                    onClick={() => void revoke(invite.id)}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="share-section">
          <h3>People with access</h3>
          <ul className="member-list">
            {group.members.map((member) => (
              <li key={member.id}>
                <span className="member-name">
                  {member.name}
                  {member.isYou ? ' (you)' : ''}
                </span>
                {member.role === 'owner' ? (
                  <span className="chip">Owner</span>
                ) : (
                  <>
                    <select
                      className="input member-role"
                      value={member.role}
                      aria-label={`Role for ${member.name}`}
                      onChange={(event) =>
                        void changeRole(
                          member.id,
                          event.target.value === 'editor' ? 'editor' : 'viewer',
                        )
                      }
                    >
                      <option value="viewer">Can view</option>
                      <option value="editor">Can edit</option>
                    </select>
                    <button
                      type="button"
                      className="quiet danger"
                      onClick={() => void remove(member.id)}
                    >
                      Remove
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>

        {error && <p role="alert" className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

export function GroupSettingsDialog({
  group,
  canDelete,
  onClose,
  onSaved,
  onDeleted,
}: {
  group: GroupDetail
  canDelete: boolean
  onClose: () => void
  onSaved: (group: GroupDetail) => void
  onDeleted: () => Promise<void>
}) {
  const [name, setName] = useState(group.name)
  const [kDraft, setKDraft] = useState(String(group.kFactor))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const base = `/api/groups/${encodeURIComponent(group.id)}`

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    const kFactor = Number(kDraft)
    if (!Number.isInteger(kFactor) || kFactor < 8 || kFactor > 64) {
      setError('K is a whole number from 8 to 64.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const body = await api<{ group: GroupDetail }>(
        base,
        json('PATCH', { name: name.trim(), kFactor }),
      )
      onSaved(body.group)
      onClose()
    } catch (problemValue) {
      setError(problem(problemValue))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete “${group.name}”? Its players and match log are archived, and members lose access.`))
      return
    setBusy(true)
    setError('')
    try {
      await api(base, { method: 'DELETE' })
      await onDeleted()
      onClose()
    } catch (problemValue) {
      setError(problem(problemValue))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Group settings">
      <form className="dialog" onSubmit={save}>
        <h2>Group settings</h2>
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>K for new matches</span>
          <input
            className="input"
            type="number"
            min={8}
            max={64}
            step={1}
            value={kDraft}
            onChange={(event) => setKDraft(event.target.value)}
          />
          <span className="hint">
            Applies to future matches in this group only. Past ratings stay as rated.
          </span>
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="dialog-actions">
          <button className="primary" disabled={busy || !name.trim()}>
            Save
          </button>
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          {canDelete && (
            <button
              type="button"
              className="quiet danger push-right"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete group
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

export function TagsDialog({
  tags,
  onClose,
  onAdd,
  onRename,
  onDelete,
}: {
  tags: GroupTag[]
  onClose: () => void
  onAdd: (label: string, short: string) => Promise<void>
  onRename: (id: string, label: string, short: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [label, setLabel] = useState('')
  const [short, setShort] = useState('')
  const [drafts, setDrafts] = useState<Record<string, { label: string; short: string }>>({})
  const [error, setError] = useState('')

  const draftFor = (tag: GroupTag) =>
    drafts[tag.id] ?? { label: tag.label, short: tag.short }

  const update = (tag: GroupTag, patch: Partial<{ label: string; short: string }>) =>
    setDrafts((previous) => ({
      ...previous,
      [tag.id]: { ...draftFor(tag), ...patch },
    }))

  const run = async (action: () => Promise<void>) => {
    setError('')
    try {
      await action()
    } catch (problemValue) {
      setError(problem(problemValue))
    }
  }

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Skill tags">
      <div className="dialog tag-dialog">
        <h2>Skill tags</h2>
        <p className="hint">
          Tags belong to this group. The team builder prefers splits that spread
          tags every team can have; deleting a tag removes it from its players.
        </p>
        <ul className="tag-list">
          {tags.map((tag) => (
            <li key={tag.id}>
              <input
                className="input"
                maxLength={24}
                aria-label={`Label for ${tag.label}`}
                value={draftFor(tag).label}
                onChange={(event) => update(tag, { label: event.target.value })}
              />
              <input
                className="input tag-short"
                maxLength={3}
                aria-label={`Short form for ${tag.label}`}
                value={draftFor(tag).short}
                onChange={(event) => update(tag, { short: event.target.value })}
              />
              <button
                type="button"
                className="quiet"
                disabled={!draftFor(tag).label.trim()}
                onClick={() =>
                  void run(async () => {
                    await onRename(tag.id, draftFor(tag).label.trim(), draftFor(tag).short.trim())
                    setDrafts((previous) => {
                      const next = { ...previous }
                      delete next[tag.id]
                      return next
                    })
                  })
                }
              >
                Save
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete ${tag.label}`}
                title={`Delete ${tag.label}`}
                onClick={() => void run(() => onDelete(tag.id))}
              >
                ×
              </button>
            </li>
          ))}
          {tags.length === 0 && (
            <li className="muted">No tags yet — add the ones this group uses.</li>
          )}
        </ul>
        <form
          className="tag-add"
          onSubmit={(event) => {
            event.preventDefault()
            if (!label.trim()) return
            void run(async () => {
              await onAdd(label.trim(), short.trim())
              setLabel('')
              setShort('')
            })
          }}
        >
          <input
            className="input"
            maxLength={24}
            placeholder="New tag — e.g. AWPer"
            aria-label="New tag label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <input
            className="input tag-short"
            maxLength={3}
            placeholder="SN"
            aria-label="New tag short form"
            value={short}
            onChange={(event) => setShort(event.target.value)}
          />
          <button className="primary" disabled={!label.trim()}>
            Add tag
          </button>
        </form>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

export function JoinPanel({
  token,
  signedIn,
  email,
  onClaimedEmail,
  onDone,
}: {
  token: string
  signedIn: boolean
  /** The signed-in account's email, shown on the claim form. */
  email?: string
  /** The address the visitor asked to connect, so this device can recognise it. */
  onClaimedEmail?: (groupId: string, email: string) => void
  onDone: (groupId: string) => void
}) {
  const [preview, setPreview] = useState<GroupInvitePreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const body = await api<{ invite: GroupInvitePreview }>(
          `/api/invites/${encodeURIComponent(token)}`,
        )
        if (live) setPreview(body.invite)
      } catch (problemValue) {
        if (live) setError(problem(problemValue))
      }
    })()
    return () => {
      live = false
    }
  }, [token])

  /** Joining is immediate; a claim rides along as a pending request. */
  const accept = async (payload?: ClaimPayload) => {
    setBusy(true)
    setError('')
    try {
      const body = await api<{ group: { id: string } }>(
        `/api/invites/${encodeURIComponent(token)}/accept`,
        payload ? json('POST', payload) : { method: 'POST' },
      )
      if (payload) onClaimedEmail?.(body.group.id, payload.email)
      onDone(body.group.id)
    } catch (problemValue) {
      setError(problem(problemValue))
      setBusy(false)
    }
  }

  return (
    <div className="join-page">
      <div className="dialog join-dialog">
        <span className="brand-name">Teammaker</span>
        {error && !preview ? (
          <>
            <h1>Invite unavailable</h1>
            <p role="alert" className="error">{error}</p>
            <a className="link-button" href="/">Back to Teammaker</a>
          </>
        ) : !preview ? (
          <p>Checking the invite…</p>
        ) : !signedIn ? (
          <>
            <h1>Join “{preview.name}”</h1>
            <p>
              You are joining as <strong>{roleLabel(preview.role)}</strong>.
              Sign in with Freebuff to accept the invite and see the group's
              roster and ratings.
            </p>
            <a
              className="primary link-button"
              href={`/auth/freebuff/signin?returnTo=${encodeURIComponent(`/join/${token}`)}`}
            >
              Sign in to join
            </a>
          </>
        ) : (
          <>
            <h1>Join “{preview.name}”</h1>
            <p>
              You are joining as <strong>{roleLabel(preview.role)}</strong>.
              Pick the player you are and an editor will connect your email to
              them; you can also join now and ask later.
            </p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <PlayerClaimForm
              players={preview.players}
              accountEmail={email}
              submitLabel="Send request and join"
              busy={busy}
              onSubmit={(payload) => void accept(payload)}
            />
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => void accept()}
              >
                Continue without connecting
              </button>
              <a className="quiet link-button" href="/">
                Not now
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
