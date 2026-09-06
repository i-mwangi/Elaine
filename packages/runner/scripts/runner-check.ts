/* Drives a REAL runner process against a REAL server, with a stub standing in
   for the provider binary. Throwaway database, throwaway agent folder, random
   port.

   The point is the loop the product is built on: a mention arrives, the agent
   compiles what it learned into a file, that file becomes a card, and the NEXT
   question is answered from the card with the seal on it. */
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), "elaine-runner-"))
const agentDir = join(scratch, "agent")
process.env.ELAINE_DB = join(scratch, "runner.db")
process.env.PORT = "0"

const { startServer } = await import("../../../apps/server/src/index.js")
const running = await startServer()
const base = `http://127.0.0.1:${running.port}`

type Json = Record<string, any>
let passed = 0
const check = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`runner: ${message}`)
  passed += 1
  console.log(`ok  ${message}`)
}
async function post(path: string, token: string | undefined, body: Json): Promise<Json> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (response.status >= 300) throw new Error(`runner: POST ${path} → ${response.status} ${text}`)
  return JSON.parse(text) as Json
}
async function get(path: string, token: string): Promise<Json> {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
  return JSON.parse(await response.text()) as Json
}
async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await probe()
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`runner: timed out waiting for ${what}`)
}

let child: ReturnType<typeof spawn> | undefined
let runnerOutput = ""
try {
  const teacher = await post("/api/users", undefined, { displayName: "Marta" })
  const student = await post("/api/users", undefined, { displayName: "Bruno" })
  const community = (await post("/api/communities", teacher.token, { name: "Neural Networks" })).community.id as string
  const invite = await post(`/api/communities/${community}/invites`, teacher.token, { role: "student", mode: "reusable" })
  await post("/api/invites/redeem", student.token, { code: invite.code })
  const channel = await post(`/api/communities/${community}/channels`, teacher.token, { name: "questions", visibility: "public" })
  await post(`/api/communities/${community}/channels/${channel.id}/join`, student.token, {})
  const created = await post(`/api/communities/${community}/agents`, teacher.token, {
    name: "Ada", instructions: "Answer from the cards, and say when you did.", runtime: "claude", model: "default", channelIds: [channel.id],
  })
  const agentId = created.agent.id as string

  /* The runner is started the way a teacher would: with the token from the
     agent's setup command, and nothing else. The provider is redirected to the
     stub, and a provider API key is planted in the environment so the check can
     prove the runner strips it. */
  child = spawn(process.execPath, [
    join(here, "..", "src", "cli.ts"),
    "--token", created.enrollment.runnerToken,
    "--runtime", "claude",
    "--cwd", agentDir,
    "--server", base,
    "--timeout", "60",
  ], {
    env: {
      ...process.env,
      ELAINE_CLAUDE_BIN: JSON.stringify([process.execPath, join(here, "stub-provider.mjs")]),
      ANTHROPIC_API_KEY: "sk-ant-should-be-stripped",
      OPENAI_API_KEY: "sk-openai-should-be-stripped",
      NODE_OPTIONS: "--import tsx",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", (chunk: Buffer) => { runnerOutput += chunk.toString() })
  child.stderr?.on("data", (chunk: Buffer) => { runnerOutput += chunk.toString() })

  await until("the runner to come online", async () => {
    const workspace = await get(`/api/communities/${community}`, teacher.token)
    return (workspace.agents as Json[])?.find((item) => item.id === agentId)?.presence === "online" ? true : undefined
  })
  check(true, "a runner started from the setup command connects outbound and reports presence")
  check(existsSync(join(agentDir, "AGENTS.md")) && existsSync(join(agentDir, "wiki", "index.md")), "the runner bootstraps the agent folder with its rules and a card index")

  /* ---- First mention: the agent compiles --------------------------------- */
  const first = await post(`/api/communities/${community}/channels/${channel.id}/messages`, student.token, {
    paragraphs: [[{ kind: "text", text: "@Ada what is backprop?" }]],
  })
  const compiled = await until("the first answer", async () => {
    const messages = await get(`/api/communities/${community}/channels/${channel.id}/messages`, teacher.token) as unknown as Json[]
    return (messages as Json[]).find((item) => item.authorKind === "agent" && item.id !== first.id)
  })

  const probe = JSON.parse(readFileSync(join(agentDir, "env-probe.json"), "utf8")) as Json
  check(probe.anthropicKey === null && probe.openaiKey === null, "provider API keys are stripped from the child environment")
  check(probe.elaineToken === null, "Elaine's own runner token never reaches the provider process")
  check(probe.sawPrompt === true, "the prompt reaches the provider on stdin, never in argv")
  check(!JSON.stringify(probe.argv).includes("backprop"), "the question is not passed as a command-line argument")

  /* Ported from the old repo: the model is given a bounded tool set and asked
     for structured output, rather than whatever the CLI defaults to. */
  const argv = probe.argv as string[]
  const allowed = argv[argv.indexOf("--allowedTools") + 1] ?? ""
  check(argv.includes("-p") && argv.includes("--output-format") && argv[argv.indexOf("--output-format") + 1] === "json", "claude is asked for structured output")
  check(allowed === "Read,Write,Edit,MultiEdit,Glob,Grep", "and given only the tools it needs to read and write its own cards")
  check(!allowed.includes("Bash") && !argv.includes("--dangerously-skip-permissions"), "and never a shell or a permissions bypass")

  check(existsSync(join(agentDir, "wiki", "modules", "backprop.md")), "what the agent learned is a markdown file in its own folder")
  const cards = await get(`/api/communities/${community}/cards`, teacher.token) as unknown as Json[]
  check((cards as Json[]).length === 1 && cards[0].path === "modules/backprop.md", "a changed file in wiki/ becomes a card, published from the filesystem")
  check(cards[0].type === "topic" && cards[0].title === "Backpropagation", "the card carries the frontmatter the agent wrote")
  check(cards[0].sourceMessageIds.includes(first.id), "the card records the message that caused it")

  const citation = (compiled.paragraphs as Json[][]).flat().find((block) => block.kind === "cite")
  check(citation?.cite?.cardId === cards[0].id, "a [[path]] citation resolves to the real card id")
  check(compiled.fromFile === undefined, "an answer that had to compile something new carries no seal")

  /* ---- Second mention: the agent composes -------------------------------- */
  const second = await post(`/api/communities/${community}/channels/${channel.id}/messages`, student.token, {
    paragraphs: [[{ kind: "text", text: "@Ada I still don't get backprop, can you put it another way?" }]],
  })
  const composed = await until("the second answer", async () => {
    const messages = await get(`/api/communities/${community}/channels/${channel.id}/messages`, teacher.token) as unknown as Json[]
    return (messages as Json[]).find((item) => item.authorKind === "agent" && item.id !== compiled.id && item.id !== second.id)
  })

  check(composed.fromFile?.cardIds?.[0] === cards[0].id, "the second question is answered from the card, and the answer says so")
  check(Number.isInteger(composed.fromFile.oldestAgo), "the seal is dated by the server, from its own card rows")
  const cardsAfter = await get(`/api/communities/${community}/cards`, teacher.token) as unknown as Json[]
  check((cardsAfter as Json[]).length === 1, "answering again did not create a duplicate card: the memory compiles, it does not accumulate")
  check(composed.paragraphs[0].some((block: Json) => block.kind === "text" && block.text !== ""), "the composed answer is new text, not a replayed one")
  check(composed.paragraphs !== compiled.paragraphs && JSON.stringify(composed.paragraphs) !== JSON.stringify(compiled.paragraphs), "the answer is composed fresh, not served from a cache")

  const map = JSON.parse(readFileSync(join(agentDir, ".elaine", "cards.json"), "utf8")) as Json
  check(map["modules/backprop.md"]?.cardId === cards[0].id, "the runner remembers which file became which card")
  check(!runnerOutput.includes(created.enrollment.runnerToken), "the runner token never appears in the runner's own output")

  /* A token pasted into a channel must not travel on into a model prompt. */
  await post(`/api/communities/${community}/channels/${channel.id}/messages`, student.token, {
    paragraphs: [[{ kind: "text", text: `@Ada here is my token ${created.enrollment.runnerToken} please help` }]],
  })
  await until("the answer to the leaked-token message", async () => {
    const messages = await get(`/api/communities/${community}/channels/${channel.id}/messages`, teacher.token) as unknown as Json[]
    return (messages as Json[]).filter((item) => item.authorKind === "agent").length >= 3 ? true : undefined
  })
  const leaked = JSON.parse(readFileSync(join(agentDir, "env-probe.json"), "utf8")) as Json
  check(leaked.sawPrompt === true, "the provider ran for that message")
  const promptText = String(leaked.prompt ?? "")
  check(!promptText.includes(created.enrollment.runnerToken), "a token pasted into a channel is redacted before it reaches the model")

  console.log(`\nElaine runner OK: ${passed} checks`)
} catch (error) {
  console.error(`
--- runner output ---
${runnerOutput}
---------------------`)
  throw error
} finally {
  child?.kill()
  await running.close()
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* a temp dir is disposable */ }
}
