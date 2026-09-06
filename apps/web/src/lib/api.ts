/* The client. Every response is parsed with the shared schema before it reaches
   a component, so a server change surfaces here rather than as a blank screen
   three renders later. */
import { z } from "zod"
import {
  agentSchema, cardSchema, channelSchema, createAgentResultSchema, createUserResultSchema,
  attachmentSchema, channelSummarySchema, communitySchema, memberSchema, messageSchema, sessionSchema, threadSchema, workspaceSchema,
  type Agent, type Attachment, type Card, type Channel, type ChannelSummary, type Member, type Message, type Paragraphs, type Role, type Session, type Thread, type Workspace,
} from "@elaine/protocol"

const TOKEN_KEY = "elaine.token"

export const readToken = (): string | undefined => {
  try { return localStorage.getItem(TOKEN_KEY) ?? undefined } catch { return undefined }
}
export const writeToken = (token: string | undefined): void => {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY) } catch { /* private mode */ }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function call<T>(schema: z.ZodType<T>, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init
  const response = await fetch(path, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...rest.headers,
    },
  })
  const text = await response.text()
  let body: unknown
  try { body = text ? JSON.parse(text) : {} } catch { body = {} }
  if (!response.ok) {
    const message = (body as { error?: string }).error ?? `Request failed (${response.status})`
    throw new ApiError(response.status, message)
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new ApiError(response.status, `The server sent something this client does not understand (${path})`)
  return parsed.data
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) })

export const api = {
  createAccount: (displayName: string) =>
    call(createUserResultSchema, "/api/users", json({ displayName })),

  session: (token: string) =>
    call(sessionSchema, "/api/session", { token }),

  createCommunity: (token: string, name: string, term?: string) =>
    call(z.object({ community: z.object({ id: z.string() }).passthrough(), role: z.string() }), "/api/communities", { ...json({ name, ...(term ? { term } : {}) }), token }),

  redeemInvite: (token: string, code: string) =>
    call(z.object({ community: z.object({ id: z.string(), name: z.string() }).passthrough(), role: z.string() }), "/api/invites/redeem", { ...json({ code }), token }),

  updateCommunity: (token: string, communityId: string, input: { name?: string; term?: string }) =>
    call(communitySchema, `/api/communities/${communityId}`, { method: "PATCH", body: JSON.stringify(input), token }),

  workspace: (token: string, communityId: string) =>
    call(workspaceSchema, `/api/communities/${communityId}`, { token }),

  messages: (token: string, communityId: string, channelId: string) =>
    call(z.array(messageSchema), `/api/communities/${communityId}/channels/${channelId}/messages`, { token }),

  cards: (token: string, communityId: string) =>
    call(z.array(cardSchema), `/api/communities/${communityId}/cards`, { token }),

  send: (token: string, communityId: string, channelId: string, paragraphs: Paragraphs, threadId?: string, attachmentIds?: string[], clientId?: string) =>
    call(messageSchema, `/api/communities/${communityId}/channels/${channelId}/messages`, {
      ...json({
        paragraphs,
        ...(threadId ? { threadId } : {}),
        ...(attachmentIds?.length ? { attachmentIds } : {}),
        ...(clientId ? { clientId } : {}),
      }),
      token,
    }),

  /* Multipart, so the browser sets its own boundary; `call` is bypassed
     because its JSON content-type would break that. */
  uploadAttachment: async (token: string, communityId: string, channelId: string, file: File): Promise<Attachment> => {
    const form = new FormData()
    form.append("file", file)
    const response = await fetch(`/api/communities/${communityId}/channels/${channelId}/attachments`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
    })
    const text = await response.text()
    const body: unknown = text ? JSON.parse(text) : {}
    if (!response.ok) throw new ApiError(response.status, (body as { error?: string }).error ?? "Could not upload that file")
    return attachmentSchema.parse(body)
  },

  /* The bytes need the bearer token, so a plain link cannot fetch them; the
     response becomes an object URL the browser can save. */
  downloadAttachment: async (token: string, communityId: string, attachmentId: string): Promise<Blob> => {
    const response = await fetch(`/api/communities/${communityId}/attachments/${attachmentId}`, { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) throw new ApiError(response.status, "That file could not be fetched")
    return response.blob()
  },

  removeAttachment: (token: string, communityId: string, attachmentId: string) =>
    call(attachmentSchema, `/api/communities/${communityId}/attachments/${attachmentId}`, { method: "DELETE", token }),

  createChannel: (token: string, communityId: string, name: string, visibility: "public" | "private") =>
    call(channelSchema, `/api/communities/${communityId}/channels`, { ...json({ name, visibility }), token }),

  joinChannel: (token: string, communityId: string, channelId: string) =>
    call(channelSchema, `/api/communities/${communityId}/channels/${channelId}/join`, { ...json({}), token }),

  openDm: (token: string, communityId: string, agentId: string) =>
    call(channelSchema, `/api/communities/${communityId}/dms`, { ...json({ agentId }), token }),

  createInvite: (token: string, communityId: string, role: Role, mode: "single-use" | "reusable") =>
    call(z.object({ code: z.string(), role: z.string(), maxUses: z.number() }), `/api/communities/${communityId}/invites`, { ...json({ role, mode }), token }),

  editMessage: (token: string, communityId: string, messageId: string, paragraphs: Paragraphs) =>
    call(messageSchema, `/api/communities/${communityId}/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ paragraphs }), token }),

  markRead: (token: string, communityId: string, channelId: string, lastReadAt: string) =>
    call(z.object({ channelId: z.string(), unread: z.boolean() }).passthrough(), `/api/communities/${communityId}/channels/${channelId}/read`, { ...json({ lastReadAt }), token }),

  archivedChannels: (token: string, communityId: string) =>
    call(z.array(channelSchema), `/api/communities/${communityId}/channels?archived=1`, { token }),

  browseChannels: (token: string, communityId: string) =>
    call(z.array(channelSummarySchema), `/api/communities/${communityId}/channels/browse`, { token }),

  updateChannel: (token: string, communityId: string, channelId: string, input: { name?: string; visibility?: "public" | "private"; archived?: boolean }) =>
    call(channelSchema, `/api/communities/${communityId}/channels/${channelId}`, { method: "PATCH", body: JSON.stringify(input), token }),

  deleteChannel: (token: string, communityId: string, channelId: string) =>
    call(channelSchema, `/api/communities/${communityId}/channels/${channelId}`, { method: "DELETE", token }),

  leaveChannel: (token: string, communityId: string, channelId: string) =>
    call(channelSchema, `/api/communities/${communityId}/channels/${channelId}/leave`, { method: "DELETE", token }),

  updateMemberRole: (token: string, communityId: string, userId: string, role: Role) =>
    call(memberSchema, `/api/communities/${communityId}/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }), token }),

  removeMember: (token: string, communityId: string, userId: string) =>
    call(memberSchema, `/api/communities/${communityId}/members/${userId}`, { method: "DELETE", token }),

  leaveCommunity: (token: string, communityId: string) =>
    call(memberSchema, `/api/communities/${communityId}/membership`, { method: "DELETE", token }),

  react: (token: string, communityId: string, messageId: string, emoji: string, on: boolean) =>
    on
      ? call(z.object({ messageId: z.string() }).passthrough(), `/api/communities/${communityId}/messages/${messageId}/reactions`, { ...json({ emoji }), token })
      /* The emoji is a path segment, so it has to be encoded on the way out. */
      : call(z.object({ messageId: z.string() }).passthrough(), `/api/communities/${communityId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: "DELETE", token }),

  deleteMessage: (token: string, communityId: string, messageId: string) =>
    call(messageSchema, `/api/communities/${communityId}/messages/${messageId}`, { method: "DELETE", token }),

  threads: (token: string, communityId: string, channelId: string) =>
    call(z.array(threadSchema), `/api/communities/${communityId}/channels/${channelId}/threads`, { token }),

  createThread: (token: string, communityId: string, rootMessageId: string) =>
    call(threadSchema, `/api/communities/${communityId}/threads`, { ...json({ rootMessageId }), token }),

  updateAgent: (token: string, communityId: string, agentId: string, input: { name?: string; instructions?: string; runtime?: "claude" | "codex" | "api"; model?: string; channelIds?: string[] }) =>
    call(agentSchema, `/api/communities/${communityId}/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(input), token }),

  deleteAgent: (token: string, communityId: string, agentId: string) =>
    call(agentSchema, `/api/communities/${communityId}/agents/${agentId}`, { method: "DELETE", token }),

  createAgent: (token: string, communityId: string, input: { name: string; instructions: string; runtime: "claude" | "codex" | "api"; model: string; channelIds: string[] }) =>
    call(createAgentResultSchema, `/api/communities/${communityId}/agents`, { ...json(input), token }),
}

export type { Agent, Attachment, Card, Channel, ChannelSummary, Member, Message, Session, Thread, Workspace }
export { agentSchema, memberSchema }
