/* The live connection.

   The token goes in the first frame, never in the URL: a WebSocket query string
   is written to proxy logs and browser history the same way any URL is. */
import { useCallback, useEffect, useRef, useState } from "react"
import { browserServerFrameSchema, type ServerEvent } from "@elaine/protocol"

export type LiveStatus = "connecting" | "live" | "offline"

export type Live = { status: LiveStatus; send: (frame: Record<string, unknown>) => void }

export function useLive(token: string | undefined, communityId: string | undefined, onEvent: (event: ServerEvent) => void): Live {
  const [status, setStatus] = useState<LiveStatus>("connecting")
  /* The handler changes on every render; the socket must not. */
  const handler = useRef(onEvent)
  handler.current = onEvent
  /* Held in a ref so callers get a stable `send` that always writes to the
     socket currently open, including after a reconnect. */
  const live = useRef<WebSocket | undefined>(undefined)

  useEffect(() => {
    if (!token || !communityId) return
    let socket: WebSocket | undefined
    let attempt = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let closed = false

    const connect = (): void => {
      if (closed) return
      setStatus("connecting")
      const url = `${location.origin.replace(/^http/, "ws")}/ws`
      socket = new WebSocket(url)
      live.current = socket

      socket.onopen = () => socket?.send(JSON.stringify({ type: "auth", token, communityId }))
      socket.onmessage = (message) => {
        const parsed = browserServerFrameSchema.safeParse(JSON.parse(message.data as string))
        if (!parsed.success) return
        if (parsed.data.type === "ready") { attempt = 0; setStatus("live"); return }
        handler.current(parsed.data.event)
      }
      socket.onclose = (event) => {
        if (closed) return
        setStatus("offline")
        /* 4401 means this token may not bind here. Retrying would be a loop. */
        if (event.code === 4401) return
        const delay = Math.min(15_000, 500 * 2 ** attempt++)
        retry = setTimeout(connect, delay)
      }
      socket.onerror = () => socket?.close()
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      socket?.close()
    }
  }, [token, communityId])

  /* Frames sent before the socket is open are dropped rather than queued:
     typing is worthless by the time a reconnect finishes. */
  const send = useCallback((frame: Record<string, unknown>): void => {
    if (live.current?.readyState === WebSocket.OPEN) live.current.send(JSON.stringify(frame))
  }, [])

  return { status, send }
}
