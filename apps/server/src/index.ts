import { serve } from "@hono/node-server"
import { WebSocketServer } from "ws"
import { createApi } from "./api.js"
import { loadEnvFile, openDatabase } from "./db.js"
import { attachmentsRoot } from "./attachments.js"
import { createHub } from "./ws.js"

/* `serve` binds asynchronously, so the port is only knowable from its callback.
   Returning before that would hand callers port 0. */
export async function startServer(): Promise<{ close: () => Promise<void>; port: number }> {
  /* Before anything reads the environment. */
  loadEnvFile()
  const database = openDatabase(process.env.ELAINE_DB ?? "elaine.db")
  const hub = createHub(database)
  hub.filesRoot = attachmentsRoot()
  /* A reaction knows its channel; the channel knows its community. */
  const communityOf = (channelId: string): string => {
    const row = database.prepare("SELECT community_id FROM channels WHERE id = ?").get(channelId) as { community_id?: string } | undefined
    return row?.community_id ?? ""
  }
  const app = createApi(database, {
    presence: hub.presence,
    onMessage: (message) => hub.messageCreated(message),
    onChannel: (channel) => hub.channelCreated(channel),
    onAgent: (agent) => hub.agentUpdated(agent),
    onCard: (card) => hub.cardPublished(card),
    onThread: (thread) => hub.threadCreated(thread),
    onMessageEdited: (message) => hub.messageEdited(message),
    onCommunityUpdated: (community) => hub.communityUpdated(community),
    onMemberUpdated: (member) => hub.memberUpdated(member),
    onAgentDeleted: (communityId, agent) => hub.agentDeleted(communityId, agent),
    onRead: (communityId, result) => hub.channelRead(communityId, result),
    onChannelUpdated: (channel) => hub.channelUpdated(channel),
    onChannelArchived: (channel) => hub.channelArchived(channel),
    onChannelDeleted: (communityId, channelId) => hub.channelDeleted(communityId, channelId),
    onReaction: (result) => hub.reacted(communityOf(result.channelId), result),
    onMemberRemoved: (communityId, userId) => hub.memberRemoved(communityId, userId),
    onMember: (communityId, userId) => hub.memberJoined(communityId, userId),
  })

  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const listening = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) }, (info) => resolve({ server: listening, port: info.port }))
  })
  const sockets = new WebSocketServer({ noServer: true })
  hub.attach(sockets)
  /* One port serves REST and both socket kinds; the path selects which. */
  server.on("upgrade", (request, socket, head) => {
    const path = (request.url ?? "").split("?")[0]
    if (path !== "/ws" && path !== "/ws/runner") { socket.destroy(); return }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request))
  })

  return {
    port,
    close: () => new Promise<void>((resolve) => {
      hub.close()
      sockets.close()
      server.close(() => { database.close(); resolve() })
    }),
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("index.ts")) {
  const running = await startServer()
  console.log(`Elaine server listening on http://localhost:${running.port}`)
}
