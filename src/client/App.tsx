import { useCallback, useEffect, useMemo, useState } from 'react'
import { suggestSitOuts } from '../shared/balance'
import { sitOutCounts } from '../shared/bench'
import {
  DEFAULT_K_FACTOR,
  ratingFromPatch,
  type MatchInput,
  type MatchesResponse,
  type RatingEventView,
  type SquashInfo,
} from '../shared/elo'
import type {
  GroupDetail,
  GroupRole,
  GroupSummary,
  GroupTag,
  Player,
  Round,
  RoundConfig,
  Session,
} from '../shared/types'
import { Build } from './components/Build'
import { GroupSettingsDialog, JoinPanel, NewGroupDialog, ShareDialog, TagsDialog } from './components/Groups'
import { History } from './components/History'
import { Matches } from './components/Matches'
import { Roster } from './components/Roster'
import {
  importLegacyRounds,
  readActiveGroupId,
  readGuestTags,
  readLocalRounds,
  readSitOuts,
  removeLocalRound,
  saveLocalRound,
  wereLegacyRoundsImported,
  writeActiveGroupId,
  writeGuestTags,
  writeSitOuts,
} from './localState'
import {
  createStore,
  readLocalPlayers,
  type PlayerDraft,
  type PlayerPatch,
  type Store,
} from './store'

const message = (problemValue: unknown) =>
  problemValue instanceof Error
    ? problemValue.message
    : 'Something went wrong. Please try again.'

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok)
    throw new Error(body.error || 'The request failed. Please try again.')
  return body
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const roleName = (role: GroupRole) =>
  role === 'owner' ? 'Owner' : role === 'editor' ? 'Can edit' : 'View only'

/** Keep the elo and its 1-10 mirror consistent while a request is in flight. */
function applyPatch(player: Player, patch: PlayerPatch): Player {
  return { ...player, ...patch, ...ratingFromPatch(player, patch) }
}

/**
 * Load the two store sections together. One that fails must not blank the one
 * that answered, so each is applied on its own and one message covers the rest.
 */
async function loadWorkspace(store: Store) {
  const [players, matches] = await Promise.allSettled([
    store.players(),
    store.matches(),
  ])
  const failed = [players, matches].find((result) => result.status === 'rejected')
  return {
    players: players.status === 'fulfilled' ? players.value : null,
    matches: matches.status === 'fulfilled' ? matches.value : null,
    failure: failed?.status === 'rejected' ? message(failed.reason) : null,
  }
}

const initialJoinToken = () => {
  const match = window.location.pathname.match(/^\/join\/(.+)$/)
  return match ? decodeURIComponent(match[1]!) : null
}

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [groups, setGroups] = useState<GroupSummary[]>([])
  const [group, setGroup] = useState<GroupDetail | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [guestTags, setGuestTags] = useState<GroupTag[]>([])
  const [players, setPlayers] = useState<Player[]>([])
  const [rounds, setRounds] = useState<Round[]>([])
  const [sitOuts, setSitOuts] = useState<string[]>([])
  const [events, setEvents] = useState<RatingEventView[]>([])
  const [kFactor, setKFactor] = useState(DEFAULT_K_FACTOR)
  const [squashed, setSquashed] = useState<SquashInfo | null>(null)
  const [teamCount, setTeamCount] = useState(3)
  const [tolerance, setTolerance] = useState(300)
  const [error, setError] = useState('')
  const [offline, setOffline] = useState(false)
  const [saved, setSaved] = useState('')
  const [live, setLive] = useState('')
  const [importable, setImportable] = useState<Player[]>([])
  const [ready, setReady] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [dialog, setDialog] = useState<
    null | 'new' | 'share' | 'settings' | 'tags'
  >(null)
  const [joinToken, setJoinToken] = useState<string | null>(initialJoinToken)

  const remote = Boolean(session?.user && session.database)

  const guestGroup = useMemo<GroupDetail | null>(() => {
    if (!session || remote) return null
    return {
      id: 'local',
      name: 'This device',
      role: 'owner',
      kFactor: DEFAULT_K_FACTOR,
      rev: 0,
      playerCount: players.length,
      memberCount: 1,
      updatedAt: 0,
      ownerName: 'You',
      tags: guestTags,
      members: [],
    }
  }, [session, remote, players.length, guestTags])
  const activeGroup: GroupDetail | null = remote ? group : guestGroup
  const role: GroupRole = activeGroup?.role ?? 'viewer'
  const canEdit = role !== 'viewer'
  const groupBase = activeId ? `/api/groups/${encodeURIComponent(activeId)}` : ''

  const store = useMemo<Store | null>(
    () => (session && activeId ? createStore(remote, activeId) : null),
    [session, remote, activeId],
  )

  /** The match log arrives whole: every response carries all three fields. */
  const applyMatches = useCallback((loaded: MatchesResponse) => {
    setEvents(loaded.events)
    setKFactor(loaded.kFactor)
    setSquashed(loaded.squashed)
  }, [])

  useEffect(() => {
    let liveRequest = true
    void (async () => {
      try {
        const response = await fetch('/api/session')
        const current = (await response.json()) as Session
        if (liveRequest) setSession(current)
      } catch {
        if (!liveRequest) return
        setSession({ user: null, mode: 'setup', database: false })
        setOffline(true)
      }
    })()
    return () => {
      liveRequest = false
    }
  }, [])

  const refreshGroups = useCallback(
    async (preferId?: string): Promise<GroupSummary[]> => {
      const body = await api<{ groups: GroupSummary[] }>('/api/groups')
      setGroups(body.groups)
      const stored = preferId ?? readActiveGroupId()
      const next =
        body.groups.find((entry) => entry.id === stored) ?? body.groups[0] ?? null
      setActiveId(next?.id ?? null)
      if (!next) {
        setGroup(null)
        setReady(true)
      }
      return body.groups
    },
    [],
  )

  useEffect(() => {
    if (!session) return
    if (!remote) {
      setGroups([])
      setActiveId('local')
      setGroup(null)
      setGuestTags(readGuestTags())
      return
    }
    let liveRequest = true
    setReady(false)
    void (async () => {
      try {
        const list = await api<{ groups: GroupSummary[] }>('/api/groups')
        if (!liveRequest) return
        setGroups(list.groups)
        const stored = readActiveGroupId()
        const next =
          list.groups.find((entry) => entry.id === stored) ?? list.groups[0] ?? null
        setActiveId(next?.id ?? null)
        if (!next) {
          setGroup(null)
          setReady(true)
        }
      } catch (problemValue) {
        if (liveRequest) {
          setError(message(problemValue))
          setReady(true)
        }
      }
    })()
    return () => {
      liveRequest = false
    }
  }, [session, remote])

  useEffect(() => {
    if (!session || !activeId) return
    let liveRequest = true
    setReady(false)
    void (async () => {
      try {
        const current = createStore(remote, activeId)
        const loaded = await loadWorkspace(current)
        if (!liveRequest) return
        if (loaded.players) setPlayers(loaded.players)
        if (loaded.matches) applyMatches(loaded.matches)
        setRounds(readLocalRounds(activeId))
        setSitOuts(readSitOuts(activeId))
        setError(loaded.failure ?? '')
        if (remote) {
          const response = await fetch(
            `/api/groups/${encodeURIComponent(activeId)}`,
          )
          const body = (await response.json().catch(() => null)) as {
            group?: GroupDetail
            error?: string
          } | null
          if (!liveRequest) return
          if (response.ok && body?.group) {
            setGroup(body.group)
            // Snaps saved before groups lived on the account. Bring them into
            // this browser once; the server copy stays read-only.
            if (
              body.group.role === 'owner' &&
              !wereLegacyRoundsImported(activeId)
            ) {
              const legacyResponse = await fetch(
                `/api/groups/${encodeURIComponent(activeId)}/rounds`,
                { cache: 'no-store' },
              )
              if (legacyResponse.ok) {
                const legacy = (await legacyResponse.json().catch(() => null)) as {
                  rounds?: Round[]
                } | null
                const merged = importLegacyRounds(activeId, legacy?.rounds ?? [])
                if (merged && liveRequest) setRounds(merged)
              }
            }
          } else if (body?.error) setError(body.error)
        }
      } catch (problemValue) {
        if (liveRequest) setError(message(problemValue))
      } finally {
        if (liveRequest) setReady(true)
      }
    })()
    return () => {
      liveRequest = false
    }
  }, [session, remote, activeId, nonce, applyMatches])

  const reloadGroup = useCallback(async () => {
    if (!remote || !activeId) return
    const response = await fetch(`/api/groups/${encodeURIComponent(activeId)}`)
    const body = (await response.json().catch(() => null)) as {
      group?: GroupDetail
    } | null
    if (response.ok && body?.group) setGroup(body.group)
  }, [remote, activeId])

  const reloadWorkspace = useCallback(async () => {
    if (!activeId) return
    const loaded = await loadWorkspace(createStore(remote, activeId))
    // Live sync stays all-or-nothing: never mix a new roster with an old log.
    if (loaded.failure) return
    if (loaded.players) setPlayers(loaded.players)
    if (loaded.matches) applyMatches(loaded.matches)
    await reloadGroup()
  }, [activeId, remote, reloadGroup, applyMatches])

  /** Membership can be revoked while the tab is open; drop what was shared. */
  const loseAccess = useCallback(async () => {
    setGroup(null)
    setPlayers([])
    setEvents([])
    setRounds([])
    setSitOuts([])
    setLive('')
    setReady(true)
    setError('You no longer have access to this group.')
    await refreshGroups()
  }, [refreshGroups])

  // Live sync: every content write bumps the group's rev, so one small poll is
  // enough to know when to reload the authoritative data.
  useEffect(() => {
    if (!remote || !activeId || !group) return
    let cancelled = false
    let known = group.rev
    const tick = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const response = await fetch(
          `/api/groups/${encodeURIComponent(activeId)}/rev`,
          { cache: 'no-store' },
        )
        if (cancelled) return
        if (response.status === 404 || response.status === 403) {
          await loseAccess()
          return
        }
        if (!response.ok) return
        const body = (await response.json()) as { rev: number }
        if (body.rev === known) return
        known = body.rev
        await reloadWorkspace()
        if (!cancelled) {
          setLive('Updated from a teammate')
          window.setTimeout(() => setLive(''), 4000)
        }
      } catch {
        // A missed poll is harmless; the next one retries.
      }
    }
    const timer = window.setInterval(() => void tick(), 2500)
    const onFocus = () => void tick()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [remote, activeId, group, reloadWorkspace, loseAccess])

  // A guest who signs in can bring the roster from this device.
  useEffect(() => {
    if (!remote || !ready || !activeGroup?.id || !canEdit || players.length > 0) {
      setImportable((previous) => (previous.length === 0 ? previous : []))
      return
    }
    setImportable(readLocalPlayers())
  }, [remote, ready, activeGroup?.id, canEdit, players.length])

  const refreshMatches = useCallback(async () => {
    if (!store) return
    applyMatches(await store.matches())
  }, [store, applyMatches])

  const addPlayers = useCallback(
    async (drafts: PlayerDraft[]) => {
      if (!store || !canEdit) return
      try {
        const created = await store.addPlayers(drafts)
        setPlayers((previous) => [...previous, ...created])
        setError('')
      } catch (problemValue) {
        setError(message(problemValue))
      }
    },
    [store, canEdit],
  )

  const updatePlayer = useCallback(
    async (id: string, patch: PlayerPatch) => {
      if (!store || !canEdit) return
      setPlayers((previous) =>
        previous.map((player) =>
          player.id === id ? applyPatch(player, patch) : player,
        ),
      )
      try {
        const next = await store.updatePlayer(id, patch)
        setPlayers((previous) =>
          previous.map((player) => (player.id === id ? next : player)),
        )
        setError('')
        if (patch.skill !== undefined || patch.elo !== undefined)
          await refreshMatches()
      } catch (problemValue) {
        setError(message(problemValue))
        setPlayers(await store.players())
      }
    },
    [store, canEdit, refreshMatches],
  )

  const removePlayer = useCallback(
    async (id: string) => {
      if (!store || !canEdit) return
      setPlayers((previous) => previous.filter((player) => player.id !== id))
      try {
        await store.removePlayer(id)
        setError('')
        await refreshMatches()
      } catch (problemValue) {
        setError(message(problemValue))
        setPlayers(await store.players())
      }
    },
    [store, canEdit, refreshMatches],
  )

  const saveMatch = useCallback(
    async (input: MatchInput, id?: string) => {
      if (!store || !canEdit) return
      const next = id
        ? await store.updateMatch(id, input)
        : await store.addMatch(input)
      setPlayers(next)
      await refreshMatches()
      setError('')
    },
    [store, canEdit, refreshMatches],
  )

  const removeMatch = useCallback(
    async (id: string) => {
      if (!store || !canEdit) return
      const next = await store.removeMatch(id)
      setPlayers(next)
      await refreshMatches()
      setError('')
    },
    [store, canEdit, refreshMatches],
  )

  const moveMatch = useCallback(
    async (id: string, position: number) => {
      if (!store || !canEdit) return
      const next = await store.moveMatch(id, position)
      setPlayers(next)
      await refreshMatches()
      setError('')
    },
    [store, canEdit, refreshMatches],
  )

  const changeKFactor = useCallback(
    async (k: number) => {
      if (!store || !canEdit) return
      const next = await store.setKFactor(k)
      setPlayers(next.players)
      setKFactor(next.kFactor)
      await refreshMatches()
      await reloadGroup()
      setError('')
    },
    [store, canEdit, refreshMatches, reloadGroup],
  )

  const toggleSit = useCallback(
    (id: string) => {
      if (!activeId) return
      setSitOuts((previous) => {
        const next = previous.includes(id)
          ? previous.filter((entry) => entry !== id)
          : [...previous, id]
        writeSitOuts(activeId, next)
        return next
      })
    },
    [activeId],
  )

  const applySitOuts = useCallback(
    (ids: string[]) => {
      if (!activeId) return
      setSitOuts((previous) => {
        const next = [...new Set([...previous, ...ids])]
        writeSitOuts(activeId, next)
        return next
      })
    },
    [activeId],
  )

  const saveRound = useCallback(
    async (config: RoundConfig) => {
      if (!activeId) return
      const round: Round = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        config,
      }
      const next = saveLocalRound(activeId, round)
      setRounds(next)
      setSaved(`Round saved on this device · spread ${config.spread} elo`)
      window.setTimeout(() => setSaved(''), 3000)
    },
    [activeId],
  )

  const removeRound = useCallback(
    async (id: string) => {
      if (!activeId) return
      setRounds(removeLocalRound(activeId, id))
    },
    [activeId],
  )

  const createGroupAction = async (name: string) => {
    const body = await api<{ group: GroupSummary }>(
      '/api/groups',
      json('POST', { name }),
    )
    writeActiveGroupId(body.group.id)
    await refreshGroups(body.group.id)
    setNonce((value) => value + 1)
  }

  const deleteGroupAction = async () => {
    if (!activeId) return
    await api(groupBase, { method: 'DELETE' })
    writeActiveGroupId(null)
    await refreshGroups()
    setNonce((value) => value + 1)
  }

  const saveGroupSettings = (updated: GroupDetail) => {
    setGroup(updated)
    setGroups((previous) =>
      previous.map((entry) =>
        entry.id === updated.id
          ? { ...entry, name: updated.name, kFactor: updated.kFactor }
          : entry,
      ),
    )
  }

  const addTag = async (label: string, short: string) => {
    if (!remote) {
      const next = [
        ...guestTags,
        { id: crypto.randomUUID(), label, short, sort: guestTags.length },
      ]
      setGuestTags(next)
      writeGuestTags(next)
      return
    }
    await api(`${groupBase}/tags`, json('POST', { label, short }))
    await reloadGroup()
  }

  const renameTag = async (id: string, label: string, short: string) => {
    if (!remote) {
      const next = guestTags.map((tag) =>
        tag.id === id ? { ...tag, label, short } : tag,
      )
      setGuestTags(next)
      writeGuestTags(next)
      return
    }
    await api(`${groupBase}/tags/${encodeURIComponent(id)}`, json('PATCH', { label, short }))
    await reloadGroup()
  }

  const deleteTag = async (id: string) => {
    if (!remote) {
      const nextTags = guestTags.filter((tag) => tag.id !== id)
      setGuestTags(nextTags)
      writeGuestTags(nextTags)
      if (store) {
        const affected = players.filter((player) => player.tags.includes(id))
        for (const player of affected)
          await store.updatePlayer(player.id, {
            tags: player.tags.filter((tag) => tag !== id),
          })
        setPlayers(await store.players())
      }
      return
    }
    await api(`${groupBase}/tags/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await reloadWorkspace()
  }

  const importRoster = useCallback(async () => {
    if (!activeGroup || !canEdit || !store) return
    const guestList = readGuestTags()
    let targetTags = activeGroup.tags
    const byLabel = new Map(
      targetTags.map((tag) => [tag.label.toLowerCase(), tag.id]),
    )
    if (remote) {
      for (const tag of guestList) {
        const label = tag.label.toLowerCase()
        if (byLabel.has(label)) continue
        const created = await api<{ tag: GroupTag }>(
          `${groupBase}/tags`,
          json('POST', { label: tag.label, short: tag.short }),
        )
        targetTags = [...targetTags, created.tag]
        byLabel.set(created.tag.label.toLowerCase(), created.tag.id)
      }
      await reloadGroup()
    }
    const guestLabel = new Map(guestList.map((tag) => [tag.id, tag.label.toLowerCase()]))
    const drafts = importable.map((player) => ({
      name: player.name,
      username: player.username,
      skill: player.skill,
      tags: player.tags
        .map((tag) => byLabel.get(guestLabel.get(tag) ?? '') ?? '')
        .filter(Boolean),
    }))
    setImportable([])
    await addPlayers(drafts)
  }, [activeGroup, canEdit, store, remote, groupBase, importable, addPlayers, reloadGroup])

  const finishJoin = (groupId: string) => {
    writeActiveGroupId(groupId)
    setJoinToken(null)
    window.history.replaceState({}, '', '/')
    void refreshGroups(groupId).then(() => {
      setActiveId(groupId)
      setNonce((value) => value + 1)
    })
  }

  const bench = useMemo(
    () => sitOutCounts(events, rounds, players),
    [events, rounds, players],
  )
  const benchNote =
    bench.source === 'matches'
      ? `from ${bench.matchCount} logged ${bench.matchCount === 1 ? 'match' : 'matches'}`
      : bench.source === 'rounds'
        ? 'from saved rounds on this device'
        : 'so far'
  const suggestions = useMemo(
    () => suggestSitOuts(players, teamCount, bench.counts, sitOuts),
    [players, teamCount, bench.counts, sitOuts],
  )

  const accountName = session?.user?.name || session?.user?.email || 'Signed in'

  if (!session)
    return (
      <div className="app">
        <main className="page">
          <p className="empty-state">Loading…</p>
        </main>
      </div>
    )

  if (joinToken)
    return (
      <JoinPanel
        token={joinToken}
        signedIn={Boolean(session.user)}
        onDone={finishJoin}
      />
    )

  const showWorkspace = Boolean(activeGroup)

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="brand-name">Teammaker</span>
        </div>
        <div className="header-right">
          {remote ? (
            <div className="group-switcher">
              <select
                className="input group-select"
                value={activeId ?? ''}
                aria-label="Open group"
                onChange={(event) => {
                  const next = event.target.value
                  writeActiveGroupId(next)
                  setActiveId(next)
                  setGroup(null)
                  setNonce((value) => value + 1)
                }}
              >
                {groups.length === 0 && <option value="">No groups yet</option>}
                {groups.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="quiet"
                onClick={() => setDialog('new')}
              >
                + New
              </button>
            </div>
          ) : (
            <span className="group-switcher">
              <span className="group-label">This device</span>
            </span>
          )}
          {activeGroup && <span className="chip">{roleName(role)}</span>}
          {remote && activeGroup && (
            <button
              type="button"
              className="quiet"
              onClick={() => setDialog('settings')}
              disabled={!canEdit}
              title={
                canEdit ? 'Group settings' : 'Only editors can change group settings'
              }
            >
              Settings
            </button>
          )}
          {activeGroup && canEdit && (
            <button
              type="button"
              className="quiet"
              onClick={() => setDialog('tags')}
            >
              Tags
            </button>
          )}
          {remote && activeGroup && role === 'owner' && (
            <button
              type="button"
              className="primary share-button"
              onClick={() => setDialog('share')}
            >
              Share
            </button>
          )}
          {live && <span className="chip good">{live}</span>}
          <span className={`chip${remote ? ' good' : ''}`}>
            {remote ? 'Synced' : 'This device only'}
          </span>
          <div className="account">
            {session.mode === 'local' ? (
              <span className="account-name">Local preview</span>
            ) : session.user ? (
              <>
                <span className="account-name">{accountName}</span>
                <form method="post" action="/auth/freebuff/signout">
                  <button className="link-button">Sign out</button>
                </form>
              </>
            ) : session.mode === 'freebuff' ? (
              <a className="link-button" href="/auth/freebuff/signin?returnTo=%2F">
                Sign in to share
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <main className="page">
        <div className="intro">
          <h1>Balanced teams, every round.</h1>
          <p>
            Shared groups keep the roster, ratings and match history in sync.
            Anyone with the link can build teams; only editors change elo.
            <br />
            Who is sitting out and the teams you generate stay on your device.
          </p>
        </div>

        {session.mode === 'freebuff' && !session.user && (
          <p className="notice">
            You are working in a device-only group.{' '}
            <a href="/auth/freebuff/signin?returnTo=%2F">Sign in</a> to create
            shared groups and sync across devices.
          </p>
        )}
        {offline && (
          <p className="notice">
            Could not reach the workspace server, so this roster is saved in
            this browser only.
          </p>
        )}
        {session.mode === 'setup' &&
          session.database === false &&
          !error &&
          !offline && (
            <p className="notice">
              This deployment has no database configured, so this roster is
              saved in this browser only.
            </p>
          )}
        {session.mode === 'setup' && session.database && !error && !offline && (
          <p className="notice">
            Sign-in is not configured on this deployment, so this roster is
            saved in this browser only.
          </p>
        )}
        {session.mode === 'local' && (
          <p className="notice">
            Local preview: everything works here. Published projects use your
            Freebuff account.
          </p>
        )}

        {remote && !activeGroup && ready && groups.length === 0 && (
          <section className="panel empty-group">
            <h2>Create your first group</h2>
            <p>
              A group is one roster with its own elo history and skill tags. Make
              one per game or friend circle, then share a viewer or editor link.
            </p>
            <button
              type="button"
              className="primary"
              onClick={() => setDialog('new')}
            >
              New group
            </button>
          </section>
        )}

        {remote && !activeGroup && groups.length > 0 && (
          <p className="empty-state">Open a group to get started.</p>
        )}

        {importable.length > 0 && activeGroup && (
          <div className="notice import">
            <span>
              This device has {importable.length} saved{' '}
              {importable.length === 1 ? 'player' : 'players'}.
            </span>
            <button
              type="button"
              className="quiet"
              onClick={() => void importRoster()}
            >
              Import into “{activeGroup.name}”
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        {showWorkspace && activeGroup && (
          <div className="columns">
            <div className="column">
              <Roster
                players={players}
                events={events}
                kFactor={kFactor}
                tags={activeGroup.tags}
                sitOutIds={sitOuts}
                suggestions={suggestions}
                canEdit={canEdit}
                onAdd={addPlayers}
                onUpdate={updatePlayer}
                onRemove={removePlayer}
                onToggleSit={toggleSit}
              />
            </div>
            <div className="column">
              <Build
                players={players}
                tags={activeGroup.tags}
                sitOutIds={sitOuts}
                teamCount={teamCount}
                tolerance={tolerance}
                onTeamCount={setTeamCount}
                onTolerance={setTolerance}
                suggestions={suggestions}
                benchNote={benchNote}
                onSitOut={applySitOuts}
                onSaveRound={saveRound}
                saved={saved}
              />
              <History rounds={rounds} onRemove={removeRound} />
            </div>
          </div>
        )}

        {showWorkspace && (
          <Matches
            players={players}
            events={events}
            kFactor={kFactor}
            squashed={squashed}
            remote={remote}
            canEdit={canEdit}
            onSave={saveMatch}
            onDelete={removeMatch}
            onMove={moveMatch}
            onKFactor={changeKFactor}
            onRefresh={refreshMatches}
            onScan={(file, onProgress, signal) =>
              store
                ? store.scanRivals(file, onProgress, signal)
                : Promise.reject(new Error('Sign in to import screenshots.'))
            }
          />
        )}
      </main>

      {dialog === 'new' && (
        <NewGroupDialog
          onClose={() => setDialog(null)}
          onCreate={createGroupAction}
        />
      )}
      {dialog === 'share' && group && role === 'owner' && (
        <ShareDialog
          group={group}
          onClose={() => setDialog(null)}
          onChanged={reloadGroup}
        />
      )}
      {dialog === 'settings' && group && canEdit && (
        <GroupSettingsDialog
          group={group}
          canDelete={role === 'owner'}
          onClose={() => setDialog(null)}
          onSaved={saveGroupSettings}
          onDeleted={deleteGroupAction}
        />
      )}
      {dialog === 'tags' && activeGroup && canEdit && (
        <TagsDialog
          tags={activeGroup.tags}
          onClose={() => setDialog(null)}
          onAdd={addTag}
          onRename={renameTag}
          onDelete={deleteTag}
        />
      )}
    </div>
  )
}
