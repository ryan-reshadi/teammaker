import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { suggestSitOuts } from '../shared/balance'
import {
  DEFAULT_K_FACTOR,
  clampElo,
  eloFromSkill,
  skillFromElo,
  type MatchInput,
  type RatingEventView,
} from '../shared/elo'
import type { Player, Round, RoundConfig, Session } from '../shared/types'
import { Build } from './components/Build'
import { History } from './components/History'
import { Matches } from './components/Matches'
import { Roster } from './components/Roster'
import {
  createStore,
  readLocalPlayers,
  type PlayerDraft,
  type PlayerPatch,
  type Store,
} from './store'
import './style.css'

const message = (problem: unknown) =>
  problem instanceof Error
    ? problem.message
    : 'Something went wrong. Please try again.'

/** Keep the elo and its 1-10 mirror consistent while a request is in flight. */
function applyPatch(player: Player, patch: PlayerPatch): Player {
  const next = { ...player, ...patch }
  if (patch.elo !== undefined) {
    next.elo = clampElo(patch.elo)
    next.skill = skillFromElo(next.elo)
  } else if (patch.skill !== undefined) {
    next.elo = eloFromSkill(patch.skill)
    next.skill = skillFromElo(next.elo)
  }
  return next
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [players, setPlayers] = useState<Player[]>([])
  const [rounds, setRounds] = useState<Round[]>([])
  const [events, setEvents] = useState<RatingEventView[]>([])
  const [kFactor, setKFactor] = useState(DEFAULT_K_FACTOR)
  const [teamCount, setTeamCount] = useState(3)
  const [tolerance, setTolerance] = useState(300)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [importable, setImportable] = useState<Player[]>([])

  const remote = Boolean(session?.user && session.database)
  const store = useMemo<Store | null>(
    () => (session ? createStore(remote) : null),
    [session, remote],
  )

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const response = await fetch('/api/session')
        const current = (await response.json()) as Session
        if (live) setSession(current)
      } catch {
        if (!live) return
        // No server session: fall back to this device so the tool still works.
        setSession({ user: null, mode: 'setup', database: false })
        setError('Could not reach the workspace server — saving on this device.')
      }
    })()
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!store) return
    let live = true
    setReady(false)
    void (async () => {
      try {
        const [loadedPlayers, loadedRounds, loadedMatches] = await Promise.all([
          store.players(),
          store.rounds(),
          store.matches(),
        ])
        if (!live) return
        setPlayers(loadedPlayers)
        setRounds(loadedRounds)
        setEvents(loadedMatches.events)
        setKFactor(loadedMatches.kFactor)
      } catch (problem) {
        if (live) setError(message(problem))
      } finally {
        if (live) setReady(true)
      }
    })()
    return () => {
      live = false
    }
  }, [store])

  // A guest who signs in can bring the roster from this device.
  useEffect(() => {
    if (!remote || !ready || players.length > 0) {
      setImportable([])
      return
    }
    setImportable(readLocalPlayers())
  }, [remote, ready, players.length])

  const refreshMatches = useCallback(async () => {
    if (!store) return
    const loaded = await store.matches()
    setEvents(loaded.events)
    setKFactor(loaded.kFactor)
  }, [store])

  const addPlayers = useCallback(
    async (drafts: PlayerDraft[]) => {
      if (!store) return
      try {
        const created = await store.addPlayers(drafts)
        setPlayers((previous) => [...previous, ...created])
        setError('')
      } catch (problem) {
        setError(message(problem))
      }
    },
    [store],
  )

  const updatePlayer = useCallback(
    async (id: string, patch: PlayerPatch) => {
      if (!store) return
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
        // A re-rating is a logged adjustment: every later match is replayed.
        if (patch.skill !== undefined || patch.elo !== undefined)
          await refreshMatches()
      } catch (problem) {
        setError(message(problem))
        setPlayers(await store.players())
      }
    },
    [store, refreshMatches],
  )

  const removePlayer = useCallback(
    async (id: string) => {
      if (!store) return
      setPlayers((previous) => previous.filter((player) => player.id !== id))
      try {
        await store.removePlayer(id)
        setError('')
        // Removing a player can also remove their manual rating entries.
        await refreshMatches()
      } catch (problem) {
        setError(message(problem))
        setPlayers(await store.players())
      }
    },
    [store, refreshMatches],
  )

  const saveMatch = useCallback(
    async (input: MatchInput, id?: string) => {
      if (!store) return
      const next = id
        ? await store.updateMatch(id, input)
        : await store.addMatch(input)
      setPlayers(next)
      await refreshMatches()
      setError('')
    },
    [store, refreshMatches],
  )

  const removeMatch = useCallback(
    async (id: string) => {
      if (!store) return
      const next = await store.removeMatch(id)
      setPlayers(next)
      await refreshMatches()
      setError('')
    },
    [store, refreshMatches],
  )

  const moveMatch = useCallback(
    async (id: string, position: number) => {
      if (!store) return
      const next = await store.moveMatch(id, position)
      setPlayers(next)
      await refreshMatches()
      setError('')
    },
    [store, refreshMatches],
  )

  const changeKFactor = useCallback(
    async (k: number) => {
      if (!store) return
      const next = await store.setKFactor(k)
      setPlayers(next.players)
      setKFactor(next.kFactor)
      await refreshMatches()
      setError('')
    },
    [store, refreshMatches],
  )

  const saveRound = useCallback(
    async (config: RoundConfig) => {
      if (!store) return
      try {
        const round = await store.addRound(config)
        setRounds((previous) => [round, ...previous].slice(0, 60))
        setSaved(`Round saved · spread ${config.spread} elo`)
        window.setTimeout(() => setSaved(''), 3000)
        setError('')
      } catch (problem) {
        setError(message(problem))
      }
    },
    [store],
  )

  const removeRound = useCallback(
    async (id: string) => {
      if (!store) return
      try {
        await store.removeRound(id)
        setRounds((previous) => previous.filter((round) => round.id !== id))
        setError('')
      } catch (problem) {
        setError(message(problem))
      }
    },
    [store],
  )

  const applySitOuts = useCallback(
    (ids: string[]) => {
      for (const id of ids) void updatePlayer(id, { sittingOut: true })
    },
    [updatePlayer],
  )

  const importRoster = useCallback(async () => {
    const drafts = importable.map((player) => ({
      name: player.name,
      skill: player.skill,
      tags: player.tags,
    }))
    setImportable([])
    await addPlayers(drafts)
  }, [importable, addPlayers])

  const sitCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const round of rounds)
      for (const id of round.config.benchedIds)
        counts[id] = (counts[id] ?? 0) + 1
    return counts
  }, [rounds])

  const suggestions = useMemo(
    () => suggestSitOuts(players, teamCount, sitCounts),
    [players, teamCount, sitCounts],
  )

  const accountName =
    session?.user?.name || session?.user?.email || 'Signed in'

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
          <span className={`chip${remote ? ' good' : ''}`}>
            {remote ? 'Synced' : 'This device only'}
          </span>
          <div className="account">
            {session?.mode === 'local' ? (
              <span className="account-name">Local preview</span>
            ) : session?.user ? (
              <>
                <span className="account-name">{accountName}</span>
                <form method="post" action="/auth/freebuff/signout">
                  <button className="link-button">Sign out</button>
                </form>
              </>
            ) : session?.mode === 'freebuff' ? (
              <a className="link-button" href="/auth/freebuff/signin?returnTo=%2F">
                Sign in to sync
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <main className="page">
        <div className="intro">
          <h1>Balanced teams, every round.</h1>
          <p>
            Rate everyone once, then let match damage tune their elo. Pick how
            many teams you need and how close they have to be — we find every
            split that fits.
          </p>
        </div>

        {session?.mode === 'freebuff' && !session.user && (
          <p className="notice">
            You are working on this device only.{' '}
            <a href="/auth/freebuff/signin?returnTo=%2F">Sign in</a> to keep the
            roster, saved rounds and match ratings across sessions.
          </p>
        )}
        {/* An unreachable server sets `error` below, so these notices only
            describe a server that answered without storage or sign-in. */}
        {session?.mode === 'setup' && session.database === false && !error && (
          <p className="notice">
            This deployment has no database configured, so this roster is saved
            in this browser only.
          </p>
        )}
        {session?.mode === 'setup' && session.database && !error && (
          <p className="notice">
            Sign-in is not configured on this deployment, so this roster is
            saved in this browser only.
          </p>
        )}
        {session?.mode === 'local' && (
          <p className="notice">
            Local preview: everything works here. Published projects use your
            Freebuff account.
          </p>
        )}
        {importable.length > 0 && (
          <div className="notice import">
            <span>
              This device has {importable.length} saved{' '}
              {importable.length === 1 ? 'player' : 'players'}.
            </span>
            <button type="button" className="quiet" onClick={() => void importRoster()}>
              Import to my account
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        <div className="columns">
          <div className="column">
            <Roster
              players={players}
              suggestions={suggestions}
              onAdd={addPlayers}
              onUpdate={updatePlayer}
              onRemove={removePlayer}
            />
          </div>
          <div className="column">
            <Build
              players={players}
              teamCount={teamCount}
              tolerance={tolerance}
              onTeamCount={setTeamCount}
              onTolerance={setTolerance}
              suggestions={suggestions}
              onSitOut={applySitOuts}
              onSaveRound={saveRound}
              saved={saved}
            />
            <History rounds={rounds} onRemove={removeRound} />
          </div>
        </div>

        <Matches
          players={players}
          events={events}
          kFactor={kFactor}
          remote={remote}
          onSave={saveMatch}
          onDelete={removeMatch}
          onMove={moveMatch}
          onKFactor={changeKFactor}
        />
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
