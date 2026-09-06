/* The runner boundary.

   An agent is identity + folder + runner. The server never runs a model: it
   dispatches scoped work to a separate process that lives wherever the agent
   creator's provider credentials live, and that process connects OUTBOUND and
   authenticates in its first frame. Elaine therefore never holds a provider API
   key, and this contract carries none. */
import { z } from "zod"
import { agentSchema, cardTypeSchema, idSchema, memberSchema, messageSchema, paragraphsSchema, presenceSchema, runtimeSchema } from "./core.js"

export const runnerAuthFrameSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(20),
}).strict()

export const runnerPresenceFrameSchema = z.object({
  type: z.literal("presence"),
  payload: z.object({
    presence: presenceSchema,
    runtime: runtimeSchema,
    model: z.string().max(200).optional(),
  }).strict(),
}).strict()

/* The runner names the cards it composed from; it never dates them. It runs on
   someone else's machine, so its clock is not evidence — the server derives
   `oldestAgo` from its own card rows. That is why this is not `fromFileSchema`. */
export const runnerFromFileSchema = z.object({ cardIds: z.array(idSchema).min(1).max(50) }).strict()

export const runnerMessageCreateSchema = z.object({
  type: z.literal("message.create"),
  ref: idSchema,
  payload: z.object({
    communityId: idSchema,
    agentId: idSchema,
    channelId: idSchema,
    threadId: idSchema.optional(),
    paragraphs: paragraphsSchema,
    fromFile: runnerFromFileSchema.optional(),
  }).strict(),
}).strict()

export const runnerCardPublishSchema = z.object({
  type: z.literal("card.publish"),
  ref: idSchema,
  payload: z.object({
    communityId: idSchema,
    agentId: idSchema,
    channelId: idSchema,
    path: z.string().trim().min(1).max(2_000),
    title: z.string().trim().min(1).max(200),
    type: cardTypeSchema,
    body: z.string().max(200_000),
    sourceMessageIds: z.array(idSchema).max(100).default([]),
    /* Rule 6: a contradicted card is replaced, not edited. */
    replacesCardId: idSchema.optional(),
  }).strict(),
}).strict()

export const runnerClientFrameSchema = z.discriminatedUnion("type", [
  runnerAuthFrameSchema,
  runnerPresenceFrameSchema,
  runnerMessageCreateSchema,
  runnerCardPublishSchema,
])

/* Work is one mention. `context` is the immediate memory layer: the tail of the
   channel or thread, already filtered to what this agent may read. */
export const runnerWorkSchema = z.object({
  type: z.literal("work"),
  payload: z.object({
    communityId: idSchema,
    agentId: idSchema,
    channelId: idSchema,
    threadId: idSchema.optional(),
    message: messageSchema,
    from: memberSchema,
    context: z.array(messageSchema).max(50),
  }).strict(),
}).strict()

export const runnerServerFrameSchema = z.union([
  z.object({ type: z.literal("ready"), agent: agentSchema }).strict(),
  runnerWorkSchema,
  z.object({ type: z.literal("ack"), ref: idSchema, ok: z.literal(true), messageId: idSchema.optional(), cardId: idSchema.optional() }).strict(),
  z.object({ type: z.literal("ack"), ref: idSchema, ok: z.literal(false), error: z.string().max(2_000) }).strict(),
])

export type RunnerClientFrame = z.infer<typeof runnerClientFrameSchema>
export type RunnerServerFrame = z.infer<typeof runnerServerFrameSchema>
export type RunnerWork = z.infer<typeof runnerWorkSchema>
