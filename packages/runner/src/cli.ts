/* elaine-runner — an agent's third part.

   An agent is identity + folder + runner. The server holds the identity and
   dispatches work; this process holds the folder and the provider login. It
   connects OUTBOUND, so nothing has to be exposed on the machine where the
   teacher's subscription lives, and it authenticates in its first frame.

   Mentions are handled ONE AT A TIME. Two runs at once would race on the same
   wiki/, and the diff of that folder is how a card gets published. */
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { WebSocket } from "ws"
import type { Agent, Block, Paragraphs, Presence } from "@elaine/protocol"
import { runnerServerFrameSchema, type RunnerWork } from "@elaine/protocol"
import { parseArgs, redact } from "./config.js"
import { runProvider } from "./providers.js"
import {
  type CardRef, ensureWorkspace, isPublishable, listWiki, loadCardMap, parseCard, safeWikiPath, saveCardMap,
} from "./workspace.js"

const config = parseArgs(process.argv.slice(2))
const secrets = [config.token]
const log = (...parts: unknown[]): void =>
  console.log(`[elaine-runner] ${redact(parts.map((part) => String(part)).join(" "), secrets)}`)

ensureWorkspace(config.cwd)
let cardMap = loadCardMap(config.cwd)

let socket: WebSocket | undefined
let agent: Agent | undefined
let closing = false
const pending = new Map<string, { resolve: (ack: Ack) => void; reject: (error: Error) => void }>()

type Ack = { ok: true; messageId?: string; cardId?: string }

/* ---- Transport --------------------------------------------------------- */

function send(frame: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
}

/* Every write is correlated by `ref`, so an acknowledgement can be matched to
   the request that caused it and a lost one cannot hang the queue forever. */
function request(type: "message.create" | "card.publish", payload: Record<string, unknown>): Promise<Ack> {
  const ref = randomUUID()
  return new Promise<Ack>((resolve, reject) => {
    pending.set(ref, { resolve, reject })
    send({ type, ref, payload })
    setTimeout(() => {
      if (pending.delete(ref)) reject(new Error(`no acknowledgement for ${type}`))
    }, 15_000)
  })
}

const presence = (value: Presence): void => send({ type: "presence", payload: { presence: value, runtime: config.runtime, ...(config.model !== "default" ? { model: config.model } : {}) } })

/* ---- Answers ------------------------------------------------------------ */

const CITE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

/* `[[path]]` becomes a real citation only when that path is a card the server
   already knows. An invented path degrades to plain text rather than becoming a
   citation to nothing — rule 2 must not be satisfiable by guessing. */
function inlineBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let last = 0
  for (const match of text.matchAll(CITE)) {
    const start = match.index ?? 0
    if (start > last) blocks.push({ kind: "text", text: text.slice(last, start) })
    const path = match[1].trim().replace(/^wiki\//, "")
    const ref = cardMap[path]
    if (ref) blocks.push({ kind: "cite", text: match[2]?.trim() || ref.title, cite: { cardId: ref.cardId } })
    else blocks.push({ kind: "text", text: match[2]?.trim() || path })
    last = start + match[0].length
  }
  if (last < text.length) blocks.push({ kind: "text", text: text.slice(last) })
  return blocks.length ? blocks : [{ kind: "text", text }]
}

/* The channel renders plain text blocks and fenced code, not markdown. */
function toParagraphs(answer: string): Paragraphs {
  const out: Block[][] = []
  const parts = answer.replace(/\r\n/g, "\n").split(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g)
  parts.forEach((part, index) => {
    if (index % 2 === 1) { out.push([{ kind: "code", text: part.replace(/\n$/, "") }]); return }
    for (const paragraph of part.split(/\n\s*\n/)) {
      const lines = paragraph.split("\n").map((line) => line.trim()).filter(Boolean)
      if (!lines.length) continue
      const isList = lines.length > 1 && lines.every((line) => /^([-*•]|\d+[.)])\s+/.test(line))
      const chunks = isList ? lines.map((line) => line.replace(/^([-*•]|\d+[.)])\s+/, "– ")) : [lines.join(" ")]
      for (const chunk of chunks) {
        const text = chunk.replace(/^#{1,6}\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`\n]+)`/g, "$1").trim()
        if (text) out.push(inlineBlocks(text))
      }
    }
  })
  return (out.length ? out : [[{ kind: "text", text: answer.trim() || "(no answer)" }]]) as Paragraphs
}

const citedCardIds = (paragraphs: Paragraphs): string[] => {
  const ids: string[] = []
  for (const paragraph of paragraphs) {
    for (const block of paragraph) if (block.kind === "cite" && !ids.includes(block.cite.cardId)) ids.push(block.cite.cardId)
  }
  return ids
}

function buildPrompt(work: RunnerWork["payload"]): string {
  const plain = (paragraphs: Paragraphs): string =>
    paragraphs.map((paragraph) => paragraph.map((block) => block.text).join("")).join("\n")
  const history = work.context
    .filter((message) => message.id !== work.message.id)
    .map((message) => `${message.authorId === agent?.id ? "you" : message.authorId}: ${plain(message.paragraphs)}`)
    .join("\n")
  return [
    agent?.instructions?.trim() ? `Your instructions from the community:\n${agent.instructions.trim()}` : "",
    history ? `Recent messages in this channel:\n${history}` : "",
    `${work.from.displayName} (${work.from.role}) mentioned you:\n${plain(work.message.paragraphs)}`,
    `If a card you write comes from this request, record it in the card's frontmatter as: sources: [${work.message.id}]`,
    "Follow AGENTS.md: read wiki/index.md first, compose the answer from the cards when they already cover it, write or enrich a card in wiki/ when you learned something worth keeping, and cite cards as [[path]] relative to wiki/. Reply with the answer only — plain sentences, no headings or bullet lists, code only in fenced blocks.",
  ].filter(Boolean).join("\n\n")
}

/* ---- The wiki's history ------------------------------------------------- */

/* One commit per run, when the agent folder is its own repository. `git diff`
   then answers "what did the agent learn this week?". A folder that is not a
   repo is fine and silent: git is the group's option, not a requirement. */
function commitRun(message: string): Promise<void> {
  if (!existsSync(join(config.cwd, ".git"))) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const child = spawn("git", ["-C", config.cwd, "add", "-A"], { stdio: "ignore", windowsHide: true })
    child.on("error", () => resolve())
    child.on("close", () => {
      const commit = spawn("git", ["-C", config.cwd, "commit", "-m", message, "--allow-empty"], { stdio: "ignore", windowsHide: true })
      commit.on("error", () => resolve())
      commit.on("close", () => resolve())
    })
  })
}

/* ---- One mention -------------------------------------------------------- */

let working = Promise.resolve()
const enqueue = (job: () => Promise<void>): void => { working = working.then(job, job) }

async function handleWork(payload: RunnerWork["payload"]): Promise<void> {
  log(`mention from ${payload.from.displayName} in ${payload.channelId}`)
  presence("thinking")
  const before = listWiki(config.cwd)

  let answer: string
  try {
    /* Every message and local file is untrusted text. If somebody has pasted
       the runner token into a channel, it must not reach a model prompt. */
    answer = await runProvider({
      runtime: config.runtime, model: config.model, cwd: config.cwd,
      prompt: redact(buildPrompt(payload), secrets), timeoutMs: config.timeoutMs, secrets,
    })
  } catch (error) {
    /* A failed run is reported in the channel. Silence would look like the
       agent ignored the person who asked. */
    const failure = error as Error & { code?: string }
    log(`run failed${failure.code ? ` (${failure.code})` : ""}:`, failure.message)
    await request("message.create", {
      communityId: payload.communityId, agentId: payload.agentId, channelId: payload.channelId,
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
      paragraphs: [[{ kind: "text", text: `I couldn't answer this time (${(error as Error).message}). Mention me again and I'll retry.` }]],
    }).catch(() => undefined)
    presence("online")
    return
  }

  /* Cards come from the filesystem, not from the model's words. */
  const after = listWiki(config.cwd)
  const changed = [...after.keys()].filter((path) => isPublishable(path) && before.get(path) !== after.get(path)).sort()
  if (changed.length) presence("publishing")
  for (const path of changed) {
    try {
      safeWikiPath(config.cwd, path)
      const card = parseCard(path, after.get(path) ?? "")
      const replacesCardId = card.supersedes ? cardMap[card.supersedes.replace(/^wiki\//, "")]?.cardId : undefined
      const ack = await request("card.publish", {
        communityId: payload.communityId, agentId: payload.agentId,
        channelId: card.channel ?? payload.channelId,
        path, title: card.title, type: card.type, body: card.body,
        sourceMessageIds: card.sources.length ? card.sources : [payload.message.id],
        ...(replacesCardId ? { replacesCardId } : {}),
      })
      if (ack.cardId) {
        cardMap[path] = { cardId: ack.cardId, title: card.title } satisfies CardRef
        log(`published ${path}`)
      }
    } catch (error) {
      log(`couldn't publish ${path}:`, (error as Error).message)
    }
  }
  if (changed.length) saveCardMap(config.cwd, cardMap)

  const paragraphs = toParagraphs(answer)
  const cited = citedCardIds(paragraphs)
  /* "Composed from the card file": this run wrote nothing new and the answer
     cites cards, so it was built entirely from what the group had already
     understood. Every cited card travels — composing draws on several, and the
     first one is not privileged. The runner names them; the server dates them,
     because this machine's clock is not evidence. */
  const fromFile = !changed.length && cited.length ? { cardIds: cited } : undefined

  try {
    await request("message.create", {
      communityId: payload.communityId, agentId: payload.agentId, channelId: payload.channelId,
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
      paragraphs,
      ...(fromFile ? { fromFile } : {}),
    })
    log(`answered (${cited.length} citations${fromFile ? `, composed from ${fromFile.cardIds.length} card(s) on file` : ""}${changed.length ? `, +${changed.length} card(s)` : ""})`)
  } catch (error) {
    log("couldn't post the answer:", (error as Error).message)
  }

  appendLog(payload, changed)
  await commitRun(`${agent?.name ?? "agent"}: answer in ${payload.channelId}${changed.length ? ` (+${changed.length} cards)` : ""}`)
  presence("online")
}

function appendLog(payload: RunnerWork["payload"], changed: readonly string[]): void {
  const line = `- ${new Date().toISOString()} · ${payload.from.displayName} in ${payload.channelId}${changed.length ? ` · wrote ${changed.join(", ")}` : ""}\n`
  const file = join(config.cwd, "wiki", "log.md")
  try {
    const existing = listWiki(config.cwd).get("log.md") ?? "# Log\n\n"
    writeFileSync(file, existing + line)
  } catch { /* the log is a convenience, never a reason to fail a run */ }
}

/* ---- Connection --------------------------------------------------------- */

function connect(attempt = 0): void {
  const url = `${config.server.replace(/^http/, "ws")}/ws/runner`
  socket = new WebSocket(url)

  let ready = false
  let authTimer: ReturnType<typeof setTimeout> | undefined

  socket.on("open", () => {
    /* The token travels in this frame and nowhere else. */
    send({ type: "auth", token: config.token })
    /* A server that accepts the connection but never answers would otherwise
       leave this process idle and apparently healthy. */
    authTimer = setTimeout(() => {
      if (!ready) {
        log("the server did not accept this runner in time")
        socket?.close(4401, "authentication timeout")
      }
    }, 10_000)
  })

  socket.on("message", (raw) => {
    const parsed = runnerServerFrameSchema.safeParse(JSON.parse(raw.toString()))
    if (!parsed.success) { log("ignoring a frame that does not satisfy the protocol"); return }
    const frame = parsed.data
    if (frame.type === "ready") {
      ready = true
      if (authTimer) clearTimeout(authTimer)
      agent = frame.agent
      cardMap = loadCardMap(config.cwd)
      log(`connected as "${frame.agent.name}" in community ${frame.agent.communityId}`)
      presence("online")
      return
    }
    if (frame.type === "ack") {
      const waiting = pending.get(frame.ref)
      if (!waiting) return
      pending.delete(frame.ref)
      if (frame.ok) waiting.resolve({ ok: true, messageId: frame.messageId, cardId: frame.cardId })
      else waiting.reject(new Error(frame.error))
      return
    }
    if (frame.type === "work") enqueue(() => handleWork(frame.payload))
  })

  socket.on("close", (code) => {
    if (authTimer) clearTimeout(authTimer)
    if (closing) return
    /* 4401/4409 mean this runner is not welcome: a revoked or rotated token, or
       a newer runner for the same agent. Retrying would be a login loop. */
    if (code === 4401 || code === 4409) {
      log(code === 4409 ? "another runner took over this agent" : "the server rejected this runner token")
      process.exit(1)
    }
    const delay = Math.min(30_000, 1_000 * 2 ** attempt)
    log(`disconnected (${code}); reconnecting in ${Math.round(delay / 1000)}s`)
    setTimeout(() => connect(attempt + 1), delay)
  })

  socket.on("error", (error) => log("socket error:", error.message))
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    closing = true
    presence("offline")
    socket?.close()
    process.exit(0)
  })
}

log(`workspace ${config.cwd}`)
log(`server ${config.server} · runtime ${config.runtime}${config.model !== "default" ? ` · model ${config.model}` : ""}`)
connect()
