/* REST. The bearer token identifies the user; the path identifies the tenant.
   Every /api/communities/:communityId route proves membership before it reads. */
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { ZodError } from "zod"
import type { DatabaseSync } from "node:sqlite"
import type { Agent, Card, Channel, Community, Member, Message, Presence, Thread, User } from "@elaine/protocol"
import {
  createAgentInputSchema, createChannelInputSchema, createCommunityInputSchema, createDmInputSchema,
  createInviteInputSchema, createMessageInputSchema, createThreadInputSchema, createUserInputSchema, editMessageInputSchema,
  markReadInputSchema, reactInputSchema, redeemInviteInputSchema, updateCommunityInputSchema, updateAgentInputSchema, updateChannelInputSchema, updateMemberInputSchema,
} from "@elaine/protocol"
import { ApiError, statusFor } from "./db.js"
import { MAX_ATTACHMENT_BYTES, attachmentsRoot, deleteAttachment, readAttachment, storeAttachment } from "./attachments.js"
import { hasWebDist, serveWebFile, webDistDir } from "./static.js"
import {
  createAgent, createChannel, createCommunity, createMessage, createInvite, createUser, joinChannel,
  createThread, editMessage, listCards, listMessages, listThreads, openDm, publishCard, redeemInvite,
  browseChannels, canReadChannel, deleteAgent, deleteChannel, getAgent, leaveChannel, markChannelRead, leaveCommunity, react, removeMember, rotateAgentToken, updateAgent,
  listCommunities, roleIn, session, updateChannel, updateCommunity, updateMemberRole, userForToken, workspace,
  deleteMessage, listChannels, listAgents, listMembers,
} from "./store.js"

export type Hooks = {
  presence: ReadonlyMap<string, Presence>
  onMessage?: (message: Message) => void
  onChannel?: (channel: Channel) => void
  onAgent?: (agent: Agent) => void
  onCard?: (card: Card) => void
  onThread?: (thread: Thread) => void
  onMessageEdited?: (message: Message) => void
  onCommunityUpdated?: (community: Community) => void
  onMemberUpdated?: (member: Member) => void
  onAgentDeleted?: (communityId: string, agent: Agent) => void
  onRead?: (communityId: string, result: { channelId: string; userId: string; lastReadAt: string; unread: boolean }) => void
  onChannelUpdated?: (channel: Channel) => void
  onChannelArchived?: (channel: Channel) => void
  onChannelDeleted?: (communityId: string, channelId: string) => void
  onReaction?: (result: { messageId: string; channelId: string; reactions: unknown }) => void
  onMemberRemoved?: (communityId: string, userId: string) => void
  onMember?: (communityId: string, userId: string) => void
}

type Env = { Variables: { user: User } }

const setupCommand = (agentId: string, token: string, runtime: string): string =>
  `npm run runner -- --token ${token} --runtime ${runtime} --cwd ./agents/${agentId}`

export function createApi(database: DatabaseSync, hooks: Hooks): Hono<Env> {
  const app = new Hono<Env>()

  app.onError((error, context) => {
    if (error instanceof ApiError) return context.json({ error: error.message, code: error.code }, statusFor(error.code))
    /* A body that fails the shared contract is the caller's problem, not a
       server fault. Reporting it as 500 would send clients into retry loops
       over input that can never succeed. */
    if (error instanceof ZodError) {
      const first = error.issues[0]
      const where = first?.path.length ? `${first.path.join(".")}: ` : ""
      return context.json({ error: `${where}${first?.message ?? "invalid input"}`, code: "invalid_input" }, 400)
    }
    return context.json({ error: "Unexpected server error" }, 500)
  })

  /* An account is a display name. No email, no password: this is a demo
     foundation, and OAuth is deliberately out of scope. */
  app.post("/api/users", async (context) => {
    const input = createUserInputSchema.parse(await context.req.json())
    const { user, token } = createUser(database, input.displayName)
    return context.json({ user, token }, 201)
  })

  /* Everything below needs a user. */
  app.use("/api/*", async (context, next) => {
    if (context.req.path === "/api/users" && context.req.method === "POST") return next()
    const header = context.req.header("authorization") ?? ""
    const token = header.startsWith("Bearer ") ? header.slice(7) : ""
    const user = token ? userForToken(database, token) : undefined
    if (!user) return context.json({ error: "Authentication required", code: "unauthorized" }, 401)
    context.set("user", user)
    return next()
  })

  app.get("/api/session", (context) => context.json(session(database, context.get("user"))))

  app.get("/api/communities", (context) => context.json(listCommunities(database, context.get("user"))))

  app.post("/api/communities", async (context) => {
    const input = createCommunityInputSchema.parse(await context.req.json())
    return context.json(createCommunity(database, context.get("user"), input), 201)
  })

  app.post("/api/invites/redeem", async (context) => {
    const input = redeemInviteInputSchema.parse(await context.req.json())
    const result = redeemInvite(database, context.get("user"), input.code)
    hooks.onMember?.(result.community.id, context.get("user").id)
    return context.json(result)
  })

  const scoped = (path: string) => `/api/communities/:communityId${path}`
  /* Hono types a path param as possibly-undefined because the route string is
     not known statically here; a registered route always supplies it. */
  type Ctx = { req: { param: (key: string) => string | undefined } }
  const param = (context: Ctx, key: string): string => context.req.param(key) ?? ""
  const tenant = (context: Ctx): string => param(context, "communityId")
  /* Mirrors the rule `createMessage` applies, so an upload cannot succeed where
     the message that would carry it is refused. */
  const requirePostable = (communityId: string, channelId: string, userId: string): void => {
    if (!canReadChannel(database, communityId, channelId, userId)) throw new ApiError("not_found", "Channel does not exist")
  }

  app.get(scoped(""), (context) => context.json(workspace(database, tenant(context), context.get("user"), hooks.presence)))

  app.patch(scoped(""), async (context) => {
    const input = updateCommunityInputSchema.parse(await context.req.json())
    const community = updateCommunity(database, tenant(context), context.get("user"), input)
    hooks.onCommunityUpdated?.(community)
    return context.json(community)
  })
  app.get(scoped("/members"), (context) => context.json(listMembers(database, tenant(context), context.get("user"))))
  /* `?archived=1` is how an archived channel is found again, since the default
     listing hides it — otherwise archiving would be a one-way door. */
  app.get(scoped("/channels"), (context) =>
    context.json(listChannels(database, tenant(context), context.get("user").id, context.req.query("archived") === "1")))
  app.get(scoped("/agents"), (context) => context.json(listAgents(database, tenant(context), context.get("user").id, hooks.presence)))
  app.get(scoped("/cards"), (context) => context.json(listCards(database, tenant(context), context.get("user"))))

  app.patch(scoped("/members/:userId"), async (context) => {
    const input = updateMemberInputSchema.parse(await context.req.json())
    const member = updateMemberRole(database, tenant(context), context.get("user"), param(context, "userId"), input.role)
    hooks.onMemberUpdated?.(member)
    return context.json(member)
  })

  app.delete(scoped("/members/:userId"), (context) => {
    const communityId = tenant(context)
    const userId = param(context, "userId")
    const member = removeMember(database, communityId, context.get("user"), userId)
    hooks.onMemberRemoved?.(communityId, userId)
    return context.json(member)
  })

  /* Leaving is separate from being removed: it needs no teacher, only yourself. */
  app.delete(scoped("/membership"), (context) => {
    const communityId = tenant(context)
    const user = context.get("user")
    const member = leaveCommunity(database, communityId, user)
    hooks.onMemberRemoved?.(communityId, user.id)
    return context.json(member)
  })

  app.post(scoped("/invites"), async (context) => {
    const input = createInviteInputSchema.parse(await context.req.json())
    return context.json(createInvite(database, tenant(context), context.get("user"), input), 201)
  })

  app.post(scoped("/channels"), async (context) => {
    const input = createChannelInputSchema.parse(await context.req.json())
    const channel = createChannel(database, tenant(context), context.get("user"), input)
    hooks.onChannel?.(channel)
    return context.json(channel, 201)
  })

  app.get(scoped("/channels/browse"), (context) =>
    context.json(browseChannels(database, tenant(context), context.get("user"))))

  app.patch(scoped("/channels/:channelId"), async (context) => {
    const input = updateChannelInputSchema.parse(await context.req.json())
    const channel = updateChannel(database, tenant(context), context.get("user"), param(context, "channelId"), input)
    if (input.archived !== undefined) hooks.onChannelArchived?.(channel)
    else hooks.onChannelUpdated?.(channel)
    return context.json(channel)
  })

  app.delete(scoped("/channels/:channelId"), (context) => {
    const communityId = tenant(context)
    const channelId = param(context, "channelId")
    const channel = deleteChannel(database, communityId, context.get("user"), channelId)
    hooks.onChannelDeleted?.(communityId, channelId)
    return context.json(channel)
  })

  app.delete(scoped("/channels/:channelId/leave"), (context) => {
    const channel = leaveChannel(database, tenant(context), context.get("user"), param(context, "channelId"))
    return context.json(channel)
  })

  /* Uploading is its own step. A file arrives unattached, and a later message
     claims it — which is what makes an upload cancellable and lets the composer
     show a file before the message exists. */
  app.post(
    scoped("/channels/:channelId/attachments"),
    bodyLimit({
      maxSize: MAX_ATTACHMENT_BYTES + 64 * 1024,
      onError: (context) => context.json({ error: `That file is larger than the ${MAX_ATTACHMENT_BYTES} byte limit`, code: "invalid_input" }, 413),
    }),
    async (context) => {
      const communityId = tenant(context)
      const channelId = param(context, "channelId")
      const user = context.get("user")
      /* Uploading is posting: it needs the same membership the message will. */
      requirePostable(communityId, channelId, user.id)
      const body = await context.req.parseBody()
      const file = body.file
      if (!(file instanceof File)) return context.json({ error: "A file is required", code: "invalid_input" }, 400)
      const stored = storeAttachment(database, attachmentsRoot(), {
        communityId, channelId, uploaderId: user.id,
        name: file.name, mime: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
      })
      return context.json({ id: stored.id, name: stored.name, mime: stored.mime, size: stored.size }, 201)
    },
  )

  app.get(scoped("/attachments/:attachmentId"), (context) => {
    const communityId = tenant(context)
    const { attachment, bytes } = readAttachment(database, attachmentsRoot(), communityId, param(context, "attachmentId"))
    /* The file inherits its channel's read rule, not a guessable id. */
    if (!canReadChannel(database, communityId, attachment.channelId, context.get("user").id)) {
      return context.json({ error: "That file does not exist", code: "not_found" }, 404)
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": attachment.mime,
        "content-length": String(attachment.size),
        /* Always an attachment: a downloaded file must never be rendered as a
           document on this origin. */
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        "x-content-type-options": "nosniff",
      },
    })
  })

  app.delete(scoped("/attachments/:attachmentId"), (context) => {
    const communityId = tenant(context)
    const user = context.get("user")
    const removed = deleteAttachment(database, attachmentsRoot(), communityId, param(context, "attachmentId"), user.id, roleIn(database, communityId, user.id) === "teacher")
    return context.json({ id: removed.id, name: removed.name, mime: removed.mime, size: removed.size })
  })

  app.post(scoped("/channels/:channelId/read"), async (context) => {
    const input = markReadInputSchema.parse(await context.req.json())
    const result = markChannelRead(database, tenant(context), context.get("user"), param(context, "channelId"), input.lastReadAt)
    hooks.onRead?.(tenant(context), result)
    return context.json(result)
  })

  app.post(scoped("/channels/:channelId/join"), (context) =>
    context.json(joinChannel(database, tenant(context), context.get("user"), param(context, "channelId"))))

  app.post(scoped("/dms"), async (context) => {
    const input = createDmInputSchema.parse(await context.req.json())
    const channel = openDm(database, tenant(context), context.get("user"), input.agentId)
    hooks.onChannel?.(channel)
    return context.json(channel, 201)
  })

  app.post(scoped("/agents"), async (context) => {
    const communityId = tenant(context)
    const input = createAgentInputSchema.parse(await context.req.json())
    const { agent, token } = createAgent(database, communityId, context.get("user"), input, hooks.presence)
    hooks.onAgent?.(agent)
    /* The raw runner token appears here and never again. */
    return context.json({ agent, enrollment: { agentId: agent.id, communityId, runnerToken: token, setupCommand: setupCommand(agent.id, token, agent.runtime) } }, 201)
  })

  app.get(scoped("/agents/:agentId"), (context) =>
    context.json(getAgent(database, tenant(context), context.get("user"), param(context, "agentId"), hooks.presence)))

  app.patch(scoped("/agents/:agentId"), async (context) => {
    const input = updateAgentInputSchema.parse(await context.req.json())
    const agent = updateAgent(database, tenant(context), context.get("user"), param(context, "agentId"), input, hooks.presence)
    /* A rename retitles the DM channels too, so viewers reload the roster. */
    hooks.onAgent?.(agent)
    return context.json(agent)
  })

  app.delete(scoped("/agents/:agentId"), (context) => {
    const communityId = tenant(context)
    const agent = deleteAgent(database, communityId, context.get("user"), param(context, "agentId"), hooks.presence)
    /* Deleting revokes the runner: its token no longer resolves, and any socket
       it already had open is closed. */
    hooks.onAgentDeleted?.(communityId, agent)
    return context.json(agent)
  })

  app.post(scoped("/agents/:agentId/enrollment"), (context) => {
    const communityId = tenant(context)
    const agentId = param(context, "agentId")
    const token = rotateAgentToken(database, communityId, context.get("user"), agentId)
    return context.json({ agentId, communityId, runnerToken: token, setupCommand: setupCommand(agentId, token, "claude") })
  })

  app.get(scoped("/channels/:channelId/messages"), (context) =>
    context.json(listMessages(database, tenant(context), context.get("user"), param(context, "channelId"))))

  app.post(scoped("/channels/:channelId/messages"), async (context) => {
    const input = createMessageInputSchema.parse(await context.req.json())
    const message = createMessage(database, tenant(context), context.get("user"), param(context, "channelId"), input)
    hooks.onMessage?.(message)
    return context.json(message, 201)
  })

  app.get(scoped("/channels/:channelId/threads"), (context) =>
    context.json(listThreads(database, tenant(context), context.get("user"), param(context, "channelId"))))

  app.post(scoped("/threads"), async (context) => {
    const input = createThreadInputSchema.parse(await context.req.json())
    const thread = createThread(database, tenant(context), context.get("user"), input.rootMessageId)
    hooks.onThread?.(thread)
    return context.json(thread, 201)
  })

  app.post(scoped("/messages/:messageId/reactions"), async (context) => {
    const input = reactInputSchema.parse(await context.req.json())
    const result = react(database, tenant(context), context.get("user"), param(context, "messageId"), input.emoji, true)
    hooks.onReaction?.(result)
    return context.json(result, 201)
  })

  app.delete(scoped("/messages/:messageId/reactions/:emoji"), (context) => {
    /* The emoji rides in the path, so it must be decoded before it is matched. */
    const emoji = decodeURIComponent(param(context, "emoji"))
    const result = react(database, tenant(context), context.get("user"), param(context, "messageId"), emoji, false)
    hooks.onReaction?.(result)
    return context.json(result)
  })

  app.patch(scoped("/messages/:messageId"), async (context) => {
    const input = editMessageInputSchema.parse(await context.req.json())
    const message = editMessage(database, tenant(context), context.get("user"), param(context, "messageId"), input.paragraphs)
    hooks.onMessageEdited?.(message)
    return context.json(message)
  })

  app.delete(scoped("/messages/:messageId"), (context) => {
    const message = deleteMessage(database, tenant(context), context.get("user"), param(context, "messageId"))
    hooks.onMessage?.(message)
    return context.json(message)
  })

  /* Last: everything that is not an API route is the client. Registered after
     every route above, so it can never shadow one, and only when a build
     actually exists — in development Vite serves the app instead. */
  const distDir = webDistDir()
  if (hasWebDist(distDir)) {
    app.get("*", (context) => {
      const pathname = new URL(context.req.url).pathname
      if (pathname.startsWith("/api")) return context.json({ error: "Not found", code: "not_found" }, 404)
      return serveWebFile(distDir, pathname)
    })
  }

  return app
}

export { publishCard }
