import { useCallback, useEffect, useState } from "react"
import { ApiError, api, readToken, writeToken, type Session } from "@/lib/api"
import { Onboarding } from "@/screens/Onboarding"
import { Communities } from "@/screens/Communities"
import { Workspace } from "@/screens/Workspace"

export function App() {
  const [token, setToken] = useState<string | undefined>(readToken)
  const [session, setSession] = useState<Session | undefined>()
  const [communityId, setCommunityId] = useState<string | undefined>()
  const [restoring, setRestoring] = useState(!!token)
  const [loadError, setLoadError] = useState<string | undefined>()

  const refresh = useCallback(async (current: string): Promise<Session | undefined> => {
    try {
      const next = await api.session(current)
      setSession(next)
      return next
    } catch (cause) {
      /* Only a token the server actually rejects is discarded. A network blip or
         a restarting dev server must not silently sign someone out of an account
         whose key they may not have written down. */
      if (cause instanceof ApiError && cause.status === 401) {
        writeToken(undefined)
        setToken(undefined)
        setSession(undefined)
      } else {
        setLoadError("Could not reach the server. Check it is running, then retry.")
      }
      return undefined
    }
  }, [])

  useEffect(() => {
    if (!token) { setRestoring(false); return }
    void refresh(token).finally(() => setRestoring(false))
  }, [token, refresh])

  const signIn = (next: string): void => {
    writeToken(next)
    setToken(next)
  }
  const signOut = (): void => {
    writeToken(undefined)
    setToken(undefined)
    setSession(undefined)
    setCommunityId(undefined)
  }

  if (restoring) return <div className="boot">Restoring your session…</div>
  if (token && !session && loadError) {
    return (
      <div className="boot">
        <div className="panel">
          <p className="error" role="alert">{loadError}</p>
          <div className="row">
            <button onClick={signOut}>Sign out</button>
            <button className="primary" onClick={() => { setLoadError(undefined); void refresh(token) }}>Retry</button>
          </div>
        </div>
      </div>
    )
  }
  if (!token || !session) return <Onboarding onSignedIn={signIn} />

  if (!communityId) {
    return (
      <Communities
        token={token}
        session={session}
        onOpen={setCommunityId}
        onChanged={() => refresh(token)}
        onSignOut={signOut}
      />
    )
  }

  return (
    <Workspace
      token={token}
      session={session}
      communityId={communityId}
      /* Also refresh: after leaving or being removed, the picker must not still
         list a community this account no longer belongs to. */
      onLeave={() => { setCommunityId(undefined); void refresh(token) }}
    />
  )
}
