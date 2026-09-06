/* The provider adapters, ported from the old repo's `runtimes/providers.ts`.

   Elaine never receives a provider credential. The runner executes the user's
   own unmodified `claude` or `codex` binary, already signed in to their
   subscription, and hands it the prompt on stdin. Several properties are
   enforced here rather than documented:

   - Provider API keys are STRIPPED from the child environment, so a key that
     happens to be set cannot bill an account the user did not choose to spend.
   - Elaine's own transport secret never reaches the child, and is redacted from
     anything the child prints back.
   - The model gets a bounded tool set and a workspace-scoped sandbox: it may
     write inside the agent folder and nowhere else.
   - Output is bounded, so a runaway provider cannot exhaust this process. */
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Runtime } from "@elaine/protocol"
import { redact } from "./config.js"

export type RunOptions = {
  runtime: Runtime
  model: string
  cwd: string
  prompt: string
  timeoutMs: number
  secrets: readonly string[]
}

/* A long answer is legitimate; an unbounded one is a memory leak. */
const MAX_STDOUT = 4 * 1024 * 1024
const MAX_STDERR = 64 * 1024

export type ProviderFailure = "missing_binary" | "auth" | "timeout" | "exit" | "invalid_output"

export class ProviderError extends Error {
  constructor(message: string, readonly code: ProviderFailure) {
    super(message)
    this.name = "ProviderError"
  }
}

/* Keys for the providers we drive. Removing them forces the CLI onto its own
   subscription login instead of silently metering an API account. */
const PROVIDER_KEY_VARS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORGANIZATION",
]

/* Session markers that would make the child think it is a nested agent run. */
const SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_CI", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_MANAGED_BY_NPM"]

/* The runner's own Node setup must not leak into the provider. If this process
   was started through a loader (`NODE_OPTIONS=--import tsx`, ts-node, a custom
   NODE_PATH), the child would inherit it and try to resolve that loader from
   the AGENT folder, which is deliberately outside this repository and has no
   node_modules. The provider CLI is a separate program and gets a clean Node
   environment. */
const RUNNER_NODE_VARS = ["NODE_OPTIONS", "NODE_PATH"]

function childEnvironment(secrets: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [...PROVIDER_KEY_VARS, ...SESSION_VARS, ...RUNNER_NODE_VARS]) delete env[key]
  for (const key of Object.keys(env)) {
    if (key.startsWith("ELAINE_")) delete env[key]
    else if (secrets.some((secret) => secret.length >= 8 && env[key]?.includes(secret))) delete env[key]
  }
  return env
}

/* `ELAINE_CLAUDE_BIN` / `ELAINE_CODEX_BIN` override the command. A value
   starting with "[" is parsed as a JSON argv array, so a wrapper such as
   ["node", "/path/to/stub.mjs"] can be given unambiguously. */
function command(runtime: Runtime): string[] {
  const override = process.env[runtime === "claude" ? "ELAINE_CLAUDE_BIN" : "ELAINE_CODEX_BIN"]
  if (override?.trim().startsWith("[")) return JSON.parse(override) as string[]
  if (override) return [override]
  return [runtime]
}

const commandHint = (runtime: Runtime): string =>
  runtime === "codex"
    ? "Run `codex login` in this terminal, then start the runner again."
    : "Run `claude` in this terminal to finish sign-in, then start the runner again."

const authFailure = (runtime: Runtime, text: string): boolean =>
  runtime === "codex"
    ? /(not logged in|not authenticated|run\s+codex\s+login|authentication required|login required|unauthorized)/i.test(text)
    : /(not logged in|not authenticated|authentication required|login required|unauthorized|could not authenticate)/i.test(text)

function boundedAppend(current: string, chunk: Buffer, limit: number): string {
  if (current.length >= limit) return current
  return (current + chunk.toString("utf8")).slice(0, limit)
}

type ChildResult = { code: number | null; stdout: string; stderr: string }

function runChild(binary: string, args: readonly string[], options: RunOptions): Promise<ChildResult> {
  /* On Windows the real CLIs are `.cmd` shims, which CreateProcess cannot
     execute directly — spawning them without a shell fails with EFTYPE. The
     prompt travels on stdin, never in argv, so the shell sees no model output. */
  const useShell = process.platform === "win32" && !/\.(exe)$/i.test(binary)

  return new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      env: childEnvironment(options.secrets),
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
      windowsHide: true,
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined

    /* Ask first, then insist: SIGTERM lets the CLI close its own session before
       SIGKILL takes the process away. */
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500)
    }, options.timeoutMs)

    child.stdout.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk, MAX_STDOUT) })
    child.stderr.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk, MAX_STDERR) })

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (error.code === "ENOENT") {
        reject(new ProviderError(`${options.runtime} executable "${binary}" was not found on PATH. ${commandHint(options.runtime)}`, "missing_binary"))
        return
      }
      reject(new ProviderError(`${options.runtime} could not start: ${redact(error.message, options.secrets)}`, "exit"))
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (timedOut) {
        reject(new ProviderError(`${options.runtime} took longer than ${Math.ceil(options.timeoutMs / 1_000)} seconds and was stopped.`, "timeout"))
        return
      }
      resolve({ code, stdout, stderr })
    })

    /* Prompts are assembled from server messages and local files. Redact at this
       final boundary too, so an accidentally pasted bearer cannot reach a child. */
    child.stdin.end(redact(options.prompt, options.secrets))
  })
}

function nonZeroError(result: ChildResult, options: RunOptions): ProviderError {
  const detail = redact(`${result.stderr}\n${result.stdout}`.trim(), options.secrets).slice(0, 1_200)
  if (authFailure(options.runtime, detail)) return new ProviderError(`${options.runtime} is not signed in. ${commandHint(options.runtime)}`, "auth")
  return new ProviderError(`${options.runtime} exited with code ${result.code ?? "unknown"}${detail ? `: ${detail}` : "."}`, "exit")
}

function claudeAnswer(raw: string, options: RunOptions): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new ProviderError("claude returned an empty answer.", "invalid_output")
  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown; is_error?: unknown; error?: unknown }
    if (parsed.is_error) {
      const detail = typeof parsed.error === "string" ? parsed.error : typeof parsed.result === "string" ? parsed.result : "provider error"
      if (authFailure("claude", detail)) throw new ProviderError(`claude is not signed in. ${commandHint("claude")}`, "auth")
      throw new ProviderError(`claude reported an error: ${redact(detail, options.secrets).slice(0, 1_200)}`, "exit")
    }
    if (typeof parsed.result === "string" && parsed.result.trim()) return parsed.result.trim()
  } catch (error) {
    if (error instanceof ProviderError) throw error
    /* Older versions emit plain text despite --output-format json. */
  }
  return trimmed
}

async function runClaude(options: RunOptions): Promise<string> {
  const [binary, ...prefix] = command("claude")
  const args = [
    ...prefix,
    "-p",
    "--output-format", "json",
    /* Writing cards into its own folder is the agent's whole job, so edits are
       accepted without a prompt — and the tool list is what bounds that. */
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read,Write,Edit,MultiEdit,Glob,Grep",
  ]
  if (options.model && options.model !== "default") args.push("--model", options.model)
  const result = await runChild(binary, args, options)
  if (result.code !== 0) throw nonZeroError(result, options)
  return claudeAnswer(result.stdout, options)
}

async function runCodex(options: RunOptions): Promise<string> {
  const outputDir = await mkdtemp(join(tmpdir(), "elaine-codex-output-"))
  const outputPath = join(outputDir, "last-message.txt")
  try {
    const [binary, ...prefix] = command("codex")
    const args = [
      ...prefix,
      "exec",
      "--cd", options.cwd,
      "--sandbox", "workspace-write",
      "--ephemeral",
      "--skip-git-repo-check",
      "--output-last-message", outputPath,
    ]
    if (options.model && options.model !== "default") args.push("--model", options.model)
    /* There is deliberately no --add-dir here. Codex treats additional roots as
       writable, and every model write belongs inside the agent workspace. */
    const result = await runChild(binary, args, options)
    if (result.code !== 0) throw nonZeroError(result, options)
    let answer = ""
    try { answer = (await readFile(outputPath, "utf8")).trim() } catch { /* older or stubbed CLIs only print */ }
    if (!answer) answer = result.stdout.trim()
    if (!answer) throw new ProviderError("codex returned an empty answer.", "invalid_output")
    return answer
  } finally {
    await rm(outputDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function runProvider(options: RunOptions): Promise<string> {
  return options.runtime === "claude" ? runClaude(options) : runCodex(options)
}

export const providerLimits = { maxStdout: MAX_STDOUT, maxStderr: MAX_STDERR }
