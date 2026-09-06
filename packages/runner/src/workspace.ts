/* The agent's folder.

   Knowledge lives in files the group owns: the wiki is plain markdown with
   frontmatter, and a card is published because a FILE changed — never because
   the model said it wrote one. That is the whole point of keeping memory on a
   filesystem rather than in a model's answer. */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import type { CardType } from "@elaine/protocol"

export const AGENTS_MD = `# Agent workspace rules

1. Before answering, read \`wiki/index.md\`. Open at most 5 cards.
2. Cite every card you use by path, as \`[[modules/03-backprop/chain-rule.md]]\`.
3. Compose from the cards. Never paste a previous answer. If the question brings
   an angle a card did not cover, enrich that card; do not create a second card
   for the same thing.
4. Archive as a card only what another student could need: the concept, the
   connection, or the difficulty — not the conversation.
5. Never write outside this folder.
6. If a source contradicts a card, write a NEW card with \`supersedes:\` pointing
   at the old one. Do not edit the old card. Enriching is not contradicting:
   adding an angle is editing, changing a fact is replacing.
7. Keep frontmatter accurate: \`type\`, \`title\`, \`sources\`, and \`supersedes\`.
`

export const INDEX_MD = `---
type: topic
title: Card index
---

# Card index

The durable cards in this agent's wiki. Keep it readable, and update it when a
card is added or replaced.
`

const CLAUDE_MD = `# Elaine agent instructions

Read \`AGENTS.md\` and \`wiki/index.md\` first, and follow the card rules there.
Work only inside this folder; course material is read-only context supplied in
the prompt. Reply with the answer only — the channel renders plain text.
`

export type Frontmatter = {
  title: string
  type: CardType
  sources: string[]
  supersedes?: string
  channel?: string
}

export type ParsedCard = Frontmatter & { body: string }

export function ensureWorkspace(cwd: string): void {
  mkdirSync(join(cwd, "wiki"), { recursive: true })
  mkdirSync(join(cwd, ".elaine"), { recursive: true })
  /* Bootstrapped once. A human editing these afterwards is the point: the rules
     are the group's, not the platform's. */
  writeOnce(join(cwd, "AGENTS.md"), AGENTS_MD)
  writeOnce(join(cwd, "CLAUDE.md"), CLAUDE_MD)
  writeOnce(join(cwd, "wiki", "index.md"), INDEX_MD)
}

function writeOnce(file: string, contents: string): void {
  if (!existsSync(file)) writeFileSync(file, contents)
}

/* A path from the model is untrusted input. Anything that escapes wiki/ is
   refused rather than normalised, because rule 5 is a boundary, not a hint. */
export function safeWikiPath(cwd: string, relativePath: string): string {
  const wiki = resolve(cwd, "wiki")
  const target = resolve(wiki, relativePath)
  if (target !== wiki && !target.startsWith(wiki + sep)) throw new Error(`refusing a path outside wiki/: ${relativePath}`)
  return target
}

/* A snapshot of wiki/ as path → contents, used to tell what a run changed. */
export function listWiki(cwd: string): Map<string, string> {
  const wiki = join(cwd, "wiki")
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!entry.endsWith(".md")) continue
      out.set(relative(wiki, full).split(sep).join("/"), readFileSync(full, "utf8"))
    }
  }
  if (existsSync(wiki)) walk(wiki)
  return out
}

/* The card types the wiki may declare. `index.md` and `log.md` are the agent's
   own bookkeeping and are never published as cards. */
const CARD_TYPES = new Set<CardType>(["topic", "decision", "question", "assignment", "submission", "difficulty", "person"])
export const isPublishable = (path: string): boolean => path !== "index.md" && path !== "log.md"

/* A deliberately small frontmatter reader: the six keys the card rules use, and
   no YAML dependency for a format the agent writes by hand. */
export function parseCard(path: string, contents: string): ParsedCard {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(contents)
  const body = match ? contents.slice(match[0].length) : contents
  const fields = new Map<string, string>()
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim())
    if (pair) fields.set(pair[1], pair[2].trim())
  }
  const declared = fields.get("type") as CardType | undefined
  const list = (value: string | undefined): string[] =>
    (value ?? "").replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
  return {
    title: fields.get("title") || path.replace(/\.md$/, "").split("/").pop() || path,
    /* An unknown or missing type is recorded as a topic rather than rejected:
       losing a card over a typo in its header would be worse than filing it. */
    type: declared && CARD_TYPES.has(declared) ? declared : "topic",
    sources: list(fields.get("sources")),
    ...(fields.get("supersedes") ? { supersedes: fields.get("supersedes") } : {}),
    ...(fields.get("channel") ? { channel: fields.get("channel") } : {}),
    body,
  }
}

/* wiki path → the card id the server gave it, so `[[path]]` in an answer can
   become a real citation. Kept beside the folder, not in it: it is this
   runner's bookkeeping, not the group's knowledge. */
export type CardRef = { cardId: string; title: string }

export function loadCardMap(cwd: string): Record<string, CardRef> {
  const file = join(cwd, ".elaine", "cards.json")
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, CardRef> } catch { return {} }
}

export function saveCardMap(cwd: string, map: Record<string, CardRef>): void {
  writeFileSync(join(cwd, ".elaine", "cards.json"), JSON.stringify(map, null, 2) + "\n")
}
