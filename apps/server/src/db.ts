import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

const here = dirname(fileURLToPath(import.meta.url))

export type Row = Record<string, unknown>

/* A .env beside the project, read once at boot. No dependency: the format we
   need is KEY=VALUE, and anything already in the environment wins so a real
   deployment's variables are never overwritten by a file. */
export function loadEnvFile(file = ".env"): void {
  /* Searched upward from the working directory: the server is started both from
     the repository root (`npm run start`) and from its own workspace folder
     (`npm run dev`), and one .env at the root has to serve both. */
  let contents: string | undefined
  let directory = resolve(".")
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      contents = readFileSync(join(directory, file), "utf8")
      break
    } catch {
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  if (contents === undefined) return
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const separator = trimmed.indexOf("=")
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    if (process.env[key] !== undefined) continue
    let value = trimmed.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

export type ApiConfig = { baseUrl: string; key: string; model: string }

/* The model endpoint, described only by environment variables so that changing
   provider is an env change and the codebase never names one. Absent when it
   is not configured, which is how the rest of the server asks "can I answer?". */
export function apiConfig(): ApiConfig | undefined {
  const baseUrl = process.env.ELAINE_API_BASE_URL?.trim()
  const key = process.env.ELAINE_API_KEY?.trim()
  const model = process.env.ELAINE_API_MODEL?.trim()
  if (!baseUrl || !key || !model) return undefined
  return { baseUrl: baseUrl.replace(/\/+$/, ""), key, model }
}

export function openDatabase(file: string): DatabaseSync {
  const database = new DatabaseSync(file)
  database.exec("PRAGMA journal_mode = WAL")
  database.exec("PRAGMA foreign_keys = ON")
  /* The schema is idempotent (`CREATE TABLE IF NOT EXISTS`), so an existing
     database upgrades on boot without needing a seed or a manual migration. */
  database.exec(readFileSync(join(here, "schema.sql"), "utf8"))
  addColumn(database, "channels", "archived_at", "TEXT")
  addColumn(database, "messages", "client_id", "TEXT")
  addColumn(database, "messages", "deleted_by", "TEXT")
  widenAgentRuntimes(database)
  /* Idempotency is a constraint, not a convention: two sends carrying the same
     client id from the same author cannot both become rows, even in a race. */
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS messages_client ON messages(community_id, author_id, client_id) WHERE client_id IS NOT NULL")
  enforceAgentNames(database)
  return database
}

/* Agent names are unique per community, case-insensitively, because a mention
   matches on the complete name and two active "Ada"s would wake both.

   The index lives here rather than in schema.sql on purpose: a database written
   before this rule can already hold duplicates, and a failed CREATE INDEX
   inside the schema exec would abort every statement after it and leave the
   server unable to boot. Instead the constraint is applied where it can be, and
   a database that cannot take it is reported precisely — the duplicates are
   named — while `createAgent` refuses new collisions either way. */
/* `CREATE TABLE IF NOT EXISTS` covers new tables but never a new column on an
   existing one, so a database written before a field existed would silently
   lack it. This is the smallest migration primitive that fixes that: add the
   column if the table does not already have it. */
function addColumn(database: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Row[]
  if (columns.some((row) => str(row.name) === column)) return
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/* A CHECK constraint cannot be altered in SQLite, only rebuilt. A database
   written before `api` existed would reject every agent using it, so the table
   is copied through a wider definition — and only when it actually needs it. */
function widenAgentRuntimes(database: DatabaseSync): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get() as Row | undefined
  const definition = str(row?.sql) ?? ""
  if (!definition || definition.includes("'api'")) return
  database.exec("PRAGMA foreign_keys = OFF")
  try {
    transaction(database, () => {
      database.exec(definition.replace("CREATE TABLE agents", "CREATE TABLE agents_rebuilt").replace("'claude', 'codex'", "'claude', 'codex', 'api'"))
      database.exec("INSERT INTO agents_rebuilt SELECT * FROM agents")
      database.exec("DROP TABLE agents")
      database.exec("ALTER TABLE agents_rebuilt RENAME TO agents")
      database.exec("CREATE INDEX IF NOT EXISTS agents_community ON agents(community_id)")
    })
  } finally {
    database.exec("PRAGMA foreign_keys = ON")
  }
}

function enforceAgentNames(database: DatabaseSync): void {
  try {
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS agents_name_per_community ON agents(community_id, lower(name)) WHERE status != 'deleted'")
  } catch {
    const clashes = database.prepare(`SELECT community_id, lower(name) AS name, COUNT(*) AS count FROM agents
      WHERE status != 'deleted' GROUP BY community_id, lower(name) HAVING count > 1`).all() as Row[]
    const detail = clashes.map((row) => `"${String(row.name)}" x${String(row.count)} in ${String(row.community_id)}`).join(", ")
    console.warn(`[elaine] agent names are not yet unique per community (${detail || "unknown duplicates"}). Rename or delete the duplicates; new agents with a taken name are already refused.`)
  }
}

export const now = (): string => new Date().toISOString()
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
export const text = (value: unknown): string => str(value) ?? ""

/* Tokens are compared by digest. Elaine stores the digest, never the token. */
export const mintToken = (): string => randomBytes(32).toString("base64url")
export const digest = (token: string): string => createHash("sha256").update(token).digest("hex")

export function transaction<T>(database: DatabaseSync, run: () => T): T {
  database.exec("BEGIN")
  try {
    const result = run()
    database.exec("COMMIT")
    return result
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

export type FailureCode = "invalid_input" | "unauthorized" | "forbidden" | "not_found" | "conflict"
export class ApiError extends Error {
  constructor(readonly code: FailureCode, message: string) {
    super(message)
  }
}
export function fail(code: FailureCode, message: string): never {
  throw new ApiError(code, message)
}
/* Literal union rather than `number`, so the HTTP layer keeps its narrow
   status type instead of widening it at the error handler. */
export const statusFor = (code: FailureCode): 400 | 401 | 403 | 404 | 409 =>
  ({ invalid_input: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409 } as const)[code]
