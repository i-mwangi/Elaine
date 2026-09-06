import { useState } from "react"
import { api, type Session } from "@/lib/api"

/* A user is global and belongs to many communities, with a role in each. This
   screen is where that shows: the same person is a teacher in one row and a
   student in the next. */
export function Communities({ token, session, onOpen, onChanged, onSignOut }: {
  token: string
  session: Session
  onOpen: (communityId: string) => void
  onChanged: () => void | Promise<unknown>
  onSignOut: () => void
}) {
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState<"create" | "join" | undefined>()
  const [error, setError] = useState<string | undefined>()

  const run = async (kind: "create" | "join", action: () => Promise<unknown>): Promise<void> => {
    setBusy(kind); setError(undefined)
    try {
      await action()
      await onChanged()
      setName(""); setCode("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work")
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="centred wide">
      <div className="panel">
        <header className="panel-head">
          <div>
            <h1>Your communities</h1>
            <p className="muted">Signed in as {session.user.displayName}</p>
          </div>
          <button onClick={onSignOut}>Sign out</button>
        </header>

        {session.communities.length === 0 ? (
          <p className="muted">
            You are not in a community yet. Start one as a teacher, or join with an
            invite code from someone who runs a course.
          </p>
        ) : (
          <ul className="list">
            {session.communities.map(({ community, role }) => (
              <li key={community.id}>
                <button className="row-button" onClick={() => onOpen(community.id)}>
                  <span className="grow">
                    <strong>{community.name}</strong>
                    {community.term && <span className="muted"> · {community.term}</span>}
                  </span>
                  <span className={`badge ${role}`}>{role}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="split">
          <form onSubmit={(event) => { event.preventDefault(); void run("create", () => api.createCommunity(token, name.trim())) }}>
            <label htmlFor="new-community">Start a community</label>
            <input id="new-community" value={name} onChange={(event) => setName(event.target.value)} placeholder="Neural Networks 2026" />
            <button type="submit" disabled={busy === "create" || !name.trim()}>
              {busy === "create" ? "Creating…" : "Create as teacher"}
            </button>
          </form>

          <form onSubmit={(event) => { event.preventDefault(); void run("join", () => api.redeemInvite(token, code.trim())) }}>
            <label htmlFor="invite">Join with a code</label>
            <input id="invite" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="ABC123XYZ" />
            <button type="submit" disabled={busy === "join" || !code.trim()}>
              {busy === "join" ? "Joining…" : "Join"}
            </button>
          </form>
        </div>

        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
