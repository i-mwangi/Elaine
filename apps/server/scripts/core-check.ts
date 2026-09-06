/* End-to-end check of the core, without a browser. Throwaway database and a
   random port, so it can never touch a developer's real one.

   It asserts the things the architecture claims: a global user with per
   community roles, permissions as channel composition, a runner bound to one
   agent in one community, and the card-file seal being real provenance. */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"
import { messageSchema, workspaceSchema } from "@elaine/protocol"

const scratch = mkdtempSync(join(tmpdir(), "elaine-core-"))
process.env.ELAINE_DB = join(scratch, "core.db")
process.env.PORT = "0"

const { startServer } = await import("../src/index.js")
const running = await startServer()
const base = `http://127.0.0.1:${running.port}`
const wsBase = base.replace("http", "ws")

type Json = Record<string, any>
let passed = 0
const check = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`core: ${message}`)
  passed += 1
  console.log(`ok  ${message}`)
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function call(method: string, path: string, token: string | undefined, body?: Json): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? auth(token) : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const raw = await response.text()
  let parsed: Json = {}
  try { parsed = JSON.parse(raw) as Json } catch { parsed = { raw } }
  return { status: response.status, body: parsed }
}
async function post(path: string, token: string | undefined, body: Json): Promise<Json> {
  const result = await call("POST", path, token, body)
  if (result.status >= 300) throw new Error(`core: POST ${path} → ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}
async function get(path: string, token: string): Promise<Json> {
  const result = await call("GET", path, token)
  if (result.status >= 300) throw new Error(`core: GET ${path} → ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}

function open(url: string, first: Json): Promise<{ socket: WebSocket; frames: Json[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const frames: Json[] = []
    const timer = setTimeout(() => reject(new Error("ready timeout")), 4_000)
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Json
      frames.push(frame)
      if (frame.type === "ready") { clearTimeout(timer); resolve({ socket, frames }) }
    })
    socket.on("error", reject)
    socket.on("open", () => socket.send(JSON.stringify(first)))
  })
}
async function waitFor(frames: Json[], predicate: (frame: Json) => boolean, what: string): Promise<Json> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = frames.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`core: timed out waiting for ${what}`)
}
function send(socket: WebSocket, frames: Json[], frame: Json, ref: string): Promise<Json> {
  socket.send(JSON.stringify(frame))
  return waitFor(frames, (item) => item.type === "ack" && item.ref === ref, `ack ${ref}`)
}

try {
  /* ---- Identity is global, role is per community ------------------------ */
  const teacher = await post("/api/users", undefined, { displayName: "Marta" })
  const student = await post("/api/users", undefined, { displayName: "Bruno" })
  const outsider = await post("/api/users", undefined, { displayName: "Nadia" })
  check(typeof teacher.token === "string" && teacher.token.length >= 40, "a user token is high entropy")

  const alpha = (await post("/api/communities", teacher.token, { name: "Neural Networks", term: "2026" })).community.id as string
  const beta = (await post("/api/communities", student.token, { name: "Databases", term: "2026" })).community.id as string

  const invite = await post(`/api/communities/${alpha}/invites`, teacher.token, { role: "student", mode: "reusable", maxUses: 5 })
  await post("/api/invites/redeem", student.token, { code: invite.code })
  const betaInvite = await post(`/api/communities/${beta}/invites`, student.token, { role: "student", mode: "single-use" })
  await post("/api/invites/redeem", teacher.token, { code: betaInvite.code })

  const teacherSession = await get("/api/session", teacher.token)
  const roles = Object.fromEntries((teacherSession.communities as Json[]).map((item) => [item.community.id, item.role]))
  check(roles[alpha] === "teacher" && roles[beta] === "student", "one user carries a different role in each community")

  const single = await call("POST", "/api/invites/redeem", outsider.token, { code: betaInvite.code })
  check(single.status === 409, "a single-use invite cannot be redeemed twice")

  const foreign = await call("GET", `/api/communities/${beta}`, outsider.token)
  check(foreign.status === 403, "a non-member cannot read a community")

  /* ---- The community itself ---------------------------------------------- */
  const myCommunities = await get("/api/communities", teacher.token) as unknown as Json[]
  check((myCommunities as Json[]).some((item) => item.community.id === alpha && item.role === "teacher"), "the communities you belong to can be listed with your role in each")
  check((myCommunities as Json[]).every((item) => item.community.id !== beta || item.role === "student"), "and the role is the one you hold there, not everywhere")

  const renamedCommunity = await call("PATCH", `/api/communities/${alpha}`, teacher.token, { name: "Neural Networks (spring)" })
  check(renamedCommunity.status === 200 && renamedCommunity.body.name === "Neural Networks (spring)", "a teacher can rename the community")
  const termOnly = await call("PATCH", `/api/communities/${alpha}`, teacher.token, { term: "2027" })
  check(termOnly.body.term === "2027" && termOnly.body.name === "Neural Networks (spring)", "changing one field leaves the other alone")
  const emptied = await call("PATCH", `/api/communities/${alpha}`, teacher.token, { name: "   " })
  check(emptied.status === 400, "a community cannot be left without a name")
  const renameByStudent2 = await call("PATCH", `/api/communities/${alpha}`, student.token, { name: "mine now" })
  check(renameByStudent2.status === 403, "a student cannot rename the community")
  await call("PATCH", `/api/communities/${alpha}`, teacher.token, { name: "Alpha" })

  /* ---- Permissions are channel composition ------------------------------ */
  const open1 = await post(`/api/communities/${alpha}/channels`, teacher.token, { name: "questions", visibility: "public" })
  const secret = await post(`/api/communities/${alpha}/channels`, teacher.token, { name: "teachers", visibility: "private" })
  const denied = await call("POST", `/api/communities/${alpha}/channels`, student.token, { name: "student channel", visibility: "public" })
  check(denied.status === 403, "only a teacher creates channels")

  await post(`/api/communities/${alpha}/channels/${open1.id}/join`, student.token, {})
  const studentChannels = await get(`/api/communities/${alpha}/channels`, student.token) as unknown as Json[]
  check(Array.isArray(studentChannels) && studentChannels.some((item) => item.id === open1.id), "a public channel is visible once joined")
  check(!(studentChannels as Json[]).some((item) => item.id === secret.id), "a private channel a member never joined does not exist for them")
  const peek = await call("GET", `/api/communities/${alpha}/channels/${secret.id}/messages`, student.token)
  check(peek.status === 404, "reading a private channel reports not-found, never forbidden")

  /* ---- Agents and the runner -------------------------------------------- */
  const created = await post(`/api/communities/${alpha}/agents`, teacher.token, {
    name: "Ada", instructions: "Answer from the cards", runtime: "claude", model: "test", channelIds: [open1.id],
  })
  const agentId = created.agent.id as string
  check(typeof created.enrollment.runnerToken === "string" && created.enrollment.setupCommand.includes(created.enrollment.runnerToken), "agent creation returns a one-time runner token and its setup command")

  const agentsForStudent = await get(`/api/communities/${alpha}/agents`, student.token) as unknown as Json[]
  check(!JSON.stringify(agentsForStudent).includes(created.enrollment.runnerToken), "a runner token never appears in an ordinary projection")

  /* A mention matches on the complete name, so a second "Ada" would wake both. */
  const duplicate = await call("POST", `/api/communities/${alpha}/agents`, teacher.token, { name: "Ada", runtime: "claude", channelIds: [] })
  check(duplicate.status === 409, "a second agent cannot take a name already used in the community")
  const cased = await call("POST", `/api/communities/${alpha}/agents`, teacher.token, { name: "  aDa ", runtime: "claude", channelIds: [] })
  check(cased.status === 409, "the name check is case-insensitive and ignores padding, exactly like mention matching")
  const otherName = await call("POST", `/api/communities/${alpha}/agents`, teacher.token, { name: "Turing", runtime: "codex", channelIds: [] })
  check(otherName.status === 201, "a different name is still allowed")
  const elsewhere = await call("POST", `/api/communities/${beta}/agents`, student.token, { name: "Ada", runtime: "claude", channelIds: [] })
  check(elsewhere.status === 201, "the name is only reserved inside its own community")

  /* Renaming carries the same rule as creating, and drags the DM title with it. */
  const dmBefore = await post(`/api/communities/${alpha}/dms`, student.token, { agentId })
  const renameClash = await call("PATCH", `/api/communities/${alpha}/agents/${agentId}`, teacher.token, { name: "turing" })
  check(renameClash.status === 409, "an agent cannot be renamed onto a name another agent already holds")
  const renameByStudent = await call("PATCH", `/api/communities/${alpha}/agents/${agentId}`, student.token, { name: "Whatever" })
  check(renameByStudent.status === 403, "only a teacher can rename an agent")
  const recased = await call("PATCH", `/api/communities/${alpha}/agents/${agentId}`, teacher.token, { name: "ADA" })
  check(recased.status === 200 && recased.body.name === "ADA", "an agent can change its own capitalisation without colliding with itself")
  const renamed = await call("PATCH", `/api/communities/${alpha}/agents/${agentId}`, teacher.token, { name: "Ada" })
  check(renamed.status === 200 && renamed.body.name === "Ada", "a teacher can rename an agent")
  const dmAfter = (await get(`/api/communities/${alpha}/channels`, student.token) as unknown as Json[]).find((item) => item.id === dmBefore.id)
  check(dmAfter?.name === "Ada", "renaming an agent retitles the private conversations that carry its name")
  const freed = await call("POST", `/api/communities/${alpha}/agents`, teacher.token, { name: "ADA", runtime: "claude", channelIds: [] })
  check(freed.status === 409, "the new name is reserved immediately, case-insensitively")

  const runner = await open(`${wsBase}/ws/runner`, { type: "auth", token: created.enrollment.runnerToken })
  check(runner.frames[0].agent.id === agentId, "a runner authenticates in its first frame and is bound to its agent")

  await new Promise((resolve) => setTimeout(resolve, 50))
  const workspace = await get(`/api/communities/${alpha}`, teacher.token)
  check(workspaceSchema.safeParse(workspace).success, "the workspace snapshot satisfies the shared contract")
  check((workspace.agents as Json[]).find((item) => item.id === agentId)?.presence === "online", "runner presence is authoritative in the snapshot")

  const browser = await open(`${wsBase}/ws`, { type: "auth", token: student.token, communityId: alpha })
  /* `outsider` belongs to no community yet, so this is a real refusal rather
     than a lookup that happens to succeed. The timeout matters: without it a
     socket that is never closed would hang the check instead of failing it. */
  const rejected = await new Promise<number>((resolve) => {
    const socket = new WebSocket(`${wsBase}/ws`)
    const timer = setTimeout(() => { socket.terminate(); resolve(-1) }, 3_000)
    socket.on("open", () => socket.send(JSON.stringify({ type: "auth", token: outsider.token, communityId: beta })))
    socket.on("close", (code) => { clearTimeout(timer); resolve(code) })
  })
  check(rejected === 4401, `a socket cannot bind to a community the user is not in (closed ${rejected})`)

  /* ---- A mention reaches the runner, not a model in the server ----------- */
  await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "@Adaptive is a different word" }]] })
  await new Promise((resolve) => setTimeout(resolve, 60))
  check(!runner.frames.some((frame) => frame.type === "work"), "a mention must match the agent's complete name")

  const asked = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "@Ada what is backprop?" }]] })
  const work = await waitFor(runner.frames, (frame) => frame.type === "work", "work")
  check(work.payload.message.id === asked.id && work.payload.from.userId === student.user.id, "work identifies the question and its author")
  check(Array.isArray(work.payload.context), "work carries the immediate memory layer")

  const wrongScope = await send(runner.socket, runner.frames, {
    type: "message.create", ref: "wrong-scope",
    payload: { communityId: beta, agentId, channelId: open1.id, paragraphs: [[{ kind: "text", text: "no" }]] },
  }, "wrong-scope")
  check(wrongScope.ok === false, "a runner writing outside its bound community is rejected")

  /* ---- Cards, and the seal ---------------------------------------------- */
  const cardOne = await send(runner.socket, runner.frames, {
    type: "card.publish", ref: "card-one",
    payload: { communityId: alpha, agentId, channelId: open1.id, path: "modules/03-backprop/chain-rule.md", title: "The chain rule", type: "topic", body: "compiled once", sourceMessageIds: [asked.id] },
  }, "card-one")
  const cardTwo = await send(runner.socket, runner.frames, {
    type: "card.publish", ref: "card-two",
    payload: { communityId: alpha, agentId, channelId: open1.id, path: "modules/03-backprop/gradients.md", title: "Gradients", type: "topic", body: "compiled once", sourceMessageIds: [] },
  }, "card-two")
  check(cardOne.ok === true && cardTwo.ok === true, "an agent publishes cards through a correlated acknowledgement")

  /* The seal is dated from the card rows, so let real time pass. */
  await new Promise((resolve) => setTimeout(resolve, 1_100))

  const plain = await send(runner.socket, runner.frames, {
    type: "message.create", ref: "plain",
    payload: { communityId: alpha, agentId, channelId: open1.id, paragraphs: [[{ kind: "text", text: "read the sources for this one" }]] },
  }, "plain")
  const sealed = await send(runner.socket, runner.frames, {
    type: "message.create", ref: "sealed",
    payload: {
      communityId: alpha, agentId, channelId: open1.id,
      paragraphs: [[{ kind: "text", text: "Backprop is the chain rule applied backwards" }, { kind: "cite", text: "The chain rule", cite: { cardId: cardOne.cardId } }]],
      fromFile: { cardIds: [cardOne.cardId, cardTwo.cardId] },
    },
  }, "sealed")
  const partial = await send(runner.socket, runner.frames, {
    type: "message.create", ref: "partial",
    payload: { communityId: alpha, agentId, channelId: open1.id, paragraphs: [[{ kind: "text", text: "half" }]], fromFile: { cardIds: [cardOne.cardId, "card-gone", cardOne.cardId] } },
  }, "partial")

  const messages = await get(`/api/communities/${alpha}/channels/${open1.id}/messages`, teacher.token) as unknown as Json[]
  const byId = (id: string) => (messages as Json[]).find((item) => item.id === id)
  check(byId(plain.messageId)?.fromFile === undefined, "an answer built from the sources carries no seal")

  const sealedMessage = byId(sealed.messageId)!
  check(sealedMessage.fromFile.cardIds.length === 2, "the seal is plural: every card composed from travels, not only the first")
  check(Number.isInteger(sealedMessage.fromFile.oldestAgo) && sealedMessage.fromFile.oldestAgo >= 1, `oldestAgo is derived from the server's card rows (got ${sealedMessage.fromFile.oldestAgo})`)
  check(messageSchema.safeParse(sealedMessage).success, "a sealed message satisfies the shared contract")
  check(byId(partial.messageId)!.fromFile.cardIds.length === 1, "an unresolvable card id is dropped from the seal and repeats collapse, but the answer still posts")

  const event = await waitFor(browser.frames, (frame) => frame.type === "event" && frame.event?.payload?.message?.id === sealed.messageId, "the sealed message event")
  check(event.event.payload.message.fromFile.cardIds.length === 2, "the seal travels on the live event, not only on a re-read")

  /* ---- Threads ----------------------------------------------------------- */
  const root = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "why does the sign flip here?" }]] })
  const orphan = await call("POST", `/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "reply" }]], threadId: "thread-nope" })
  check(orphan.status === 404, "a message cannot be posted into a thread that does not exist")

  const thread = await post(`/api/communities/${alpha}/threads`, teacher.token, { rootMessageId: root.id })
  const sameThread = await post(`/api/communities/${alpha}/threads`, student.token, { rootMessageId: root.id })
  check(thread.id === sameThread.id, "starting a thread twice on one message returns the same thread rather than racing")
  check(thread.channelId === open1.id, "a thread takes its channel from the message it hangs off")

  const reply = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "because the gradient is subtracted" }]], threadId: thread.id })
  check(reply.threadId === thread.id, "a reply is posted into the thread")
  const nested = await call("POST", `/api/communities/${alpha}/threads`, teacher.token, { rootMessageId: reply.id })
  check(nested.status === 409, "a reply cannot itself start a thread: threads do not nest")

  const threadList = await get(`/api/communities/${alpha}/channels/${open1.id}/threads`, teacher.token) as unknown as Json[]
  check((threadList as Json[]).some((item) => item.id === thread.id), "threads in a channel can be listed")
  const outsiderThreads = await call("GET", `/api/communities/${alpha}/channels/${secret.id}/threads`, student.token)
  check(outsiderThreads.status === 404, "threads follow the channel's own read rule")

  const threadEvent = await waitFor(browser.frames, (frame) => frame.type === "event" && frame.event?.type === "thread.created" && frame.event.payload.thread.id === thread.id, "the thread.created event")
  check(!!threadEvent, "starting a thread reaches the other people in the channel live")

  /* An agent answering inside a thread stays in it rather than the channel. */
  const threadAnswer = await send(runner.socket, runner.frames, {
    type: "message.create", ref: "in-thread",
    payload: { communityId: alpha, agentId, channelId: open1.id, threadId: thread.id, paragraphs: [[{ kind: "text", text: "the sign flips because we descend" }]] },
  }, "in-thread")
  const inChannel = await get(`/api/communities/${alpha}/channels/${open1.id}/messages`, teacher.token) as unknown as Json[]
  const placed = (inChannel as Json[]).find((item) => item.id === threadAnswer.messageId)
  check(placed?.threadId === thread.id, "an agent answering inside a thread stays in that thread")

  /* ---- Editing ----------------------------------------------------------- */
  const mine = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "i think the sign is wrong" }]] })
  const byTeacher = await call("PATCH", `/api/communities/${alpha}/messages/${mine.id}`, teacher.token, { paragraphs: [[{ kind: "text", text: "the student agrees with me" }]] })
  check(byTeacher.status === 403, "a teacher can moderate but cannot put words in someone's mouth")

  const edited = await call("PATCH", `/api/communities/${alpha}/messages/${mine.id}`, student.token, { paragraphs: [[{ kind: "text", text: "i think the sign is right, actually" }]] })
  check(edited.status === 200 && edited.body.paragraphs[0][0].text === "i think the sign is right, actually", "the author can edit their own message")
  check(typeof edited.body.editedAt === "string" && edited.body.editedAt >= edited.body.at, "an edited message is marked as edited")

  const editEvent = await waitFor(browser.frames, (frame) => frame.type === "event" && frame.event?.type === "message.updated" && frame.event.payload.message.id === mine.id, "the message.updated event")
  check(editEvent.event.payload.message.paragraphs[0][0].text.includes("actually"), "an edit reaches the channel live")

  /* Editing a reply must not knock it out of its thread. */
  const threadReply = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "first go" }]], threadId: thread.id })
  const editedReply = await call("PATCH", `/api/communities/${alpha}/messages/${threadReply.id}`, student.token, { paragraphs: [[{ kind: "text", text: "second go" }]] })
  check(editedReply.body.threadId === thread.id, "editing a reply keeps it in its thread")

  const removed = await call("DELETE", `/api/communities/${alpha}/messages/${mine.id}`, student.token, undefined)
  check(removed.status === 200, "the author can delete their own message")
  check(removed.body.deletedBy === student.user.id, "and the tombstone records who removed it")

  /* A teacher removing someone else's message is moderation, and a tombstone
     that did not say so would make it invisible. */
  const theirs = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "something a teacher removes" }]] })
  const moderated = await call("DELETE", `/api/communities/${alpha}/messages/${theirs.id}`, teacher.token, undefined)
  check(moderated.body.deletedBy === teacher.user.id && moderated.body.authorId === student.user.id, "a teacher's removal names the teacher, not the author")
  const moderationEvent = await waitFor(browser.frames, (frame) => frame.type === "event" && frame.event?.type === "message.deleted" && frame.event.payload.messageId === theirs.id, "the deletion event")
  check(moderationEvent.event.payload.deletedBy === teacher.user.id, "and the live event carries it too")
  const rereadTombstone = (await get(`/api/communities/${alpha}/channels/${open1.id}/messages`, teacher.token) as unknown as Json[]).find((item) => item.id === theirs.id)
  check(rereadTombstone?.deletedBy === teacher.user.id, "and it survives a re-read")
  check(!JSON.stringify(rereadTombstone).includes("something a teacher removes"), "while the content itself is still gone")
  const editDeleted = await call("PATCH", `/api/communities/${alpha}/messages/${mine.id}`, student.token, { paragraphs: [[{ kind: "text", text: "back from the dead" }]] })
  check(editDeleted.status === 409, "a deleted message cannot be edited back into existence")

  /* ---- Typing (ported from the old repo) --------------------------------- */
  /* A second person's live socket, used here and by the unread checks below. */
  const teacherSocket = await open(`${wsBase}/ws`, { type: "auth", token: teacher.token, communityId: alpha })

  const typingEvents = () => teacherSocket.frames.filter((frame) => frame.type === "event" && frame.event?.type === "typing.updated" && frame.event.payload.channelId === open1.id)
  const beforeTyping = typingEvents().length

  browser.socket.send(JSON.stringify({ type: "typing.set", payload: { channelId: open1.id, typing: true } }))
  const startedTyping = await waitFor(teacherSocket.frames, (frame) => frame.type === "event" && frame.event?.type === "typing.updated" && frame.event.payload.typing === true, "typing to start")
  check(startedTyping.event.payload.userId === student.user.id, "typing reaches the other people in the channel")
  const echoed = await waitFor(browser.frames, (frame) => frame.type === "event" && frame.event?.type === "typing.updated" && frame.event.payload.typing === true, "the typist's own echo")
  check(!!echoed, "and back to the typist too, as the old repo's broadcast did")

  /* Repeats inside the throttle window collapse into the one already sent. */
  browser.socket.send(JSON.stringify({ type: "typing.set", payload: { channelId: open1.id, typing: true } }))
  browser.socket.send(JSON.stringify({ type: "typing.set", payload: { channelId: open1.id, typing: true } }))
  await new Promise((resolve) => setTimeout(resolve, 150))
  check(typingEvents().length === beforeTyping + 1, "repeated keystrokes do not repeat the announcement")

  browser.socket.send(JSON.stringify({ type: "typing.set", payload: { channelId: open1.id, typing: false } }))
  await waitFor(teacherSocket.frames, (frame) => frame.type === "event" && frame.event?.type === "typing.updated" && frame.event.payload.typing === false, "typing to stop")
  check(true, "stopping is announced too")

  /* Silence must end it: a dropped keystroke cannot leave someone typing. */
  const beforeExpiry = typingEvents().length
  browser.socket.send(JSON.stringify({ type: "typing.set", payload: { channelId: open1.id, typing: true } }))
  await new Promise((resolve) => setTimeout(resolve, 4_600))
  const expired = typingEvents().slice(beforeExpiry)
  check(expired.some((frame) => frame.event.payload.typing === false), "typing expires on its own after a few seconds of silence")

  /* Standing to type is the standing to post. */
  const lurker = await post("/api/users", undefined, { displayName: "Lurker" })
  await post("/api/invites/redeem", lurker.token, { code: invite.code })
  const lurkerSocket = await open(`${wsBase}/ws`, { type: "auth", token: lurker.token, communityId: alpha })
  const beforeLurker = typingEvents().length
  lurkerSocket.socket.send(JSON.stringify({ type: "typing.set", payload: { channelId: open1.id, typing: true } }))
  await new Promise((resolve) => setTimeout(resolve, 250))
  check(typingEvents().length === beforeLurker, "someone who has not joined the channel cannot appear to be typing in it")
  lurkerSocket.socket.close()

  /* A closing tab stops typing rather than leaving it hanging. */
  const secondTab = await open(`${wsBase}/ws`, { type: "auth", token: student.token, communityId: alpha })
  secondTab.socket.send(JSON.stringify({ type: "typing.set", payload: { channelId: open1.id, typing: true } }))
  await waitFor(teacherSocket.frames, (frame) => frame.type === "event" && frame.event?.type === "typing.updated" && frame.event.payload.typing === true, "the second tab to start typing")
  const beforeClose = typingEvents().length
  secondTab.socket.close()
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(typingEvents().slice(beforeClose).some((frame) => frame.event.payload.typing === false), "closing a tab stops its typing")

  /* ---- Attachments (ported from the old repo) ---------------------------- */
  const upload = async (token: string, channelId: string, name: string, contents: string, mime = "text/plain") => {
    const form = new FormData()
    form.append("file", new File([contents], name, { type: mime }))
    const response = await fetch(`${base}/api/communities/${alpha}/channels/${channelId}/attachments`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
    })
    return { status: response.status, body: JSON.parse(await response.text()) as Json }
  }

  const file = await upload(student.token, open1.id, "notes.txt", "the chain rule, by hand")
  check(file.status === 201 && file.body.size === 23, "a file can be uploaded to a channel you belong to")
  check(!("storagePath" in file.body) && !("uploaderId" in file.body), "the upload response describes the file without exposing where it is stored")

  const strangerUpload = await upload(outsider.token, open1.id, "x.txt", "no")
  check(strangerUpload.status === 404, "someone who cannot read the channel cannot upload to it")

  /* An uploaded file is unattached until a message claims it. */
  const withFile = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, {
    paragraphs: [[{ kind: "text", text: "here are my workings" }]], attachmentIds: [file.body.id],
  })
  check(withFile.attachments?.length === 1 && withFile.attachments[0].name === "notes.txt", "a message carries the file it posted")
  const reread = await get(`/api/communities/${alpha}/channels/${open1.id}/messages`, teacher.token) as unknown as Json[]
  check((reread as Json[]).find((item) => item.id === withFile.id)?.attachments?.length === 1, "and still carries it on a plain read")

  const postedTwice = await call("POST", `/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, {
    paragraphs: [[{ kind: "text", text: "again" }]], attachmentIds: [file.body.id],
  })
  check(postedTwice.status === 409, "a file can only be posted once")

  const downloaded = await fetch(`${base}/api/communities/${alpha}/attachments/${file.body.id}`, { headers: { authorization: `Bearer ${teacher.token}` } })
  check(downloaded.status === 200 && await downloaded.text() === "the chain rule, by hand", "the exact bytes come back")
  const disposition = downloaded.headers.get("content-disposition") ?? ""
  check(disposition.startsWith("attachment;") && disposition.includes("notes.txt"), "a download is always an attachment, never rendered on this origin")

  const forbidden = await fetch(`${base}/api/communities/${alpha}/attachments/${file.body.id}`, { headers: { authorization: `Bearer ${outsider.token}` } })
  check(forbidden.status === 404, "a file inherits its channel's read rule rather than being a guessable id")

  const removePosted = await call("DELETE", `/api/communities/${alpha}/attachments/${file.body.id}`, student.token, undefined)
  check(removePosted.status === 409, "a file that has been posted cannot be removed on its own")

  const spareFile = await upload(student.token, open1.id, "draft.txt", "scratch")
  const removeBySomeoneElse = await call("DELETE", `/api/communities/${alpha}/attachments/${spareFile.body.id}`, outsider.token, undefined)
  check(removeBySomeoneElse.status === 404 || removeBySomeoneElse.status === 403, "someone else cannot remove your unposted file")
  const removedFile = await call("DELETE", `/api/communities/${alpha}/attachments/${spareFile.body.id}`, student.token, undefined)
  check(removedFile.status === 200, "an unposted file can be removed by its uploader")
  const goneFile = await fetch(`${base}/api/communities/${alpha}/attachments/${spareFile.body.id}`, { headers: { authorization: `Bearer ${student.token}` } })
  check(goneFile.status === 404, "and its bytes go with it")

  /* A name from a browser must never address a file outside the store. */
  const traversal = await upload(student.token, open1.id, "../../escape.txt", "nope")
  check(traversal.status === 201, "a hostile file name is accepted")
  const traversalRead = await fetch(`${base}/api/communities/${alpha}/attachments/${traversal.body.id}`, { headers: { authorization: `Bearer ${student.token}` } })
  check(await traversalRead.text() === "nope", "and stored somewhere safe, addressed only by its id")
  check(!existsSync(join(scratch, "escape.txt")) && !existsSync(join(scratch, "..", "escape.txt")), "the traversal did not escape the file store")

  const foreignFetch = await call("GET", `/api/communities/${beta}/attachments/${file.body.id}`, teacher.token)
  check(foreignFetch.status === 404, "a file cannot be fetched through another community")

  /* ---- Unread (ported from the old repo) --------------------------------- */
  const unreadChannel = await post(`/api/communities/${alpha}/channels`, teacher.token, { name: "notices", visibility: "public" })
  await post(`/api/communities/${alpha}/channels/${unreadChannel.id}/join`, student.token, {})
  const freshList = await get(`/api/communities/${alpha}/channels`, student.token) as unknown as Json[]
  check((freshList as Json[]).find((item) => item.id === unreadChannel.id)?.unread === false, "a channel nobody has posted in is not unread")

  const own = await post(`/api/communities/${alpha}/channels/${unreadChannel.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "mine" }]] })
  const afterOwn = await get(`/api/communities/${alpha}/channels`, student.token) as unknown as Json[]
  check((afterOwn as Json[]).find((item) => item.id === unreadChannel.id)?.unread === false, "your own message never makes a channel look unread to you")

  await post(`/api/communities/${alpha}/channels/${unreadChannel.id}/messages`, teacher.token, { paragraphs: [[{ kind: "text", text: "please read this" }]] })
  const afterOther = await get(`/api/communities/${alpha}/channels`, student.token) as unknown as Json[]
  check((afterOther as Json[]).find((item) => item.id === unreadChannel.id)?.unread === true, "someone else's message marks the channel unread")
  const teacherSide = await get(`/api/communities/${alpha}/channels`, teacher.token) as unknown as Json[]
  check((teacherSide as Json[]).find((item) => item.id === unreadChannel.id)?.unread === true, "unread is per person: the student's message is unread for the teacher")

  const marked = await post(`/api/communities/${alpha}/channels/${unreadChannel.id}/read`, student.token, { lastReadAt: new Date().toISOString() })
  check(marked.unread === false, "marking read clears it")
  const afterRead = await get(`/api/communities/${alpha}/channels`, student.token) as unknown as Json[]
  check((afterRead as Json[]).find((item) => item.id === unreadChannel.id)?.unread === false, "and it stays cleared on the next read")

  const readEvent = await waitFor(browser.frames, (frame) => frame.type === "event" && frame.event?.type === "channel.read" && frame.event.payload.channelId === unreadChannel.id, "the channel.read event")
  check(readEvent.event.payload.userId === student.user.id, "the read marker reaches the reader's own other sessions")
  const seenByOthers = await waitFor(teacherSocket.frames, (frame) => frame.type === "event" && frame.event?.type === "channel.read" && frame.event.payload.userId === student.user.id, "the read marker on another person's socket")
  check(!!seenByOthers, "and is broadcast to the community, as the old repo did")

  const stale = await call("POST", `/api/communities/${alpha}/channels/${unreadChannel.id}/read`, student.token, { lastReadAt: "yesterday" })
  check(stale.status === 400, "a read marker must be a real timestamp")
  const notMine = await call("POST", `/api/communities/${alpha}/channels/${secret.id}/read`, student.token, { lastReadAt: new Date().toISOString() })
  check(notMine.status === 404, "you cannot mark a channel read that you cannot read")

  await post(`/api/communities/${alpha}/channels/${unreadChannel.id}/messages`, teacher.token, { paragraphs: [[{ kind: "text", text: "and this" }]] })
  const removedAgain = await call("DELETE", `/api/communities/${alpha}/messages/${own.id}`, student.token, undefined)
  check(removedAgain.status === 200, "a message can be deleted for the deletion case below")
  const afterMore = await get(`/api/communities/${alpha}/channels`, student.token) as unknown as Json[]
  check((afterMore as Json[]).find((item) => item.id === unreadChannel.id)?.unread === true, "a later message from someone else makes it unread again")

  /* ---- Agent lifecycle (ported from the old repo) ------------------------ */
  const editable = await post(`/api/communities/${alpha}/agents`, teacher.token, { name: "Hopper", instructions: "First draft", runtime: "claude", model: "default", channelIds: [] })
  const editableId = editable.agent.id as string
  const agentEdited = await call("PATCH", `/api/communities/${alpha}/agents/${editableId}`, teacher.token, { instructions: "Answer from the cards only", model: "test" })
  check(agentEdited.status === 200 && agentEdited.body.instructions === "Answer from the cards only" && agentEdited.body.model === "test", "a teacher can change what an agent was told to do")

  const assigned = await call("PATCH", `/api/communities/${alpha}/agents/${editableId}`, teacher.token, { channelIds: [open1.id] })
  check(assigned.body.channelIds.length === 1 && assigned.body.channelIds[0] === open1.id, "channelIds replaces the assignment set")
  const reassigned = await call("PATCH", `/api/communities/${alpha}/agents/${editableId}`, teacher.token, { channelIds: [] })
  check(reassigned.body.channelIds.length === 0, "an empty channelIds removes every assignment rather than being ignored")

  const fetched = await get(`/api/communities/${alpha}/agents/${editableId}`, student.token)
  check(fetched.id === editableId && !JSON.stringify(fetched).includes("runner"), "an agent can be read on its own, without its runner credential")
  const editByStudent = await call("PATCH", `/api/communities/${alpha}/agents/${editableId}`, student.token, { instructions: "do my homework" })
  check(editByStudent.status === 403, "a student cannot rewrite an agent's instructions")

  /* Deleting: the runner is revoked and the agent's DMs are archived, not lost. */
  const doomedAgent = await post(`/api/communities/${alpha}/agents`, teacher.token, { name: "Babbage", instructions: "", runtime: "claude", model: "default", channelIds: [open1.id] })
  const doomedAgentId = doomedAgent.agent.id as string
  const agentDm = await post(`/api/communities/${alpha}/dms`, student.token, { agentId: doomedAgentId })
  await post(`/api/communities/${alpha}/channels/${agentDm.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "a question I asked in private" }]] })
  const doomedRunner = await open(`${wsBase}/ws/runner`, { type: "auth", token: doomedAgent.enrollment.runnerToken })
  const runnerClosed = new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(-1), 4_000)
    doomedRunner.socket.on("close", (code) => { clearTimeout(timer); resolve(code) })
  })
  const removedAgent = await call("DELETE", `/api/communities/${alpha}/agents/${doomedAgentId}`, teacher.token, undefined)
  check(removedAgent.status === 200 && removedAgent.body.status === "deleted", "a teacher can delete an agent")
  check(await runnerClosed === 4403, "deleting an agent closes the runner socket it already had open")
  const revoked = await new Promise<number>((resolve) => {
    const socket = new WebSocket(`${wsBase}/ws/runner`)
    const timer = setTimeout(() => { socket.terminate(); resolve(-1) }, 3_000)
    socket.on("open", () => socket.send(JSON.stringify({ type: "auth", token: doomedAgent.enrollment.runnerToken })))
    socket.on("close", (code) => { clearTimeout(timer); resolve(code) })
    socket.on("error", () => resolve(-1))
  })
  check(revoked === 4401, "a deleted agent's runner token no longer authenticates")

  const agentsAfter = await get(`/api/communities/${alpha}/agents`, teacher.token) as unknown as Json[]
  check(!(agentsAfter as Json[]).some((item) => item.id === doomedAgentId), "a deleted agent is gone from the roster")
  const archivedDm = await get(`/api/communities/${alpha}/channels/${agentDm.id}/messages`, student.token) as unknown as Json[]
  check((archivedDm as Json[]).length === 1, "the private conversation survives the agent: its history is archived, not destroyed")
  const studentChannelList = await get(`/api/communities/${alpha}/channels`, student.token) as unknown as Json[]
  check(!(studentChannelList as Json[]).some((item) => item.id === agentDm.id), "the archived conversation leaves the sidebar")

  /* ---- Channel management ------------------------------------------------ */
  const spare = await post(`/api/communities/${alpha}/channels`, teacher.token, { name: "reading group", visibility: "public" })
  const browsable = await get(`/api/communities/${alpha}/channels/browse`, student.token) as unknown as Json[]
  const listed = (browsable as Json[]).find((item) => item.id === spare.id)
  check(!!listed, "a public channel the student has not joined shows up to browse")
  check(listed?.memberCount === 1 && !("visibility" in (listed ?? {})), "browsing shows a name and a count, not the channel's contents")
  check((browsable as Json[]).some((item) => item.id === open1.id), "the directory lists every active public channel, joined or not")
  check(!(browsable as Json[]).some((item) => item.id === secret.id), "a private channel is never in the directory")

  /* Joining is what makes a channel yours, and posting requires it. */
  const beforeJoin = await call("POST", `/api/communities/${alpha}/channels/${spare.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "hello?" }]] })
  check(beforeJoin.status === 403, "a public channel can be read without joining, but not posted to")
  const sidebarBefore = await get(`/api/communities/${alpha}/channels`, student.token) as unknown as Json[]
  const seenUnjoined = (sidebarBefore as Json[]).find((item) => item.id === spare.id)
  check(!!seenUnjoined, "a public channel is visible to every member without joining")
  check(seenUnjoined?.joined === false, "and is marked as one they have not joined, so the client can tell reading from writing apart")
  await post(`/api/communities/${alpha}/channels/${spare.id}/join`, student.token, {})
  const afterJoin = await call("POST", `/api/communities/${alpha}/channels/${spare.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "hello" }]] })
  check(afterJoin.status === 201, "joining is what lets you post")
  const nowJoined = (await get(`/api/communities/${alpha}/channels`, student.token) as unknown as Json[]).find((item) => item.id === spare.id)
  check(nowJoined?.joined === true, "and the channel now reports them as a member")

  const channelRenamed = await call("PATCH", `/api/communities/${alpha}/channels/${spare.id}`, teacher.token, { name: "reading circle" })
  check(channelRenamed.status === 200 && channelRenamed.body.name === "reading circle", "a teacher can rename a channel")
  const channelRenameByStudent = await call("PATCH", `/api/communities/${alpha}/channels/${spare.id}`, student.token, { name: "mine now" })
  check(channelRenameByStudent.status === 403, "a student cannot rename a channel")
  const channelEvent = await waitFor(browser.frames, (frame) => frame.type === "event" && frame.event?.type === "channel.updated" && frame.event.payload.channel.id === spare.id, "the channel.updated event")
  check(channelEvent.event.payload.channel.name === "reading circle", "a rename reaches the channel's members live")

  const channelLeft = await call("DELETE", `/api/communities/${alpha}/channels/${spare.id}/leave`, student.token, undefined)
  check(channelLeft.status === 200, "a member can leave a channel")
  const leaveTwice = await call("DELETE", `/api/communities/${alpha}/channels/${spare.id}/leave`, student.token, undefined)
  check(leaveTwice.status === 409, "leaving a channel you are not in says so")
  const backToBrowse = await get(`/api/communities/${alpha}/channels/browse`, student.token) as unknown as Json[]
  check((backToBrowse as Json[]).some((item) => item.id === spare.id), "a channel you left is offered to browse again")

  /* A DM is between a person and an agent: not a channel to rename or leave. */
  const dmForRules = await post(`/api/communities/${alpha}/dms`, student.token, { agentId })
  const renameDm = await call("PATCH", `/api/communities/${alpha}/channels/${dmForRules.id}`, teacher.token, { name: "not allowed" })
  check(renameDm.status === 409, "a private conversation cannot be renamed or opened up")
  const leaveDm = await call("DELETE", `/api/communities/${alpha}/channels/${dmForRules.id}/leave`, student.token, undefined)
  check(leaveDm.status === 409, "a private conversation cannot be left")

  /* Deleting is refused while the channel still holds compiled knowledge. */
  const withHistory = await call("DELETE", `/api/communities/${alpha}/channels/${open1.id}`, teacher.token, undefined)
  check(withHistory.status === 409, "a channel with history cannot be deleted; it has to be archived instead")
  const empty = await post(`/api/communities/${alpha}/channels`, teacher.token, { name: "nothing here", visibility: "public" })
  const deleted = await call("DELETE", `/api/communities/${alpha}/channels/${empty.id}`, teacher.token, undefined)
  check(deleted.status === 200, "an empty channel can be deleted")
  const goneEvent = await waitFor(browser.frames, (frame) => frame.type === "event" && frame.event?.type === "channel.deleted" && frame.event.payload.channelId === empty.id, "the channel.deleted event")
  check(!!goneEvent, "the deletion reaches the community live")
  const gone = await call("GET", `/api/communities/${alpha}/channels/${empty.id}/messages`, teacher.token)
  check(gone.status === 404, "the deleted channel is gone")

  /* ---- Idempotent sends (ported from the old repo) ------------------------ */
  const once = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, {
    paragraphs: [[{ kind: "text", text: "sent once" }]], clientId: "compose-42",
  })
  const retried = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, {
    paragraphs: [[{ kind: "text", text: "sent once" }]], clientId: "compose-42",
  })
  check(retried.id === once.id, "a resend with the same client id returns the message that already exists")
  check(retried.clientId === "compose-42", "and the client id comes back so a sender can match its own send")
  const sameIdOtherPerson = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, teacher.token, {
    paragraphs: [[{ kind: "text", text: "mine" }]], clientId: "compose-42",
  })
  check(sameIdOtherPerson.id !== once.id, "a client id is scoped to its author, not shared across the community")

  const withFileOnce = await upload(student.token, open1.id, "retry.txt", "attached")
  const firstSend = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, {
    paragraphs: [[{ kind: "text", text: "with a file" }]], clientId: "compose-43", attachmentIds: [withFileOnce.body.id],
  })
  const again = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, {
    paragraphs: [[{ kind: "text", text: "with a file" }]], clientId: "compose-43", attachmentIds: [withFileOnce.body.id],
  })
  check(again.id === firstSend.id && again.attachments?.length === 1, "a retry carrying the same file returns the original rather than failing as a double post")

  /* ---- Archiving (ported from the old repo) ------------------------------- */
  const archivable = await post(`/api/communities/${alpha}/channels`, teacher.token, { name: "last term", visibility: "public" })
  await post(`/api/communities/${alpha}/channels/${archivable.id}/join`, student.token, {})
  await post(`/api/communities/${alpha}/channels/${archivable.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "something worth keeping" }]] })

  const cannotDelete = await call("DELETE", `/api/communities/${alpha}/channels/${archivable.id}`, teacher.token, undefined)
  check(cannotDelete.status === 409, "a channel with history cannot be deleted")
  const archived = await call("PATCH", `/api/communities/${alpha}/channels/${archivable.id}`, teacher.token, { archived: true })
  check(archived.status === 200 && typeof archived.body.archivedAt === "string", "but it can be archived, which is what the refusal tells you to do")

  const listAfter = await get(`/api/communities/${alpha}/channels`, student.token) as unknown as Json[]
  check(!(listAfter as Json[]).some((item) => item.id === archivable.id), "an archived channel leaves the channel list")
  const withArchived = await get(`/api/communities/${alpha}/channels?archived=1`, teacher.token) as unknown as Json[]
  check((withArchived as Json[]).some((item) => item.id === archivable.id), "and can still be found, so archiving is not a one-way door")

  const stillReadable = await get(`/api/communities/${alpha}/channels/${archivable.id}/messages`, student.token) as unknown as Json[]
  check((stillReadable as Json[]).length === 1, "everything said in it is still readable: an archive keeps the record")
  const postToArchived = await call("POST", `/api/communities/${alpha}/channels/${archivable.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "one more" }]] })
  check(postToArchived.status === 409, "but nothing more can be added to it")
  const joinArchived = await call("POST", `/api/communities/${alpha}/channels/${archivable.id}/join`, teacher.token, {})
  check(joinArchived.status === 409, "and it stops accepting members")
  const archiveEvent = await waitFor(teacherSocket.frames, (frame) => frame.type === "event" && frame.event?.type === "channel.archived" && frame.event.payload.channel.id === archivable.id, "the channel.archived event")
  check(!!archiveEvent, "archiving reaches the community live")

  const restored = await call("PATCH", `/api/communities/${alpha}/channels/${archivable.id}`, teacher.token, { archived: false })
  check(restored.status === 200 && restored.body.archivedAt === undefined, "un-archiving brings it back")
  const postAgain = await call("POST", `/api/communities/${alpha}/channels/${archivable.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "back in use" }]] })
  check(postAgain.status === 201, "and it accepts messages again")

  /* ---- Reactions --------------------------------------------------------- */
  const reactable = await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "that finally clicked" }]] })
  const first = await post(`/api/communities/${alpha}/messages/${reactable.id}/reactions`, student.token, { emoji: "👍" })
  check(first.reactions[0].userIds.length === 1, "a reaction is recorded")
  const twice = await post(`/api/communities/${alpha}/messages/${reactable.id}/reactions`, student.token, { emoji: "👍" })
  check(twice.reactions[0].userIds.length === 1, "reacting twice with the same emoji is one reaction, not two")
  const joined = await post(`/api/communities/${alpha}/messages/${reactable.id}/reactions`, teacher.token, { emoji: "👍" })
  check(joined.reactions[0].userIds.length === 2, "a second person adds to the same tally")
  const second = await post(`/api/communities/${alpha}/messages/${reactable.id}/reactions`, teacher.token, { emoji: "✅" })
  check(second.reactions.length === 2, "a different emoji is a separate tally")

  const blank = await call("POST", `/api/communities/${alpha}/messages/${reactable.id}/reactions`, student.token, { emoji: "  " })
  check(blank.status === 400, "an invisible reaction is refused: a tally must have a subject")

  const reactEvent = await waitFor(browser.frames, (frame) => frame.type === "event" && frame.event?.type === "message.reacted" && frame.event.payload.messageId === reactable.id, "the message.reacted event")
  check(reactEvent.event.payload.reactions.length >= 1, "a reaction reaches the channel live")

  const withReactions = await get(`/api/communities/${alpha}/channels/${open1.id}/messages`, teacher.token) as unknown as Json[]
  const carried = (withReactions as Json[]).find((item) => item.id === reactable.id)
  check(carried?.reactions?.length === 2, "reactions travel with the message on a plain read")

  const undone = await call("DELETE", `/api/communities/${alpha}/messages/${reactable.id}/reactions/${encodeURIComponent("👍")}`, student.token, undefined)
  check(undone.body.reactions.find((item: Json) => item.emoji === "👍").userIds.length === 1, "removing a reaction removes only your own")
  const againUndone = await call("DELETE", `/api/communities/${alpha}/messages/${reactable.id}/reactions/${encodeURIComponent("👍")}`, student.token, undefined)
  check(againUndone.status === 200, "un-reacting something you never reacted to is a no-op, not an error")

  await call("DELETE", `/api/communities/${alpha}/messages/${reactable.id}`, student.token, undefined)
  const afterDelete = await get(`/api/communities/${alpha}/channels/${open1.id}/messages`, teacher.token) as unknown as Json[]
  check((afterDelete as Json[]).find((item) => item.id === reactable.id)?.reactions === undefined, "deleting a message clears its tallies: a count with no subject means nothing")
  const reactDeleted = await call("POST", `/api/communities/${alpha}/messages/${reactable.id}/reactions`, student.token, { emoji: "👍" })
  check(reactDeleted.status === 409, "a deleted message cannot be reacted to")

  /* ---- Members ----------------------------------------------------------- */
  const byStudent = await call("PATCH", `/api/communities/${alpha}/members/${teacher.user.id}`, student.token, { role: "student" })
  check(byStudent.status === 403, "a student cannot change anyone's role")
  const soleTeacher = await call("PATCH", `/api/communities/${alpha}/members/${teacher.user.id}`, teacher.token, { role: "student" })
  check(soleTeacher.status === 409, "the only teacher cannot demote themselves and strand the community")
  const soleLeave = await call("DELETE", `/api/communities/${alpha}/membership`, teacher.token, undefined)
  check(soleLeave.status === 409, "the only teacher cannot walk out either")

  const promoted = await call("PATCH", `/api/communities/${alpha}/members/${student.user.id}`, teacher.token, { role: "teacher" })
  check(promoted.status === 200 && promoted.body.role === "teacher", "a teacher can promote a student")
  const nowAllowed = await call("POST", `/api/communities/${alpha}/channels`, student.token, { name: "seminar", visibility: "public" })
  check(nowAllowed.status === 201, "the promotion is real: they can now do teacher-only things")
  const handedOver = await call("PATCH", `/api/communities/${alpha}/members/${teacher.user.id}`, teacher.token, { role: "student" })
  check(handedOver.status === 200, "with a second teacher in place, the first can step down")
  await call("PATCH", `/api/communities/${alpha}/members/${teacher.user.id}`, student.token, { role: "teacher" })

  /* Removal ends access and closes the socket that was already open. */
  const doomed = await post("/api/users", undefined, { displayName: "Passing through" })
  await post("/api/invites/redeem", doomed.token, { code: invite.code })
  const doomedSocket = await open(`${wsBase}/ws`, { type: "auth", token: doomed.token, communityId: alpha })
  const closed = new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(-1), 4_000)
    doomedSocket.socket.on("close", (code) => { clearTimeout(timer); resolve(code) })
  })
  const removal = await call("DELETE", `/api/communities/${alpha}/members/${doomed.user.id}`, teacher.token, undefined)
  check(removal.status === 200, "a teacher can remove a member")
  check(await closed === 4403, "removing a member closes the socket they already had open")
  const afterRemoval = await call("GET", `/api/communities/${alpha}`, doomed.token)
  check(afterRemoval.status === 403, "a removed member can no longer read the community")
  const stillThere = await get("/api/session", doomed.token)
  check(stillThere.user.displayName === "Passing through" && (stillThere.communities as Json[]).length === 0, "their global account survives: only the membership ended")

  /* Leaving is the same door from the inside. */
  const guest = await post("/api/users", undefined, { displayName: "Guest" })
  await post("/api/invites/redeem", guest.token, { code: invite.code })
  const left = await call("DELETE", `/api/communities/${alpha}/membership`, guest.token, undefined)
  check(left.status === 200, "a member can leave on their own")
  const afterLeaving = await call("GET", `/api/communities/${alpha}`, guest.token)
  check(afterLeaving.status === 403, "leaving ends access too")

  /* ---- A private conversation ------------------------------------------- */
  /* Asking privately must not cost more than asking in public: in a room with
     one agent, every message is for it. */
  const privateDm = await post(`/api/communities/${alpha}/dms`, student.token, { agentId })
  const beforePrivate = runner.frames.length
  await post(`/api/communities/${alpha}/channels/${privateDm.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "this is embarrassing but what is a derivative?" }]] })
  const privateWork = await waitFor(runner.frames, (frame) => frame.type === "work" && frame.payload.channelId === privateDm.id, "work from the private conversation")
  check(!!privateWork && runner.frames.length > beforePrivate, "an agent answers a private message without being named")
  await post(`/api/communities/${alpha}/channels/${open1.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "no agent is addressed here" }]] })
  await new Promise((resolve) => setTimeout(resolve, 200))
  check(!runner.frames.some((frame) => frame.type === "work" && frame.payload.message.paragraphs[0][0].text === "no agent is addressed here"), "but a shared channel still needs the agent's name")

  const dm = await post(`/api/communities/${alpha}/dms`, student.token, { agentId })
  const sameDm = await post(`/api/communities/${alpha}/dms`, student.token, { agentId })
  check(dm.id === sameDm.id, "opening a DM twice returns the same channel")
  await post(`/api/communities/${alpha}/channels/${dm.id}/messages`, student.token, { paragraphs: [[{ kind: "text", text: "I am embarrassed to ask this" }]] })
  const teacherSeesDm = await call("GET", `/api/communities/${alpha}/channels/${dm.id}/messages`, teacher.token)
  check(teacherSeesDm.status === 200, "the teacher who created the agent can read what it was asked")
  await post("/api/invites/redeem", outsider.token, { code: invite.code })
  const outsiderSeesDm = await call("GET", `/api/communities/${alpha}/channels/${dm.id}/messages`, outsider.token)
  check(outsiderSeesDm.status === 404, "another student in the same community cannot read that DM")

  browser.socket.close()
  teacherSocket.socket.close()
  runner.socket.close()

  /* A database written before the uniqueness rule can already hold duplicates.
     Booting against one must warn, not refuse to start. */
  const { openDatabase } = await import("../src/db.js")
  const legacyFile = join(scratch, "legacy.db")
  const seed = openDatabase(legacyFile)
  seed.exec("DROP INDEX IF EXISTS agents_name_per_community")
  seed.exec("INSERT INTO communities (id, name, created_at) VALUES ('c1', 'Legacy', '2026-01-01T00:00:00.000Z')")
  for (const id of ["a1", "a2"]) {
    seed.prepare("INSERT INTO agents (id, community_id, name, runtime, model, status, created_by, runner_token_digest, created_at) VALUES (?, 'c1', 'Ada', 'claude', 'default', 'active', 'u1', ?, '2026-01-01T00:00:00.000Z')").run(id, id)
  }
  seed.close()
  let booted = true
  try { openDatabase(legacyFile).close() } catch { booted = false }
  check(booted, "a database that already holds duplicate agent names still boots, with a warning instead of a crash")

  console.log(`\nElaine core OK: ${passed} checks`)
} finally {
  await running.close()
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* a temp dir is disposable */ }
}
