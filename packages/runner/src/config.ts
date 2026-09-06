import { resolve } from "node:path"
import type { Runtime } from "@elaine/protocol"

export type RunnerConfig = {
  token: string
  runtime: Runtime
  model: string
  cwd: string
  server: string
  /* Wall clock for one provider run. A model that never returns must not wedge
     the queue: the mention fails, is reported in the channel, and the next one
     proceeds. */
  timeoutMs: number
}

const USAGE = `elaine-runner

  --token   <token>            the agent's runner token (from its setup command)
  --runtime <claude|codex>     which subscription CLI to drive
  --model   <name>             optional model name, default "default"
  --cwd     <path>             the agent's folder (its wiki lives here)
  --server  <url>              the community server, default http://localhost:8787
  --timeout <seconds>          per-mention provider timeout, default 300
`

export function parseArgs(argv: readonly string[]): RunnerConfig {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) continue
    const [flag, inline] = arg.slice(2).split("=", 2)
    values.set(flag, inline ?? argv[++index] ?? "")
  }
  if (values.has("help")) {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  const token = values.get("token") ?? process.env.ELAINE_RUNNER_TOKEN ?? ""
  if (!token) throw new Error("a runner token is required: --token <token>")
  const runtime = (values.get("runtime") ?? "claude") as Runtime
  if (runtime !== "claude" && runtime !== "codex") throw new Error(`unknown runtime "${runtime}" (expected claude or codex)`)
  const timeoutSeconds = Number(values.get("timeout") ?? 300)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("--timeout must be a positive number of seconds")

  return {
    token,
    runtime,
    model: values.get("model") ?? "default",
    cwd: resolve(values.get("cwd") ?? process.cwd()),
    server: (values.get("server") ?? process.env.ELAINE_SERVER ?? "http://localhost:8787").replace(/\/+$/, ""),
    timeoutMs: timeoutSeconds * 1_000,
  }
}

/* The token is the one secret this process holds. It belongs in the first
   WebSocket frame and nowhere else — not in a URL, a log line, or a prompt. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]")
  }
  return out
}
