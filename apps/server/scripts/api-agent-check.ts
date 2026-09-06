/* The server-run agent: an agent with nothing started for it anywhere.

   A stub endpoint stands in for the model, so this asserts the loop rather than
   a provider: first mention compiles a card into the agent's folder on the
   server and publishes it, second mention composes from that card and carries
   the seal. Throwaway database, throwaway file store, random port. */
import { createServer } from "node:http"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const scratch = mkdtempSync(join(tmpdir(), "elaine-api-agent-"))
process.env.ELAINE_DB = join(scratch, "api.db")
process.env.ELAINE_FILES = join(scratch, "files")
process.env.PORT = "0"

type Json = Record<string, any>
let passed = 0
const check = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`api-agent: ${message}`)
  passed += 1
  console.log(`ok  ${message}`)
}

/* Stands in for the model endpoint. It behaves the way the prompt asks: it
   compiles a card the first time and composes from it afterwards, and it
   records what it was sent so the checks can inspect the prompt. */
const seen: { authorization?: string; prompts: string[]; paths: string[]; jsonModes: boolean[]; refusedJsonMode: boolean } =
  { prompts: [], paths: [], jsonModes: [], refusedJsonMode: false }
let compiled = false
const model = createServer((request, response) => {
  let body = ""
  request.on("data", (chunk) => { body += chunk })
  request.on("end", () => {
    seen.authorization = request.headers.authorization
    const parsed = JSON.parse(body) as { messages: { content: string }[]; response_format?: unknown }
    /* Not every OpenAI-compatible endpoint accepts response_format, and the
       ones that refuse it say so in the error rather than ignoring it. The
       first request is refused the way those do, so the retry without it is
       exercised here rather than discovered against a live provider. */
    if (parsed.response_format && !seen.refusedJsonMode) {
      seen.refusedJsonMode = true
      response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: 'Invalid JSON payload received. Unknown name "response_format".' } }))
      return
    }
    const prompt = parsed.messages[0].content
    seen.prompts.push(prompt)
    seen.paths.push(request.url ?? "")
    seen.jsonModes.push(!!parsed.response_format)
    const answer = compiled
      ? { answer: "Put another way: it is the chain rule, applied backwards [[modules/backprop.md]]." }
      : {
          answer: "Backprop is the chain rule applied backwards through the network [[modules/backprop.md]].",
          cards: [{ path: "modules/backprop.md", title: "Backpropagation", type: "topic", body: "The chain rule, applied backwards through the network." }],
        }
    compiled = true
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }))
  })
})
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve))
const modelAddress = model.address()
if (!modelAddress || typeof modelAddress === "string") throw new Error("api-agent: the stub endpoint did not bind")

/* Deliberately trailing-slashed: people paste a base URL both ways, and a
   doubled slash is a 404 on some gateways. */
process.env.ELAINE_API_BASE_URL = `http://127.0.0.1:${modelAddress.port}/v1/`
process.env.ELAINE_API_KEY = "test-key-not-a-real-credential"
process.env.ELAINE_API_MODEL = "stub-model"

const { startServer } = await import("../src/index.js")
const running = await startServer()
const base = `http://127.0.0.1:${running.port}`

async function post(path: string, token: string | undefined, body: Json): Promise<Json> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (response.status >= 300) throw new Error(`api-agent: POST ${path} → ${response.status} ${text}`)
  return JSON.parse(text) as Json
}
async function get(path: string, token: string): Promise<Json> {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
  return JSON.parse(await response.text()) as Json
}
async function until<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await probe()
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`api-agent: timed out waiting for ${what}`)
}

try {
  const teacher = await post("/api/users", undefined, { displayName: "Marta" })
  const student = await post("/api/users", undefined, { displayName: "Bruno" })
  const community = (await post("/api/communities", teacher.token, { name: "Neural Networks" })).community.id as string
  const invite = await post(`/api/communities/${community}/invites`, teacher.token, { role: "student", mode: "reusable" })
  await post("/api/invites/redeem", student.token, { code: invite.code })
  const channel = await post(`/api/communities/${community}/channels`, teacher.token, { name: "questions", visibility: "public" })
  await post(`/api/communities/${community}/channels/${channel.id}/join`, student.token, {})

  const created = await post(`/api/communities/${community}/agents`, teacher.token, {
    name: "Elaine", instructions: "Answer from the cards.", runtime: "api", model: "default", channelIds: [channel.id],
  })
  check(created.agent.runtime === "api", "an agent can be created to run on the server")
  check(created.agent.presence === "online", "and is online without anything being started for it")

  /* ---- First mention: it compiles ---------------------------------------- */
  const first = await post(`/api/communities/${community}/channels/${channel.id}/messages`, student.token, {
    paragraphs: [[{ kind: "text", text: "@Elaine what is backprop?" }]],
  })
  const compiledAnswer = await until("the first answer", async () => {
    const messages = await get(`/api/communities/${community}/channels/${channel.id}/messages`, teacher.token) as unknown as Json[]
    return (messages as Json[]).find((item) => item.authorKind === "agent")
  })
  check(!!compiledAnswer, "a mention is answered with no runner connected")

  const cards = await get(`/api/communities/${community}/cards`, teacher.token) as unknown as Json[]
  check((cards as Json[]).length === 1 && cards[0].path === "modules/backprop.md", "what it learned became a card")
  check(existsSync(join(scratch, "files", "agents", created.agent.id, "wiki", "modules", "backprop.md")), "and a markdown file in the agent's own folder on the server")
  check(cards[0].sourceMessageIds.includes(first.id), "the card records the message that caused it")

  const cite = (compiledAnswer.paragraphs as Json[][]).flat().find((block) => block.kind === "cite")
  check(cite?.cite?.cardId === cards[0].id, "a [[path]] citation resolves to the real card")
  check(compiledAnswer.fromFile === undefined, "an answer that compiled something new carries no seal")

  /* ---- Second mention: it composes --------------------------------------- */
  await post(`/api/communities/${community}/channels/${channel.id}/messages`, student.token, {
    paragraphs: [[{ kind: "text", text: "@Elaine I still do not follow, another way?" }]],
  })
  const composed = await until("the second answer", async () => {
    const messages = await get(`/api/communities/${community}/channels/${channel.id}/messages`, teacher.token) as unknown as Json[]
    return (messages as Json[]).filter((item) => item.authorKind === "agent")[1]
  })
  check(composed.fromFile?.cardIds?.[0] === cards[0].id, "the second question is answered from the card, and says so")
  const after = await get(`/api/communities/${community}/cards`, teacher.token) as unknown as Json[]
  check((after as Json[]).length === 1, "answering again created no duplicate card")

  /* ---- The endpoint contract ----------------------------------------------
     Everything the runtime assumes about the provider lives here. It is only
     these four things, which is what makes changing provider an .env edit. */
  check(seen.paths.length > 0 && seen.paths.every((path) => path === "/v1/chat/completions"),
    "the endpoint is called at <base>/chat/completions, with no doubled slash from a trailing one")
  check(seen.refusedJsonMode, "response_format is asked for by default")
  check(seen.jsonModes[0] === false, "and an endpoint that refuses it is retried without it rather than failing")
  check(compiled, "the answer still arrives, and still compiles its card, over that retry")

  /* ---- The credential ----------------------------------------------------- */
  check(seen.authorization === "Bearer test-key-not-a-real-credential", "the key signs the request to the endpoint")
  check(seen.prompts.every((prompt) => !prompt.includes("test-key-not-a-real-credential")), "and never appears in a prompt")
  const projections = JSON.stringify(await get(`/api/communities/${community}`, teacher.token))
  check(!projections.includes("test-key-not-a-real-credential"), "nor in any projection the client receives")
  const stored = readFileSync(join(scratch, "api.db")).toString("latin1")
  check(!stored.includes("test-key-not-a-real-credential"), "nor anywhere in the database")

  /* The second prompt has to carry the card, or "compose from the file" is a
     claim about nothing. */
  check(seen.prompts[1].includes("The chain rule, applied backwards"), "the card file is given to the model on the next question")

  console.log(`\nServer-run agent OK: ${passed} checks`)
} finally {
  await running.close()
  await new Promise<void>((resolve) => model.close(() => resolve()))
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* a temp dir is disposable */ }
}
