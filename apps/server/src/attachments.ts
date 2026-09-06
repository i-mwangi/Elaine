/* Attachments, ported from the old repo's `workspace-attachments.ts`.

   Bytes live on disk; only metadata lives in the database. Two rules carry most
   of the safety:

   - A stored path is always re-resolved through the root guard before it is
     read, written, or removed. A name that came from a browser must never be
     able to address a file outside the store.
   - Bytes are written FIRST with an exclusive flag, then the row is inserted.
     If the insert fails the file is removed, so a file can never outlive the
     row that describes it. */
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { type Row, fail, now, text } from "./db.js"

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_NAME_BYTES = 255
const MAX_MIME_BYTES = 255

export type Attachment = {
  id: string
  communityId: string
  channelId: string
  uploaderId: string
  name: string
  mime: string
  size: number
  createdAt: string
  messageId?: string
}

/* Where the bytes go. Beside the database by default, so a throwaway database
   in a temp directory takes its files with it. */
export function attachmentsRoot(): string {
  if (process.env.ELAINE_FILES) return resolve(process.env.ELAINE_FILES)
  return resolve(dirname(process.env.ELAINE_DB ?? "elaine.db"), "files")
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8")

function truncateUtf8(value: string, maximumBytes: number): string {
  let output = ""
  for (const character of value) {
    if (byteLength(output + character) > maximumBytes) break
    output += character
  }
  return output
}

function replaceControlCharacters(value: string): string {
  let output = ""
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    output += codePoint < 32 || codePoint === 127 ? "-" : character
  }
  return output
}

/** One safe, non-empty path segment from an identifier. */
export function sanitizeSegment(value: string): string {
  const cleaned = value.normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+/, "")
    .replace(/-+/g, "-")
  return cleaned && cleaned !== "." && cleaned !== ".." ? truncateUtf8(cleaned, 120) : "channel"
}

/** Sanitize only the on-disk name; the original stays as metadata. */
export function sanitizeDisplayName(name: string): string {
  const cleaned = name.normalize("NFKC")
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+/, "")
  return truncateUtf8(replaceControlCharacters(cleaned || "file"), 200) || "file"
}

export function validateUpload(input: { name: string; mime: string; bytes: Uint8Array }): void {
  if (!input.name.trim()) fail("invalid_input", "A file needs a name")
  if (input.name.includes("\0")) fail("invalid_input", "That file name contains a NUL byte")
  if (byteLength(input.name) > MAX_NAME_BYTES) fail("invalid_input", `A file name may be at most ${MAX_NAME_BYTES} bytes`)
  if (!input.mime.trim()) fail("invalid_input", "A file needs a content type")
  if (input.mime.includes("\0")) fail("invalid_input", "That content type contains a NUL byte")
  if (byteLength(input.mime) > MAX_MIME_BYTES) fail("invalid_input", `A content type may be at most ${MAX_MIME_BYTES} bytes`)
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    fail("invalid_input", `That file is ${input.bytes.byteLength} bytes; the limit is ${MAX_ATTACHMENT_BYTES}`)
  }
}

const storagePathFor = (communityId: string, channelId: string, id: string, name: string): string =>
  join(sanitizeSegment(communityId), sanitizeSegment(channelId), `${id}-${sanitizeDisplayName(name)}`)

/** Resolve a stored relative path, refusing anything that escapes the root. */
export function resolveStoragePath(root: string, storagePath: string): string {
  if (!storagePath || storagePath.includes("\0")) fail("invalid_input", "Invalid attachment path")
  const base = resolve(root)
  const absolute = resolve(base, storagePath)
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  if (absolute !== base && !absolute.startsWith(prefix)) fail("invalid_input", "That attachment path escapes the file store")
  return absolute
}

const fromRow = (row: Row): Attachment => ({
  id: text(row.id), communityId: text(row.community_id), channelId: text(row.channel_id),
  uploaderId: text(row.uploader_id), name: text(row.name), mime: text(row.mime),
  size: Number(row.size ?? 0), createdAt: text(row.created_at),
  ...(text(row.message_id) ? { messageId: text(row.message_id) } : {}),
})

export function attachmentById(database: DatabaseSync, communityId: string, attachmentId: string): Attachment | undefined {
  const row = database.prepare("SELECT * FROM attachments WHERE id = ? AND community_id = ?").get(attachmentId, communityId) as Row | undefined
  return row ? fromRow(row) : undefined
}

/** Attachments already fixed to a message, for projecting it. */
export function attachmentsForMessages(database: DatabaseSync, communityId: string, channelId: string): Map<string, Attachment[]> {
  const rows = database.prepare(`SELECT * FROM attachments WHERE community_id = ? AND channel_id = ? AND message_id IS NOT NULL
    ORDER BY created_at`).all(communityId, channelId) as Row[]
  const out = new Map<string, Attachment[]>()
  for (const row of rows) {
    const attachment = fromRow(row)
    const list = out.get(attachment.messageId ?? "") ?? []
    list.push(attachment)
    out.set(attachment.messageId ?? "", list)
  }
  return out
}

export function storeAttachment(database: DatabaseSync, root: string, input: {
  communityId: string; channelId: string; uploaderId: string; name: string; mime: string; bytes: Uint8Array
}): Attachment {
  validateUpload(input)
  const id = `attachment-${randomUUID()}`
  const storagePath = storagePathFor(input.communityId, input.channelId, id, input.name)
  const absolute = resolveStoragePath(root, storagePath)
  const bytes = Buffer.from(input.bytes)
  const createdAt = now()

  mkdirSync(dirname(absolute), { recursive: true })
  /* "wx" fails rather than overwriting: a colliding id must never silently
     replace someone else's file. */
  writeFileSync(absolute, bytes, { flag: "wx" })
  try {
    database.prepare(`INSERT INTO attachments (id, community_id, channel_id, uploader_id, message_id, name, mime, size, storage_path, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
      .run(id, input.communityId, input.channelId, input.uploaderId, input.name, input.mime, bytes.byteLength, storagePath, createdAt)
  } catch (error) {
    /* Resolve again rather than trusting the path from above: every filesystem
       operation goes through the same guard. */
    try { unlinkSync(resolveStoragePath(root, storagePath)) } catch { /* keep the original error */ }
    throw error
  }
  return {
    id, communityId: input.communityId, channelId: input.channelId, uploaderId: input.uploaderId,
    name: input.name, mime: input.mime, size: bytes.byteLength, createdAt,
  }
}

export function readAttachment(database: DatabaseSync, root: string, communityId: string, attachmentId: string): { attachment: Attachment; bytes: Buffer } {
  const row = database.prepare("SELECT * FROM attachments WHERE id = ? AND community_id = ?").get(attachmentId, communityId) as Row | undefined
  if (!row) fail("not_found", "That file does not exist")
  const attachment = fromRow(row)
  const absolute = resolveStoragePath(root, text(row.storage_path))
  let bytes: Buffer
  try {
    bytes = readFileSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("not_found", "That file's bytes are missing")
    throw error
  }
  /* Metadata and bytes disagreeing means something changed the store behind our
     back; serving it anyway would hand out a file we cannot describe. */
  if (bytes.byteLength !== attachment.size) fail("conflict", "That file no longer matches its record")
  return { attachment, bytes }
}

/** Only an unattached file can be removed, by its uploader or a teacher. */
export function deleteAttachment(database: DatabaseSync, root: string, communityId: string, attachmentId: string, actorId: string, actorIsTeacher: boolean): Attachment {
  const row = database.prepare("SELECT * FROM attachments WHERE id = ? AND community_id = ?").get(attachmentId, communityId) as Row | undefined
  if (!row) fail("not_found", "That file does not exist")
  const attachment = fromRow(row)
  /* Once a file is part of a message, removing it would leave the message
     pointing at nothing. Delete the message instead. */
  if (attachment.messageId) fail("conflict", "A file that has been posted cannot be removed on its own")
  if (!actorIsTeacher && attachment.uploaderId !== actorId) fail("forbidden", "Only the uploader or a teacher can remove this file")

  const absolute = resolveStoragePath(root, text(row.storage_path))
  if (!existsSync(absolute)) fail("not_found", "That file's bytes are missing")
  const bytes = readFileSync(absolute)
  let removed = false
  database.exec("BEGIN IMMEDIATE")
  try {
    unlinkSync(absolute)
    removed = true
    const result = database.prepare("DELETE FROM attachments WHERE id = ? AND message_id IS NULL").run(attachmentId) as { changes?: number | bigint }
    if (Number(result.changes ?? 0) !== 1) fail("conflict", "That file was posted while it was being removed")
    database.exec("COMMIT")
  } catch (error) {
    try { database.exec("ROLLBACK") } catch { /* keep the original error */ }
    /* Best effort: if the row survived, put its bytes back. */
    if (removed && !existsSync(absolute)) {
      try { writeFileSync(absolute, bytes, { flag: "wx" }) } catch { /* keep the original error */ }
    }
    throw error
  }
  return attachment
}

/* Ported from `ensureAttachmentReferences`: a file may be posted once, into the
   channel it was uploaded to, by the person who uploaded it or a teacher. */
export function claimAttachments(database: DatabaseSync, communityId: string, channelId: string, actorId: string, actorIsTeacher: boolean, attachmentIds: readonly string[], messageId: string): void {
  for (const attachmentId of [...new Set(attachmentIds)]) {
    const attachment = attachmentById(database, communityId, attachmentId)
    if (!attachment) fail("not_found", `That file does not exist: ${attachmentId}`)
    if (attachment.channelId !== channelId) fail("forbidden", "That file belongs to another channel")
    if (attachment.messageId) fail("conflict", "A file can only be posted once")
    if (!actorIsTeacher && attachment.uploaderId !== actorId) fail("forbidden", "Only the uploader or a teacher can post this file")
  }
  for (const attachmentId of [...new Set(attachmentIds)]) {
    database.prepare("UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL").run(messageId, attachmentId)
  }
}
