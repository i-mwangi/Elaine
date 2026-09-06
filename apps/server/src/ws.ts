/* Sockets. Two kinds, both authenticated in their FIRST frame — never with a
   token in the query string, which would land in proxy logs and history.

   Every event is filtered for the receiver before it is sent, so a socket never
   carries a resource its owner may not read. */
import type { DatabaseSync } from "node:sqlite"
import { WebSocket, WebSocketServer } from "ws"
import type { Agent, Card, Channel, Community, Member, Message, Presence, ServerEvent, Thread, User } from "@elaine/protocol"
import { browserAuthFrameSchema, browserTypingFrameSchema, runnerClientFrameSchema } from "@elaine/protocol"
import { type ApiConfig, type Row, apiConfig, now, text } from "./db.js"
import { answerMention } from "./agent-worker.js"
import {
  agentForRunnerToken, agentFromRow, canReadChannel, canTypeInChannel, contextFor, createAgentMessage, listMembers,
  mentionedAgents, publishCard, roleIn, userForToken,
} from "./store.js"

const AUTH_TIMEOUT_MS = 5_000
/* Ported from the old repo: at most one "started typing" per key per 250ms, and
   a 4s silence means stopped. Without the expiry a dropped keystroke would
   leave someone typing forever. */
const TYPING_THROTTLE_MS = 250
const TYPING_EXPIRY_MS = 4_000

type BrowserClient = { socket: WebSocket; user: User; communityId: string; typing: Set<string> }
type RunnerClient = { socket: WebSocket; agentId: string; communityId: string }

export class Hub {
  /* Where a server-run agent keeps its folder. Set at construction so the hub
     does not have to know how the file store is configured. */
  filesRoot = "."
  private readonly browsers = new Set<BrowserClient>()
  private readonly runners = new Map<string, RunnerClient>()
  readonly presence = new Map<string, Presence>()
  /* Once shutting down, nothing may touch the database: sockets close as part
     of shutdown, and their handlers would otherwise query a closed one. */
  private closed = false

  constructor(private readonly database: DatabaseSync) {}

  /* ---- Outbound -------------------------------------------------------- */

  private deliver(event: ServerEvent, visible: (client: BrowserClient) => boolean): void {
    if (this.closed) return
    const frame = JSON.stringify({ type: "event", event })
    for (const client of this.browsers) {
      if (client.communityId !== event.communityId || !visible(client)) continue
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(frame)
    }
  }

  private readable(communityId: string, channelId: string): (client: BrowserClient) => boolean {
    return (client) => canReadChannel(this.database, communityId, channelId, client.user.id)
  }

  messageCreated(message: Message): void {
    const type = message.deletedAt ? "message.deleted" : "message.created"
    const event = message.deletedAt
      ? { type, communityId: message.communityId, at: now(), payload: { messageId: message.id, channelId: message.channelId, deletedBy: message.deletedBy ?? message.authorId } }
      : { type, communityId: message.communityId, at: now(), payload: { message } }
    this.deliver(event as ServerEvent, this.readable(message.communityId, message.channelId))
    if (!message.deletedAt) this.dispatchMentions(message)
  }

  messageEdited(message: Message): void {
    this.deliver({ type: "message.updated", communityId: message.communityId, at: now(), payload: { message } } as ServerEvent,
      this.readable(message.communityId, message.channelId))
  }

  reacted(communityId: string, result: { messageId: string; channelId: string; reactions: unknown }): void {
    this.deliver({ type: "message.reacted", communityId, at: now(), payload: result } as ServerEvent,
      this.readable(communityId, result.channelId))
  }

  channelCreated(channel: Channel): void {
    this.deliver({ type: "channel.created", communityId: channel.communityId, at: now(), payload: { channel } } as ServerEvent,
      this.readable(channel.communityId, channel.id))
  }

  threadCreated(thread: Thread): void {
    this.deliver({ type: "thread.created", communityId: thread.communityId, at: now(), payload: { thread } } as ServerEvent,
      this.readable(thread.communityId, thread.channelId))
  }

  /* The old repo's `onTenantAgentRevoked`: a deleted agent's runner must not
     keep an authorized socket. Its token no longer resolves, so the connection
     it already holds is closed rather than left streaming work it may not do. */
  agentDeleted(communityId: string, agent: Agent): void {
    this.deliver({ type: "agent.deleted", communityId, at: now(), payload: { agent } } as ServerEvent, () => true)
    const runner = this.runners.get(agent.id)
    if (runner) {
      this.runners.delete(agent.id)
      runner.socket.close(4403, "agent deleted")
    }
    this.presence.delete(agent.id)
  }

  /* Broadcast community-wide, as the old repo did. */
  channelRead(communityId: string, result: { channelId: string; userId: string; lastReadAt: string; unread: boolean }): void {
    this.deliver({ type: "channel.read", communityId, at: now(), payload: result } as ServerEvent, () => true)
  }

  channelArchived(channel: Channel): void {
    /* Sent to the whole community: someone who could read it needs to be told
       it is gone from their sidebar, and un-archiving must reach them too. */
    this.deliver({ type: "channel.archived", communityId: channel.communityId, at: now(), payload: { channel } } as ServerEvent, () => true)
  }

  channelUpdated(channel: Channel): void {
    this.deliver({ type: "channel.updated", communityId: channel.communityId, at: now(), payload: { channel } } as ServerEvent,
      this.readable(channel.communityId, channel.id))
  }

  /* The channel is already gone, so readability cannot be asked about it any
     more: everyone bound to the community is told, and a client that never had
     it simply finds nothing to remove. */
  channelDeleted(communityId: string, channelId: string): void {
    this.deliver({ type: "channel.deleted", communityId, at: now(), payload: { channelId } } as ServerEvent, () => true)
  }

  cardPublished(card: Card): void {
    this.deliver({ type: "card.published", communityId: card.communityId, at: now(), payload: { card } } as ServerEvent,
      this.readable(card.communityId, card.channelId))
  }

  agentUpdated(agent: Agent): void {
    /* Each viewer sees only the channel assignments they can read. */
    this.deliver({ type: "agent.updated", communityId: agent.communityId, at: now(), payload: { agent } } as ServerEvent, () => true)
  }

  memberJoined(communityId: string, userId: string): void {
    const member = listMembers(this.database, communityId, { id: userId } as User).find((item) => item.userId === userId)
    if (member) this.deliver({ type: "member.joined", communityId, at: now(), payload: { member } } as ServerEvent, () => true)
  }

  communityUpdated(community: Community): void {
    this.deliver({ type: "community.updated", communityId: community.id, at: now(), payload: { community } } as ServerEvent, () => true)
  }

  memberUpdated(member: Member): void {
    this.deliver({ type: "member.updated", communityId: member.communityId, at: now(), payload: { member } } as ServerEvent, () => true)
  }

  /* Removal is also a revocation. The socket was authorized when it bound to
     this community; leaving that open would keep streaming a channel the person
     may no longer read, so it is closed and the client falls back to REST,
     which now refuses them. */
  memberRemoved(communityId: string, userId: string): void {
    this.deliver({ type: "member.removed", communityId, at: now(), payload: { userId } } as ServerEvent, () => true)
    for (const client of [...this.browsers]) {
      if (client.communityId !== communityId || client.user.id !== userId) continue
      this.browsers.delete(client)
      client.socket.close(4403, "membership ended")
    }
  }

  /* Keyed by user + channel, not by socket: two tabs typing in one channel are
     one person typing, and the last of them to stop is what ends it. */
  private readonly typingExpiry = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly typingLastSent = new Map<string, number>()
  private static typingKey = (userId: string, channelId: string): string => `${userId} ${channelId}`

  private publishTyping(client: BrowserClient, channelId: string, typing: boolean): void {
    const key = Hub.typingKey(client.user.id, channelId)
    const existing = this.typingExpiry.get(key)
    if (existing) clearTimeout(existing)
    this.typingExpiry.delete(key)

    const emit = (value: boolean): void => {
      /* Everyone who can read the channel, the typist included, as the old
         repo's broadcast did. */
      this.deliver(
        { type: "typing.updated", communityId: client.communityId, at: now(), payload: { channelId, userId: client.user.id, typing: value } } as ServerEvent,
        (other) => canReadChannel(this.database, client.communityId, channelId, other.user.id),
      )
    }

    if (typing) {
      const elapsed = Date.now() - (this.typingLastSent.get(key) ?? 0)
      if (elapsed >= TYPING_THROTTLE_MS) {
        this.typingLastSent.set(key, Date.now())
        emit(true)
      }
      const timer = setTimeout(() => {
        this.typingExpiry.delete(key)
        this.typingLastSent.delete(key)
        emit(false)
      }, TYPING_EXPIRY_MS)
      /* A pending "stopped typing" must not keep the process alive on its own. */
      timer.unref?.()
      this.typingExpiry.set(key, timer)
      return
    }
    this.typingLastSent.delete(key)
    emit(false)
  }

  /* A socket going away must not leave its owner typing into a closed tab. */
  private stopTyping(client: BrowserClient): void {
    for (const channelId of client.typing) this.publishTyping(client, channelId, false)
    client.typing.clear()
  }

  private handleBrowserFrame(client: BrowserClient, frame: unknown): void {
    const parsed = browserTypingFrameSchema.safeParse(frame)
    if (!parsed.success) return
    const { channelId, typing } = parsed.data.payload
    if (!canTypeInChannel(this.database, client.communityId, channelId, client.user.id)) return
    if (typing) client.typing.add(channelId)
    else client.typing.delete(channelId)
    this.publishTyping(client, channelId, typing)
  }

  private setPresence(agentId: string, communityId: string, presence: Presence): void {
    this.presence.set(agentId, presence)
    this.deliver({ type: "runner.presence", communityId, at: now(), payload: { agentId, presence } } as ServerEvent, () => true)
  }

  /* ---- Mentions -------------------------------------------------------- */

  /* The server never runs a model. It hands a mention to the runner that owns
     that agent's identity, together with the immediate memory layer. */
  private dispatchMentions(message: Message): void {
    if (message.authorKind === "agent") return
    for (const row of mentionedAgents(this.database, message.communityId, message.channelId, message.paragraphs)) {
      const agentId = text(row.id)
      const from = listMembers(this.database, message.communityId, { id: message.authorId } as User).find((item) => item.userId === message.authorId)
      if (!from) continue
      const runner = this.runners.get(agentId)

      /* A runner holding this agent's identity always wins: it has the folder
         and the creator's own credentials. The server only answers for an
         `api` agent that nothing is running for. */
      if (!runner || runner.socket.readyState !== WebSocket.OPEN) {
        if (text(row.runtime) !== "api") continue
        const config = apiConfig()
        if (!config) {
          this.reportUnconfigured(message, agentId)
          continue
        }
        void this.answerHere(config, row, message, from.displayName)
        continue
      }
      runner.socket.send(JSON.stringify({
        type: "work",
        payload: {
          communityId: message.communityId, agentId, channelId: message.channelId,
          ...(message.threadId ? { threadId: message.threadId } : {}),
          message, from: from as Member,
          context: contextFor(this.database, message.communityId, message.channelId, message.threadId),
        },
      }))
    }
  }

  /* Answering in this process, for an agent with no runner of its own. */
  private async answerHere(config: ApiConfig, agent: Row, message: Message, from: string): Promise<void> {
    try {
      await answerMention(
        {
          database: this.database,
          filesRoot: this.filesRoot,
          setPresence: (agentId, presence) => this.setPresence(agentId, text(agent.community_id), presence),
          onMessage: (created) => this.messageCreated(created),
          onCard: (card) => this.cardPublished(card),
        },
        config,
        agent,
        {
          communityId: message.communityId,
          channelId: message.channelId,
          ...(message.threadId ? { threadId: message.threadId } : {}),
          message,
          from,
          context: contextFor(this.database, message.communityId, message.channelId, message.threadId),
        },
      )
    } catch {
      /* answerMention reports its own failures in the channel; anything left is
         a bug here, and must not take the socket down with it. */
    }
  }

  /* Saying so in the channel beats an agent that silently never replies. */
  private reportUnconfigured(message: Message, agentId: string): void {
    try {
      const notice = createAgentMessage(this.database, message.communityId, agentId, message.channelId, {
        paragraphs: [[{ kind: "text", text: "I can't answer yet: this server has no model endpoint configured." }]],
        ...(message.threadId ? { threadId: message.threadId } : {}),
      })
      this.messageCreated(notice)
    } catch { /* the channel may not accept this agent; nothing else to do */ }
  }

  /* ---- Inbound --------------------------------------------------------- */

  attach(server: WebSocketServer): void {
    server.on("connection", (socket, request) => {
      const runner = (request.url ?? "").startsWith("/ws/runner")
      /* A socket that has not authenticated may do nothing and is closed. */
      const timer = setTimeout(() => socket.close(4401, "auth timeout"), AUTH_TIMEOUT_MS)
      let authenticated = false

      socket.on("message", (raw) => {
        let frame: unknown
        try { frame = JSON.parse(raw.toString()) } catch { socket.close(4400, "invalid frame"); return }
        if (!authenticated) {
          clearTimeout(timer)
          authenticated = runner ? this.authenticateRunner(socket, frame) : this.authenticateBrowser(socket, frame)
          if (!authenticated) socket.close(4401, "unauthenticated")
          return
        }
        if (runner) { this.handleRunnerFrame(socket, frame); return }
        const client = [...this.browsers].find((item) => item.socket === socket)
        if (client) this.handleBrowserFrame(client, frame)
      })

      socket.on("close", () => {
        clearTimeout(timer)
        for (const client of [...this.browsers]) {
          if (client.socket !== socket) continue
          this.stopTyping(client)
          this.browsers.delete(client)
        }
        for (const [agentId, client] of this.runners) {
          if (client.socket !== socket) continue
          this.runners.delete(agentId)
          this.setPresence(agentId, client.communityId, "offline")
        }
      })
    })
  }

  private authenticateBrowser(socket: WebSocket, frame: unknown): boolean {
    const parsed = browserAuthFrameSchema.safeParse(frame)
    if (!parsed.success) return false
    const user = userForToken(this.database, parsed.data.token)
    if (!user) return false
    try { roleIn(this.database, parsed.data.communityId, user.id) } catch { return false }
    this.browsers.add({ socket, user, communityId: parsed.data.communityId, typing: new Set() })
    socket.send(JSON.stringify({ type: "ready", communityId: parsed.data.communityId, userId: user.id }))
    return true
  }

  private authenticateRunner(socket: WebSocket, frame: unknown): boolean {
    const parsed = runnerClientFrameSchema.safeParse(frame)
    if (!parsed.success || parsed.data.type !== "auth") return false
    const row = agentForRunnerToken(this.database, parsed.data.token)
    if (!row) return false
    const agentId = text(row.id)
    const communityId = text(row.community_id)
    this.runners.get(agentId)?.socket.close(4409, "replaced by a newer runner")
    this.runners.set(agentId, { socket, agentId, communityId })
    socket.send(JSON.stringify({ type: "ready", agent: agentFromRow(this.database, row, this.presence) }))
    this.setPresence(agentId, communityId, "online")
    return true
  }

  private handleRunnerFrame(socket: WebSocket, frame: unknown): void {
    const client = [...this.runners.values()].find((item) => item.socket === socket)
    if (!client) return
    const parsed = runnerClientFrameSchema.safeParse(frame)
    if (!parsed.success) return
    const message = parsed.data
    if (message.type === "presence") {
      this.setPresence(client.agentId, client.communityId, message.payload.presence)
      return
    }
    if (message.type === "auth") return

    const ack = (body: Record<string, unknown>) => socket.send(JSON.stringify({ type: "ack", ref: message.ref, ...body }))
    /* A runner is bound to one agent in one community by its token. A frame
       claiming any other scope is a protocol violation, not a lookup. */
    if (message.payload.communityId !== client.communityId || message.payload.agentId !== client.agentId) {
      ack({ ok: false, error: "runner identity does not match the frame scope" })
      return
    }
    try {
      if (message.type === "message.create") {
        const created = createAgentMessage(this.database, client.communityId, client.agentId, message.payload.channelId, {
          paragraphs: message.payload.paragraphs,
          ...(message.payload.threadId ? { threadId: message.payload.threadId } : {}),
          ...(message.payload.fromFile ? { fromFileCardIds: message.payload.fromFile.cardIds } : {}),
        })
        ack({ ok: true, messageId: created.id })
        this.messageCreated(created)
        return
      }
      const card = publishCard(this.database, client.communityId, client.agentId, {
        channelId: message.payload.channelId, path: message.payload.path, title: message.payload.title,
        type: message.payload.type, body: message.payload.body, sourceMessageIds: message.payload.sourceMessageIds,
        ...(message.payload.replacesCardId ? { replacesCardId: message.payload.replacesCardId } : {}),
      })
      ack({ ok: true, cardId: card.id })
      this.cardPublished(card)
    } catch (error) {
      ack({ ok: false, error: error instanceof Error ? error.message : "rejected" })
    }
  }

  /* Shutting down cancels every pending expiry. Without this a timer can fire
     after the database is closed and throw from a callback nobody is awaiting. */
  close(): void {
    this.closed = true
    for (const timer of this.typingExpiry.values()) clearTimeout(timer)
    this.typingExpiry.clear()
    this.typingLastSent.clear()
  }
}

export function createHub(database: DatabaseSync): Hub {
  return new Hub(database)
}

export type { Row }
