import { useState } from "react"
import { api } from "@/lib/api"

/* An account is a display name and a token. There is no password to lose and no
   email to verify — which is also why the token is shown once, in full, with an
   explicit instruction to keep it. */
export function Onboarding({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [mode, setMode] = useState<"create" | "restore">("create")
  const [name, setName] = useState("")
  const [token, setToken] = useState("")
  const [minted, setMinted] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const create = async (): Promise<void> => {
    setBusy(true); setError(undefined)
    try {
      const result = await api.createAccount(name.trim())
      setMinted(result.token)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the account")
    } finally {
      setBusy(false)
    }
  }

  const restore = async (): Promise<void> => {
    setBusy(true); setError(undefined)
    try {
      await api.session(token.trim())
      onSignedIn(token.trim())
    } catch {
      setError("That token is not valid on this server")
    } finally {
      setBusy(false)
    }
  }

  if (minted) {
    return (
      <div className="centred">
        <div className="panel">
          <h1>Keep this key</h1>
          <p className="muted">
            It is shown once and it is the only way back into this account. Store it
            somewhere safe before you continue.
          </p>
          <code className="token">{minted}</code>
          <div className="row">
            <button onClick={() => void navigator.clipboard?.writeText(minted)}>Copy</button>
            <button className="primary" onClick={() => onSignedIn(minted)}>I've saved it — continue</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="centred">
      <div className="panel">
        <h1>Elaine</h1>
        <p className="muted">
          A course community where people and agents share the same channels, and what
          the group works out stays in files the group owns.
        </p>

        {/* Switching tabs clears the error: a failed key is not a comment on the
            name you are about to type, and leaving it there reads as one. */}
        <div className="tabs">
          <button className={mode === "create" ? "active" : ""} onClick={() => { setMode("create"); setError(undefined) }}>New account</button>
          <button className={mode === "restore" ? "active" : ""} onClick={() => { setMode("restore"); setError(undefined) }}>I have a key</button>
        </div>

        {mode === "create" ? (
          <form onSubmit={(event) => { event.preventDefault(); void create() }}>
            <label htmlFor="name">Your name</label>
            <input id="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Henry" autoFocus />
            <button className="primary" type="submit" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create account"}
            </button>
          </form>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void restore() }}>
            <label htmlFor="token">Your key</label>
            <input id="token" value={token} onChange={(event) => { setToken(event.target.value); setError(undefined) }} placeholder="Paste the key you saved" autoFocus />
            <button className="primary" type="submit" disabled={busy || !token.trim()}>
              {busy ? "Checking…" : "Continue"}
            </button>
          </form>
        )}

        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
