/* The in-server agent worker.

   An agent whose runtime is `api` is answered by this process against a
   configured HTTP endpoint, so it works with nothing running on anyone's
   machine — you create it in the browser and mention it.

   That is a deliberate departure from the `claude` and `codex` runtimes, where
   the model runs in a separate process holding the creator's own subscription
   and Elaine never sees a credential. Here Elaine does hold one, so it is kept
   in one place: read from the environment, used only to sign the request, and
   never written to the database, a projection, an event, or a prompt.

   The endpoint is described entirely by environment variables and no vendor is
   named anywhere, so moving to a different provider is an env change and
   nothing more:

     ELAINE_API_BASE_URL   an OpenAI-compatible base, e.g. https://host/v1
     ELAINE_API_KEY        the bearer for that endpoint
     ELAINE_API_MODEL      the model name to request

   A chat endpoint cannot write files, and cards must come from files — so the
   model is asked for JSON carrying the answer and any cards, this writes those
   files into the agent's folder, and the SAME wiki diff the runner uses decides
   what gets published. The rule "a card is published because a file changed"
   holds for both runtimes. */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import type { Block, CardType, Message, Paragraphs, Presence } from "@elaine/protocol"
import { type ApiConfig, type Row, text } from "./db.js"
import { createAgentMessage, listCards, publishCard } from "./store.js"

/* Each server-run agent gets a folder of its own, beside the file store, with
   the same shape a runner would create. */
function agentRoot(filesRoot: string, agentId: string): string {
  const root = resolve(filesRoot, "agents", agentId)
  mkdirSync(join(root, "wiki"), { recursive: true })
  return root
}

function listWiki(root: string): Map<string, string> {
  const wiki = join(root, "wiki")
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (entry.endsWith(".md")) out.set(relative(wiki, full).split(sep).join("/"), readFileSync(full, "utf8"))
    }
  }
  if (existsSync(wiki)) walk(wiki)
  return out
}

/* A path proposed by a model is untrusted: anything escaping wiki/ is refused
   rather than normalised. */
function safeWikiPath(root: string, relativePath: string): string | undefined {
  const wiki = resolve(root, "wiki")
  const target = resolve(wiki, relativePath)
  if (target !== wiki && !target.startsWith(wiki + sep)) return undefined
  if (!target.endsWith(".md")) return undefined
  return target
}

/* The file keeps its frontmatter; the published card does not. The header is
   how the file describes itself, and the runner strips it the same way — a card
   whose body opened with its own metadata would read as gibberish. */
function withoutFrontmatter(contents: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(contents)
  return (match ? contents.slice(match[0].length) : contents).trim()
}

const CARD_TYPES = new Set<CardType>(["topic", "decision", "question", "assignment", "submission", "difficulty", "person"])
const CITE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

type ProposedCard = { path: string; title: string; type: string; body: string; supersedes?: string }

/* The model answers with JSON. Anything that is not the shape we asked for is
   treated as a plain answer with no cards, rather than failing the reply. */
function parseModelOutput(raw: string): { answer: string; cards: ProposedCard[] } {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim()
  try {
    const parsed = JSON.parse(trimmed) as { answer?: unknown; cards?: unknown }
    const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : ""
    const cards = Array.isArray(parsed.cards) ? parsed.cards.filter((card): card is ProposedCard =>
      !!card && typeof card === "object"
      && typeof (card as ProposedCard).path === "string"
      && typeof (card as ProposedCard).body === "string") : []
    if (answer) return { answer, cards }
  } catch { /* not JSON: take it as the answer itself */ }
  return { answer: trimmed, cards: [] }
}

function toParagraphs(answer: string, citeToCard: (path: string) => { id: string; title: string } | undefined): Paragraphs {
  const out: Block[][] = []
  for (const part of answer.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const line = part.split("\n").map((item) => item.trim()).filter(Boolean).join(" ")
    if (!line) continue
    const blocks: Block[] = []
    let last = 0
    for (const match of line.matchAll(CITE)) {
      const start = match.index ?? 0
      if (start > last) blocks.push({ kind: "text", text: line.slice(last, start) })
      const path = match[1].trim().replace(/^wiki\//, "")
      const card = citeToCard(path)
      /* A bare [[path]] would otherwise render as a filename in the middle of a
         sentence; the card's own title is what it is called. */
      if (card) blocks.push({ kind: "cite", text: match[2]?.trim() || card.title, cite: { cardId: card.id } })
      else blocks.push({ kind: "text", text: match[2]?.trim() || path })
      last = start + match[0].length
    }
    if (last < line.length) blocks.push({ kind: "text", text: line.slice(last) })
    out.push(blocks.length ? blocks : [{ kind: "text", text: line }])
  }
  return (out.length ? out : [[{ kind: "text", text: answer.trim() || "(no answer)" }]]) as Paragraphs
}

const plain = (paragraphs: Paragraphs): string =>
  paragraphs.map((paragraph) => paragraph.map((block) => block.text).join("")).join("\n")

function buildPrompt(agent: Row, work: { message: Message; from: string; context: Message[] }, wiki: Map<string, string>): string {
  const index = [...wiki.entries()]
    .filter(([path]) => path !== "index.md" && path !== "log.md")
    .map(([path, body]) => `--- ${path} ---\n${body.slice(0, 4_000)}`)
    .join("\n\n")
  const history = work.context
    .filter((item) => item.id !== work.message.id)
    .map((item) => `${item.authorId === text(agent.id) ? "you" : item.authorId}: ${plain(item.paragraphs)}`)
    .join("\n")
  return [
    text(agent.instructions).trim() ? `Your instructions from the community:\n${text(agent.instructions).trim()}` : "",
    index ? `Your card file. Answer from these when they already cover the question:\n${index}` : "Your card file is empty.",
    history ? `Recent messages in this channel:\n${history}` : "",
    `${work.from} asked:\n${plain(work.message.paragraphs)}`,
    [
      "Reply with a single JSON object and nothing else. Every reply is JSON, including when there are no cards:",
      '{"answer": "...", "cards": [{"path": "modules/topic.md", "title": "...", "type": "topic", "body": "..."}]}',
      "- answer: plain sentences for a chat channel. No headings, no bullet lists, no markdown emphasis.",
      "",
      "Which of these two you are doing decides what `cards` contains:",
      "- NO existing card covers this question. Then you worked the answer out here, and it",
      "  must not be lost: return exactly one card holding the CONCEPT you explained, written",
      "  so that someone who never saw this conversation can use it. Not a transcript, not the",
      "  question, not your reply to this person.",
      "- An existing card DOES cover it. Then return cards as [], and you MUST cite the card",
      "  you used as [[its path]] somewhere in the answer — an answer built from a card that",
      "  does not name it is indistinguishable from one you improvised.",
      "  Compose a NEW answer for what THIS person actually asked. Do not repeat the card's",
      "  wording, and do not repeat an answer you already gave earlier in this channel: they",
      "  have read it and it did not land, which is why they are asking again. Say it a",
      "  different way — a shorter way, a concrete example, or whatever their wording shows",
      "  they are missing.",
      "  If the question exposes an angle the card misses, return that card at its own path",
      "  with the fuller body; to correct something now wrong, return a new path and set",
      "  supersedes to the old one.",
      "",
      "- path looks like modules/backpropagation.md, one topic per file.",
      "- type is one of topic, decision, question, assignment, submission, difficulty, person.",
    ].join("\n"),
  ].filter(Boolean).join("\n\n")
}

async function callModel(config: ApiConfig, prompt: string, signal: AbortSignal, jsonMode = true): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.key}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      /* Asking for JSON in the prompt is not enough: a model that answers in
         prose still reads as a valid answer, and the cards it should have
         written are silently lost. This makes the contract the endpoint's
         problem rather than the wording's. */
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
    signal,
  })
  const body = await response.text()
  /* Not every endpoint supports it; one retry without, rather than failing. */
  if (!response.ok && jsonMode && /response_format|json_object/i.test(body)) {
    return callModel(config, prompt, signal, false)
  }
  if (!response.ok) {
    /* The key must never travel into a channel or a log. */
    throw new Error(`the model endpoint returned ${response.status}: ${body.slice(0, 300).split(config.key).join("[redacted]")}`)
  }
  const parsed = JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] }
  const content = parsed.choices?.[0]?.message?.content
  if (typeof content !== "string" || !content.trim()) throw new Error("the model endpoint returned an empty answer")
  return content
}

export type { ApiConfig }

export type WorkerDeps = {
  database: DatabaseSync
  filesRoot: string
  setPresence: (agentId: string, presence: Presence) => void
  onMessage: (message: Message) => void
  onCard: (card: ReturnType<typeof publishCard>) => void
  timeoutMs?: number
}

/* Answer one mention. Mirrors the runner's order exactly: write files, publish
   what changed, then post the answer — sealed when the run wrote nothing and
   cited something. */
export async function answerMention(deps: WorkerDeps, config: ApiConfig, agent: Row, work: { communityId: string; channelId: string; threadId?: string; message: Message; from: string; context: Message[] }): Promise<void> {
  const agentId = text(agent.id)
  const root = agentRoot(deps.filesRoot, agentId)
  const before = listWiki(root)
  deps.setPresence(agentId, "thinking")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 120_000)
  let output: string
  try {
    output = await callModel(config, buildPrompt(agent, work, before), controller.signal)
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error"
    deps.setPresence(agentId, "online")
    const failed = createAgentMessage(deps.database, work.communityId, agentId, work.channelId, {
      paragraphs: [[{ kind: "text", text: `I couldn't answer this time (${detail}). Mention me again and I'll retry.` }]],
      ...(work.threadId ? { threadId: work.threadId } : {}),
    })
    deps.onMessage(failed)
    return
  } finally {
    clearTimeout(timer)
  }

  const { answer, cards } = parseModelOutput(output)

  /* Written to the folder first, so publishing is still driven by a file diff. */
  for (const card of cards) {
    const target = safeWikiPath(root, card.path)
    if (!target) continue
    mkdirSync(join(target, ".."), { recursive: true })
    const type = CARD_TYPES.has(card.type as CardType) ? card.type : "topic"
    const frontmatter = [
      "---",
      `type: ${type}`,
      `title: ${card.title || card.path.replace(/\.md$/, "").split("/").pop()}`,
      `sources: [${work.message.id}]`,
      ...(card.supersedes ? [`supersedes: ${card.supersedes}`] : []),
      "---",
      "",
    ].join("\n")
    writeFileSync(target, frontmatter + card.body.trim() + "\n")
  }

  const after = listWiki(root)
  const changed = [...after.keys()].filter((path) => path !== "index.md" && path !== "log.md" && before.get(path) !== after.get(path)).sort()
  if (changed.length) deps.setPresence(agentId, "publishing")

  for (const path of changed) {
    const proposed = cards.find((card) => card.path.replace(/^wiki\//, "") === path)
    const existing = listCards(deps.database, work.communityId, { id: text(agent.created_by) } as never)
      .find((card) => card.agentId === agentId && card.path === (proposed?.supersedes ?? ""))
    try {
      const card = publishCard(deps.database, work.communityId, agentId, {
        channelId: work.channelId,
        path,
        title: proposed?.title || path.replace(/\.md$/, "").split("/").pop() || path,
        type: (CARD_TYPES.has(proposed?.type as CardType) ? proposed?.type : "topic") as CardType,
        body: withoutFrontmatter(after.get(path) ?? ""),
        sourceMessageIds: [work.message.id],
        ...(existing ? { replacesCardId: existing.id } : {}),
      })
      deps.onCard(card)
    } catch { /* one bad card must not cost the answer */ }
  }

  /* Resolve [[path]] against this agent's published cards. */
  const published = listCards(deps.database, work.communityId, { id: text(agent.created_by) } as never)
    .filter((card) => card.agentId === agentId)
  const byPath = new Map(published.map((card) => [card.path, { id: card.id, title: card.title }]))
  const paragraphs = toParagraphs(answer, (path) => byPath.get(path))
  const cited: string[] = []
  for (const paragraph of paragraphs) {
    for (const block of paragraph) if (block.kind === "cite" && !cited.includes(block.cite.cardId)) cited.push(block.cite.cardId)
  }

  const message = createAgentMessage(deps.database, work.communityId, agentId, work.channelId, {
    paragraphs,
    ...(work.threadId ? { threadId: work.threadId } : {}),
    /* Composed from the card file: this run wrote nothing and cited cards. */
    ...(!changed.length && cited.length ? { fromFileCardIds: cited } : {}),
  })
  deps.onMessage(message)
  deps.setPresence(agentId, "online")
}
