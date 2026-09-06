/* The shared domain contract. Both the server and the web client parse network
   payloads with these schemas; neither may define its own copy.

   Two invariants shape everything here:
   - Every resource except a User carries a `communityId`. A user is global and
     has one session; membership (and therefore role) is per community.
   - A raw token appears only in the one response that mints it. It is never a
     field on a projection or an event. */
import { z } from "zod"

export const idSchema = z.string().trim().min(1).max(200)
export const nameSchema = z.string().trim().min(1).max(200)
export const timestampSchema = z.string().datetime()

export const roleSchema = z.enum(["teacher", "student"])
export const presenceSchema = z.enum(["online", "offline", "thinking", "publishing"])
/* `claude` and `codex` are driven by a CLI the creator is signed into, on their
   own machine. `api` is answered by the server itself against a configured
   HTTP endpoint, so an agent can work with nothing running locally. */
export const runtimeSchema = z.enum(["claude", "codex", "api"])
export const agentStatusSchema = z.enum(["active", "disabled", "deleted"])
export const channelKindSchema = z.enum(["channel", "dm"])
export const visibilitySchema = z.enum(["public", "private"])

/* The seven frontmatter types a card can carry. `difficulty` and `person` are
   written by an agent but never published into a channel. */
export const cardTypeSchema = z.enum(["topic", "decision", "question", "assignment", "submission", "difficulty", "person"])

/* ---- Messages -------------------------------------------------------------- */

/* A message is blocks, not markdown: the channel renders plain text, code
   fences, and citations that resolve to a real card id. */
export const blockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().max(20_000) }).strict(),
  z.object({ kind: z.literal("code"), text: z.string().max(20_000) }).strict(),
  z.object({ kind: z.literal("cite"), text: z.string().max(2_000), cite: z.object({ cardId: idSchema, section: z.string().max(200).optional() }).strict() }).strict(),
])
export const paragraphsSchema = z.array(z.array(blockSchema).min(1)).min(1).max(200)

/* "Composed from the card file."

   The thesis, made checkable: this answer was built from cards the group had
   already compiled, without going back to the raw sources. It is provenance,
   never an answer cache — the answer itself is fresh, and only the
   understanding behind it is reused.

   Plural because composing normally draws on several cards and the first cited
   one is not privileged. `oldestAgo` is SECONDS, an integer, frozen at compose
   time (the message's own timestamp minus the oldest cited card's), so the seal
   states what was true when the answer was written and never drifts as the
   thread ages. Rendering it as "3 days ago" is the client's job. */
export const fromFileSchema = z.object({
  cardIds: z.array(idSchema).min(1).max(50),
  oldestAgo: z.number().int().min(0),
}).strict()

/* Reactions are aggregated, not per-viewer: everyone who can read the channel
   sees the same tallies, and "did I react?" is derived on the client from the
   ids. A single emoji, no skin-tone sequences longer than this, and never
   whitespace — an invisible reaction would be a way to spam a tally. */
export const emojiSchema = z.string().trim().min(1).max(16).regex(/^\S+$/u, "a reaction cannot contain whitespace")
export const reactionSchema = z.object({
  emoji: emojiSchema,
  userIds: z.array(idSchema).min(1).max(1_000),
}).strict()
export const reactInputSchema = z.object({ emoji: emojiSchema }).strict()

/* What a message shows about a posted file. The bytes are fetched separately
   through an authorized route; this is only enough to render and click. */
export const attachmentSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(255),
  size: z.number().int().min(0),
}).strict()

export const messageSchema = z.object({
  id: idSchema,
  communityId: idSchema,
  channelId: idSchema,
  authorId: idSchema,
  authorKind: z.enum(["user", "agent"]),
  paragraphs: paragraphsSchema,
  fromFile: fromFileSchema.optional(),
  reactions: z.array(reactionSchema).max(50).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  threadId: idSchema.optional(),
  /* Echoed back so a client can match the message it sent to the one that
     arrived, and recognise its own retry. */
  clientId: z.string().max(200).optional(),
  at: timestampSchema,
  editedAt: timestampSchema.optional(),
  deletedAt: timestampSchema.optional(),
  /* Who removed it. A teacher may delete anyone's message, so a tombstone that
     did not say who would leave moderation invisible. */
  deletedBy: idSchema.optional(),
}).strict()

/* ---- Resources ------------------------------------------------------------- */

export const userSchema = z.object({
  id: idSchema,
  displayName: nameSchema,
  createdAt: timestampSchema,
}).strict()

export const communitySchema = z.object({
  id: idSchema,
  name: nameSchema,
  term: z.string().trim().max(100).optional(),
  createdAt: timestampSchema,
}).strict()

export const memberSchema = z.object({
  userId: idSchema,
  communityId: idSchema,
  displayName: nameSchema,
  role: roleSchema,
  joinedAt: timestampSchema,
}).strict()

export const channelSchema = z.object({
  id: idSchema,
  communityId: idSchema,
  name: nameSchema,
  kind: channelKindSchema,
  visibility: visibilitySchema,
  /* A DM between a student and an agent. Both are needed to authorize a read:
     the pair, plus any teacher who created the agent. */
  userId: idSchema.optional(),
  agentId: idSchema.optional(),
  /* Per viewer: whether anything has arrived here since they last looked.
     Absent when it was not asked for. */
  unread: z.boolean().optional(),
  /* Per viewer: reading a public channel needs nothing, but posting needs
     membership, so the client has to be able to tell the two apart. */
  joined: z.boolean().optional(),
  archivedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
}).strict()

export const agentSchema = z.object({
  id: idSchema,
  communityId: idSchema,
  name: nameSchema,
  instructions: z.string().max(20_000),
  runtime: runtimeSchema,
  model: z.string().max(200),
  status: agentStatusSchema,
  createdBy: idSchema,
  presence: presenceSchema,
  channelIds: z.array(idSchema),
  createdAt: timestampSchema,
}).strict()

export const cardSchema = z.object({
  id: idSchema,
  communityId: idSchema,
  agentId: idSchema,
  channelId: idSchema,
  /* A card's identity is its path in the agent's wiki: `modules/03-backprop/chain-rule.md`. */
  path: z.string().trim().min(1).max(2_000),
  title: nameSchema,
  type: cardTypeSchema,
  body: z.string().max(200_000),
  version: z.number().int().min(1),
  /* Rule 6: a contradicted card is replaced, never edited. The trail remains. */
  replaces: idSchema.optional(),
  sourceMessageIds: z.array(idSchema).max(100),
  createdAt: timestampSchema,
}).strict()

/* ---- REST inputs ----------------------------------------------------------- */

export const createUserInputSchema = z.object({ displayName: nameSchema }).strict()
export const createCommunityInputSchema = z.object({ name: nameSchema, term: z.string().trim().max(100).optional() }).strict()
export const createInviteInputSchema = z.object({
  role: roleSchema,
  mode: z.enum(["single-use", "reusable"]),
  maxUses: z.number().int().min(1).max(1_000).optional(),
}).strict()
export const redeemInviteInputSchema = z.object({ code: z.string().trim().min(6).max(100) }).strict()
export const createChannelInputSchema = z.object({
  name: nameSchema,
  visibility: visibilitySchema.default("public"),
}).strict()
export const createDmInputSchema = z.object({ agentId: idSchema }).strict()
export const createAgentInputSchema = z.object({
  name: nameSchema,
  instructions: z.string().max(20_000).default(""),
  runtime: runtimeSchema,
  model: z.string().max(200).default("default"),
  channelIds: z.array(idSchema).max(100).default([]),
}).strict()
/* A thread hangs off a root message. Its id is stable and separate from that
   message so replies keep pointing somewhere even as the root is edited. */
export const threadSchema = z.object({
  id: idSchema,
  communityId: idSchema,
  channelId: idSchema,
  rootMessageId: idSchema,
  createdAt: timestampSchema,
}).strict()
/* What a public channel shows to someone who has not joined it: enough to
   decide whether to, and nothing that was said inside. */
export const channelSummarySchema = z.object({
  id: idSchema,
  communityId: idSchema,
  name: nameSchema,
  memberCount: z.number().int().min(0),
  createdAt: timestampSchema,
}).strict()
export const updateChannelInputSchema = z.object({
  name: nameSchema.optional(),
  visibility: visibilitySchema.optional(),
  /* Archiving is how a channel with history is retired: it leaves the sidebar
     and stops accepting messages, and everything said in it is still there. */
  archived: z.boolean().optional(),
}).strict()

/* Both optional, each falling back to what the community already has, as the
   old repo's updateTenantCommunity did. */
export const updateCommunityInputSchema = z.object({
  name: nameSchema.optional(),
  term: z.string().trim().max(100).optional(),
}).strict()

export const markReadInputSchema = z.object({ lastReadAt: timestampSchema }).strict()

export const updateMemberInputSchema = z.object({ role: roleSchema }).strict()
export const editMessageInputSchema = z.object({ paragraphs: paragraphsSchema }).strict()
export const createThreadInputSchema = z.object({ rootMessageId: idSchema }).strict()

/* Mirrors the old repo's updateCommunityAgentInputSchema: every field optional,
   and `channelIds` replaces the assignment set. */
export const updateAgentInputSchema = z.object({
  name: nameSchema.optional(),
  instructions: z.string().max(20_000).optional(),
  runtime: runtimeSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  channelIds: z.array(idSchema).max(1_000).optional(),
}).strict()
export const createMessageInputSchema = z.object({
  paragraphs: paragraphsSchema,
  threadId: idSchema.optional(),
  attachmentIds: z.array(idSchema).max(20).optional(),
  /* A retry after a lost response must not post the message twice. */
  clientId: z.string().trim().min(1).max(200).optional(),
}).strict()

/* The raw user token exists only in this response. */
export const createUserResultSchema = z.object({ user: userSchema, token: z.string().min(40) }).strict()
/* The raw runner token exists only here and in a rotation response. */
export const agentEnrollmentSchema = z.object({
  agentId: idSchema,
  communityId: idSchema,
  runnerToken: z.string().min(40),
  setupCommand: z.string(),
}).strict()
export const createAgentResultSchema = z.object({ agent: agentSchema, enrollment: agentEnrollmentSchema }).strict()

/* What one member sees of one community: only the channels they may read. */
export const workspaceSchema = z.object({
  community: communitySchema,
  role: roleSchema,
  members: z.array(memberSchema),
  channels: z.array(channelSchema),
  agents: z.array(agentSchema),
}).strict()

export const sessionSchema = z.object({
  user: userSchema,
  communities: z.array(z.object({ community: communitySchema, role: roleSchema }).strict()),
}).strict()

/* ---- Events ---------------------------------------------------------------- */

/* Every event is scoped. The socket filters per receiver before sending, so a
   payload never contains a resource the receiver may not read. */
/* `Type extends string` matters: a plain `string` parameter would widen every
   variant's `type` to `string`, and the union would stop narrowing on it at
   every consumer. */
const event = <Type extends string, Payload extends z.ZodTypeAny>(type: Type, payload: Payload) =>
  z.object({ type: z.literal(type), communityId: idSchema, at: timestampSchema, payload }).strict()

export const serverEventSchema = z.discriminatedUnion("type", [
  event("message.created", z.object({ message: messageSchema }).strict()),
  event("message.updated", z.object({ message: messageSchema }).strict()),
  event("message.reacted", z.object({ messageId: idSchema, channelId: idSchema, reactions: z.array(reactionSchema).max(50) }).strict()),
  event("message.deleted", z.object({ messageId: idSchema, channelId: idSchema, deletedBy: idSchema }).strict()),
  event("channel.created", z.object({ channel: channelSchema }).strict()),
  event("channel.updated", z.object({ channel: channelSchema }).strict()),
  event("channel.deleted", z.object({ channelId: idSchema }).strict()),
  event("channel.archived", z.object({ channel: channelSchema }).strict()),
  event("channel.read", z.object({ channelId: idSchema, userId: idSchema, lastReadAt: timestampSchema, unread: z.boolean() }).strict()),
  event("thread.created", z.object({ thread: threadSchema }).strict()),
  event("community.updated", z.object({ community: communitySchema }).strict()),
  event("member.joined", z.object({ member: memberSchema }).strict()),
  event("member.updated", z.object({ member: memberSchema }).strict()),
  event("member.removed", z.object({ userId: idSchema }).strict()),
  event("agent.updated", z.object({ agent: agentSchema }).strict()),
  event("agent.deleted", z.object({ agent: agentSchema }).strict()),
  event("runner.presence", z.object({ agentId: idSchema, presence: presenceSchema }).strict()),
  event("typing.updated", z.object({ channelId: idSchema, userId: idSchema, typing: z.boolean() }).strict()),
  event("card.published", z.object({ card: cardSchema }).strict()),
])

/* The browser authenticates in the first frame and binds to one community. A
   token in a query string would end up in logs and history. */
/* Typing is the one thing a browser tells the server over the socket rather
   than by request: it is high-frequency, worthless once stale, and must never
   be persisted. */
export const browserTypingFrameSchema = z.object({
  type: z.literal("typing.set"),
  payload: z.object({ channelId: idSchema, typing: z.boolean() }).strict(),
}).strict()

export const browserAuthFrameSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(20),
  communityId: idSchema,
}).strict()

export const browserClientFrameSchema = z.discriminatedUnion("type", [
  browserAuthFrameSchema,
  browserTypingFrameSchema,
])

export const browserServerFrameSchema = z.union([
  z.object({ type: z.literal("ready"), communityId: idSchema, userId: idSchema }).strict(),
  z.object({ type: z.literal("event"), event: serverEventSchema }).strict(),
])

export type Role = z.infer<typeof roleSchema>
export type Presence = z.infer<typeof presenceSchema>
export type Runtime = z.infer<typeof runtimeSchema>
export type CardType = z.infer<typeof cardTypeSchema>
export type Block = z.infer<typeof blockSchema>
export type Paragraphs = z.infer<typeof paragraphsSchema>
export type FromFile = z.infer<typeof fromFileSchema>
export type Message = z.infer<typeof messageSchema>
export type User = z.infer<typeof userSchema>
export type Community = z.infer<typeof communitySchema>
export type Member = z.infer<typeof memberSchema>
export type Channel = z.infer<typeof channelSchema>
export type Agent = z.infer<typeof agentSchema>
export type Card = z.infer<typeof cardSchema>
export type Thread = z.infer<typeof threadSchema>
export type Reaction = z.infer<typeof reactionSchema>
export type ChannelSummary = z.infer<typeof channelSummarySchema>
export type Attachment = z.infer<typeof attachmentSchema>
export type Workspace = z.infer<typeof workspaceSchema>
export type Session = z.infer<typeof sessionSchema>
export type ServerEvent = z.infer<typeof serverEventSchema>
export type AgentEnrollment = z.infer<typeof agentEnrollmentSchema>
