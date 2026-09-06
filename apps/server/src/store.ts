/* The domain. Every function here takes a communityId and an actor, and proves
   the actor may act before it touches a row: authorization is not a middleware
   concern that can be forgotten at one call site. */
import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { Agent, Card, CardType, Channel, ChannelSummary, Community, FromFile, Member, Message, Paragraphs, Presence, Reaction, Role, Runtime, Session, Thread, User, Workspace } from "@elaine/protocol"
import { type Row, apiConfig, digest, fail, mintToken, now, str, text, transaction } from "./db.js"
import { attachmentsForMessages, claimAttachments } from "./attachments.js"

/* ---- Row mappers ------------------------------------------------------------ */

const userFromRow = (row: Row): User => ({ id: text(row.id), displayName: text(row.display_name), createdAt: text(row.created_at) })

const communityFromRow = (row: Row): Community => ({
  id: text(row.id), name: text(row.name), ...(str(row.term) ? { term: text(row.term) } : {}), createdAt: text(row.created_at),
})

const memberFromRow = (row: Row): Member => ({
  userId: text(row.user_id), communityId: text(row.community_id), displayName: text(row.display_name),
  role: text(row.role) as Role, joinedAt: text(row.joined_at),
})

const channelFromRow = (row: Row): Channel => ({
  id: text(row.id), communityId: text(row.community_id), name: text(row.name),
  kind: text(row.kind) as Channel["kind"], visibility: text(row.visibility) as Channel["visibility"],
  ...(str(row.user_id) ? { userId: text(row.user_id) } : {}),
  ...(str(row.agent_id) ? { agentId: text(row.agent_id) } : {}),
  ...(str(row.archived_at) ? { archivedAt: text(row.archived_at) } : {}),
  createdAt: text(row.created_at),
})

const cardFromRow = (row: Row): Card => {
  let sourceMessageIds: string[] = []
  try { sourceMessageIds = JSON.parse(text(row.source_message_ids) || "[]") as string[] } catch { sourceMessageIds = [] }
  return {
    id: text(row.id), communityId: text(row.community_id), agentId: text(row.agent_id), channelId: text(row.channel_id),
    path: text(row.path), title: text(row.title), type: text(row.type) as CardType, body: text(row.body),
    version: Number(row.version ?? 1), ...(str(row.replaces) ? { replaces: text(row.replaces) } : {}),
    sourceMessageIds, createdAt: text(row.created_at),
  }
}

/* The seal is stored inside the message body JSON rather than in its own
   column: it is written once, read with the message, and never queried alone. */
function fromFileFromBody(body: Record<string, unknown>): FromFile | undefined {
  const raw = body.fromFile as { cardIds?: unknown; oldestAgo?: unknown } | undefined
  if (!raw || typeof raw !== "object") return undefined
  const cardIds = Array.isArray(raw.cardIds) ? raw.cardIds.filter((id): id is string => typeof id === "string") : []
  if (!cardIds.length) return undefined
  const oldestAgo = typeof raw.oldestAgo === "number" && Number.isFinite(raw.oldestAgo) ? Math.max(0, Math.trunc(raw.oldestAgo)) : 0
  return { cardIds, oldestAgo }
}

function messageFromRow(row: Row): Message {
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text(row.body) || "{}") as Record<string, unknown> } catch { body = {} }
  const deletedAt = str(row.deleted_at)
  const paragraphs = (deletedAt ? [[{ kind: "text", text: "" }]] : body.paragraphs) as Paragraphs
  const fromFile = deletedAt ? undefined : fromFileFromBody(body)
  return {
    id: text(row.id), communityId: text(row.community_id), channelId: text(row.channel_id),
    authorId: text(row.author_id), authorKind: text(row.author_kind) as Message["authorKind"],
    paragraphs: paragraphs?.length ? paragraphs : [[{ kind: "text", text: "" }]],
    ...(fromFile ? { fromFile } : {}),
    ...(str(row.thread_id) ? { threadId: text(row.thread_id) } : {}),
    ...(str(row.client_id) ? { clientId: text(row.client_id) } : {}),
    at: text(row.created_at),
    ...(str(row.edited_at) ? { editedAt: text(row.edited_at) } : {}),
    ...(deletedAt ? { deletedAt, ...(str(row.deleted_by) ? { deletedBy: text(row.deleted_by) } : {}) } : {}),
  }
}

/* ---- Identity --------------------------------------------------------------- */

export function createUser(database: DatabaseSync, displayName: string): { user: User; token: string } {
  const token = mintToken()
  const id = `user-${randomUUID()}`
  const at = now()
  database.prepare("INSERT INTO users (id, display_name, token_digest, created_at) VALUES (?, ?, ?, ?)").run(id, displayName, digest(token), at)
  return { user: { id, displayName, createdAt: at }, token }
}

export function userForToken(database: DatabaseSync, token: string): User | undefined {
  const row = database.prepare("SELECT * FROM users WHERE token_digest = ?").get(digest(token)) as Row | undefined
  return row ? userFromRow(row) : undefined
}

export function agentForRunnerToken(database: DatabaseSync, token: string): Row | undefined {
  return database.prepare("SELECT * FROM agents WHERE runner_token_digest = ? AND status = 'active'").get(digest(token)) as Row | undefined
}

/* ---- Membership ------------------------------------------------------------- */

function membershipRow(database: DatabaseSync, communityId: string, userId: string): Row {
  const row = database.prepare("SELECT * FROM memberships WHERE community_id = ? AND user_id = ?").get(communityId, userId) as Row | undefined
  /* Not-found rather than forbidden: a non-member must not learn that a
     community exists by the shape of the error. */
  if (!row) fail("forbidden", "You are not a member of this community")
  return row
}

export const roleIn = (database: DatabaseSync, communityId: string, userId: string): Role => text(membershipRow(database, communityId, userId).role) as Role

function requireTeacher(database: DatabaseSync, communityId: string, userId: string): void {
  if (roleIn(database, communityId, userId) !== "teacher") fail("forbidden", "Only a teacher can do this")
}

export function createCommunity(database: DatabaseSync, actor: User, input: { name: string; term?: string }): { community: Community; role: Role } {
  const id = `community-${randomUUID()}`
  const at = now()
  return transaction(database, () => {
    database.prepare("INSERT INTO communities (id, name, term, created_at) VALUES (?, ?, ?, ?)").run(id, input.name, input.term ?? null, at)
    /* Whoever creates a community teaches in it. Role is per membership, so
       this says nothing about their role anywhere else. */
    database.prepare("INSERT INTO memberships (community_id, user_id, role, joined_at) VALUES (?, ?, 'teacher', ?)").run(id, actor.id, at)
    return { community: { id, name: input.name, ...(input.term ? { term: input.term } : {}), createdAt: at }, role: "teacher" as Role }
  })
}

/* Ported from `updateTenantCommunity`: a teacher edits the name or the term,
   each falling back to what is already there, and the name may not end up
   empty — a community with no name cannot be told apart in the picker. */
export function updateCommunity(database: DatabaseSync, communityId: string, actor: User, input: { name?: string; term?: string }): Community {
  requireTeacher(database, communityId, actor.id)
  const current = database.prepare("SELECT * FROM communities WHERE id = ?").get(communityId) as Row | undefined
  if (!current) fail("not_found", "Community does not exist")
  const name = input.name?.trim() || text(current.name)
  if (!name) fail("invalid_input", "A community needs a name")
  const term = input.term === undefined ? str(current.term) : (input.term.trim() || undefined)
  database.prepare("UPDATE communities SET name = ?, term = ? WHERE id = ?").run(name, term ?? null, communityId)
  return communityFromRow(database.prepare("SELECT * FROM communities WHERE id = ?").get(communityId) as Row)
}

/* The communities this user belongs to, with their role in each. */
export function listCommunities(database: DatabaseSync, user: User): { community: Community; role: Role }[] {
  return session(database, user).communities
}

export function session(database: DatabaseSync, user: User): Session {
  const rows = database.prepare(`SELECT c.*, m.role AS member_role FROM memberships m
    JOIN communities c ON c.id = m.community_id WHERE m.user_id = ? ORDER BY m.joined_at`).all(user.id) as Row[]
  return { user, communities: rows.map((row) => ({ community: communityFromRow(row), role: text(row.member_role) as Role })) }
}

export function createInvite(database: DatabaseSync, communityId: string, actor: User, input: { role: Role; mode: "single-use" | "reusable"; maxUses?: number }): { code: string; role: Role; maxUses: number } {
  requireTeacher(database, communityId, actor.id)
  /* Invites are codes, not emails: no mail provider, and a teacher can read one
     out loud in a classroom. */
  const code = mintToken().slice(0, 10).toUpperCase()
  const maxUses = input.mode === "single-use" ? 1 : (input.maxUses ?? 1_000)
  database.prepare("INSERT INTO invites (code, community_id, role, max_uses, uses, created_by, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
    .run(code, communityId, input.role, maxUses, actor.id, now())
  return { code, role: input.role, maxUses }
}

export function redeemInvite(database: DatabaseSync, actor: User, code: string): { community: Community; role: Role } {
  return transaction(database, () => {
    const invite = database.prepare("SELECT * FROM invites WHERE code = ?").get(code) as Row | undefined
    if (!invite) fail("not_found", "That invite code does not exist")
    const communityId = text(invite.community_id)
    const existing = database.prepare("SELECT * FROM memberships WHERE community_id = ? AND user_id = ?").get(communityId, actor.id) as Row | undefined
    /* Redeeming twice is idempotent for the same person and does not burn a use. */
    if (existing) {
      const row = database.prepare("SELECT * FROM communities WHERE id = ?").get(communityId) as Row
      return { community: communityFromRow(row), role: text(existing.role) as Role }
    }
    if (Number(invite.uses ?? 0) >= Number(invite.max_uses ?? 1)) fail("conflict", "That invite has already been used")
    const at = now()
    const role = text(invite.role) as Role
    database.prepare("INSERT INTO memberships (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)").run(communityId, actor.id, role, at)
    database.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?").run(code)
    const row = database.prepare("SELECT * FROM communities WHERE id = ?").get(communityId) as Row
    return { community: communityFromRow(row), role }
  })
}

/* A community without a teacher cannot be administered: nobody could create a
   channel, invite anyone, or undo the change. So the last teacher can neither
   be demoted, removed, nor walk out — they have to hand the role over first.
   `exclude` is the member the caller is about to change. */
function otherTeachers(database: DatabaseSync, communityId: string, exclude: string): number {
  const row = database.prepare("SELECT COUNT(*) AS count FROM memberships WHERE community_id = ? AND role = 'teacher' AND user_id != ?").get(communityId, exclude) as Row
  return Number(row.count ?? 0)
}

function memberOf(database: DatabaseSync, communityId: string, userId: string): Member {
  const row = database.prepare(`SELECT m.*, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.community_id = ? AND m.user_id = ?`).get(communityId, userId) as Row | undefined
  if (!row) fail("not_found", "That person is not a member of this community")
  return memberFromRow(row)
}

export function updateMemberRole(database: DatabaseSync, communityId: string, actor: User, userId: string, role: Role): Member {
  requireTeacher(database, communityId, actor.id)
  const member = memberOf(database, communityId, userId)
  if (member.role === role) return member
  if (member.role === "teacher" && otherTeachers(database, communityId, userId) === 0) {
    fail("conflict", "This is the only teacher. Make someone else a teacher first.")
  }
  database.prepare("UPDATE memberships SET role = ? WHERE community_id = ? AND user_id = ?").run(role, communityId, userId)
  return memberOf(database, communityId, userId)
}

export function removeMember(database: DatabaseSync, communityId: string, actor: User, userId: string): Member {
  requireTeacher(database, communityId, actor.id)
  const member = memberOf(database, communityId, userId)
  if (member.role === "teacher" && otherTeachers(database, communityId, userId) === 0) {
    fail("conflict", "This is the only teacher. Make someone else a teacher first.")
  }
  return transaction(database, () => {
    /* Their messages and cards stay: the group's record of what was said is not
       the same thing as their access to it. Only the membership and the channel
       seats go. */
    database.prepare("DELETE FROM channel_members WHERE member_id = ? AND member_kind = 'user' AND channel_id IN (SELECT id FROM channels WHERE community_id = ?)").run(userId, communityId)
    database.prepare("DELETE FROM memberships WHERE community_id = ? AND user_id = ?").run(communityId, userId)
    return member
  })
}

export function leaveCommunity(database: DatabaseSync, communityId: string, actor: User): Member {
  const member = memberOf(database, communityId, actor.id)
  if (member.role === "teacher" && otherTeachers(database, communityId, actor.id) === 0) {
    fail("conflict", "You are the only teacher. Make someone else a teacher before leaving.")
  }
  return transaction(database, () => {
    database.prepare("DELETE FROM channel_members WHERE member_id = ? AND member_kind = 'user' AND channel_id IN (SELECT id FROM channels WHERE community_id = ?)").run(actor.id, communityId)
    database.prepare("DELETE FROM memberships WHERE community_id = ? AND user_id = ?").run(communityId, actor.id)
    return member
  })
}

export function listMembers(database: DatabaseSync, communityId: string, actor: User): Member[] {
  membershipRow(database, communityId, actor.id)
  const rows = database.prepare(`SELECT m.*, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.community_id = ? ORDER BY m.joined_at`).all(communityId) as Row[]
  return rows.map(memberFromRow)
}

/* ---- Channels --------------------------------------------------------------- */

/* Permissions are membership composition: if a channel is not mounted for you,
   it does not exist for you. A teacher reads what the agents they created write,
   which is why a dm is readable by its pair and by that agent's creator. */
export function canReadChannel(database: DatabaseSync, communityId: string, channelId: string, userId: string): boolean {
  const channel = database.prepare("SELECT * FROM channels WHERE id = ? AND community_id = ?").get(channelId, communityId) as Row | undefined
  if (!channel) return false
  if (!database.prepare("SELECT 1 FROM memberships WHERE community_id = ? AND user_id = ?").get(communityId, userId)) return false
  if (text(channel.kind) === "dm") {
    if (text(channel.user_id) === userId) return true
    const agent = database.prepare("SELECT created_by FROM agents WHERE id = ?").get(text(channel.agent_id)) as Row | undefined
    return !!agent && text(agent.created_by) === userId
  }
  if (text(channel.visibility) === "public") return true
  return !!database.prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND member_id = ?").get(channelId, userId)
}

function requireReadable(database: DatabaseSync, communityId: string, channelId: string, userId: string): Row {
  if (!canReadChannel(database, communityId, channelId, userId)) fail("not_found", "Channel does not exist")
  return database.prepare("SELECT * FROM channels WHERE id = ? AND community_id = ?").get(channelId, communityId) as Row
}

export function createChannel(database: DatabaseSync, communityId: string, actor: User, input: { name: string; visibility: Channel["visibility"] }): Channel {
  requireTeacher(database, communityId, actor.id)
  const id = `channel-${randomUUID()}`
  const at = now()
  return transaction(database, () => {
    database.prepare("INSERT INTO channels (id, community_id, name, kind, visibility, created_at) VALUES (?, ?, ?, 'channel', ?, ?)")
      .run(id, communityId, input.name, input.visibility, at)
    database.prepare("INSERT INTO channel_members (channel_id, member_id, member_kind, joined_at) VALUES (?, ?, 'user', ?)").run(id, actor.id, at)
    return channelFromRow(database.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Row)
  })
}

export function joinChannel(database: DatabaseSync, communityId: string, actor: User, channelId: string): Channel {
  const channel = database.prepare("SELECT * FROM channels WHERE id = ? AND community_id = ?").get(channelId, communityId) as Row | undefined
  membershipRow(database, communityId, actor.id)
  if (!channel || text(channel.kind) === "dm" || text(channel.visibility) !== "public") fail("not_found", "Channel does not exist")
  if (str(channel.archived_at)) fail("conflict", "This channel is archived and cannot accept members")
  database.prepare("INSERT OR IGNORE INTO channel_members (channel_id, member_id, member_kind, joined_at) VALUES (?, ?, 'user', ?)").run(channelId, actor.id, now())
  return channelFromRow(channel)
}

/* A private conversation with an agent. Asking here must not mean losing what
   was understood: the agent still writes cards, they are just scoped to the
   pair and to whoever created the agent. */
export function openDm(database: DatabaseSync, communityId: string, actor: User, agentId: string): Channel {
  membershipRow(database, communityId, actor.id)
  const agent = database.prepare("SELECT * FROM agents WHERE id = ? AND community_id = ? AND status = 'active'").get(agentId, communityId) as Row | undefined
  if (!agent) fail("not_found", "Agent does not exist")
  const existing = database.prepare("SELECT * FROM channels WHERE community_id = ? AND kind = 'dm' AND user_id = ? AND agent_id = ?").get(communityId, actor.id, agentId) as Row | undefined
  if (existing) return channelFromRow(existing)
  const id = `channel-${randomUUID()}`
  const at = now()
  return transaction(database, () => {
    database.prepare("INSERT INTO channels (id, community_id, name, kind, visibility, user_id, agent_id, created_at) VALUES (?, ?, ?, 'dm', 'private', ?, ?, ?)")
      .run(id, communityId, text(agent.name), actor.id, agentId, at)
    database.prepare("INSERT INTO channel_members (channel_id, member_id, member_kind, joined_at) VALUES (?, ?, 'user', ?)").run(id, actor.id, at)
    database.prepare("INSERT INTO channel_members (channel_id, member_id, member_kind, joined_at) VALUES (?, ?, 'agent', ?)").run(id, agentId, at)
    return channelFromRow(database.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Row)
  })
}

const isChannelMember = (database: DatabaseSync, channelId: string, userId: string): boolean =>
  !!database.prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND member_id = ?").get(channelId, userId)

/* Reading a public channel is open to the community; WRITING to one means
   joining it first. Otherwise "join" is decorative and the sidebar is everyone's
   channel list rather than yours. */
function requireChannelMember(database: DatabaseSync, communityId: string, channelId: string, userId: string): void {
  const channel = requireReadable(database, communityId, channelId, userId)
  /* An archive is a closed record: it can still be read, never added to. */
  if (str(channel.archived_at)) fail("conflict", "This channel is archived and no longer accepts messages")
  if (text(channel.kind) === "dm") return
  if (!isChannelMember(database, channelId, userId)) fail("forbidden", "Join this channel before posting in it")
}

/* Ported from the old repo's unread rule: something counts as unread only if it
   arrived after your marker, was written by SOMEONE ELSE, and still exists. Your
   own message must never make a channel look unread to you. */
function isUnread(database: DatabaseSync, channelId: string, userId: string): boolean {
  const marker = database.prepare("SELECT last_read_at FROM channel_reads WHERE channel_id = ? AND user_id = ?").get(channelId, userId) as Row | undefined
  /* Never opened: unread if anyone else has said anything at all. */
  const lastReadAt = text(marker?.last_read_at) || ""
  return !!database.prepare(`SELECT 1 FROM messages
    WHERE channel_id = ? AND created_at > ? AND author_id != ? AND deleted_at IS NULL LIMIT 1`).get(channelId, lastReadAt, userId)
}

/* Typing needs the same standing as posting: you may only appear to be writing
   somewhere you could actually write. */
export function canTypeInChannel(database: DatabaseSync, communityId: string, channelId: string, userId: string): boolean {
  const row = database.prepare("SELECT * FROM channels WHERE id = ? AND community_id = ? AND archived_at IS NULL").get(channelId, communityId) as Row | undefined
  if (!row) return false
  if (!canReadChannel(database, communityId, channelId, userId)) return false
  if (text(row.kind) === "dm") return true
  return isChannelMember(database, channelId, userId)
}

export function markChannelRead(database: DatabaseSync, communityId: string, actor: User, channelId: string, lastReadAt: string): { channelId: string; userId: string; lastReadAt: string; unread: boolean } {
  requireChannelMember(database, communityId, channelId, actor.id)
  database.prepare(`INSERT INTO channel_reads (channel_id, user_id, last_read_at) VALUES (?, ?, ?)
    ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at`).run(channelId, actor.id, lastReadAt)
  return { channelId, userId: actor.id, lastReadAt, unread: isUnread(database, channelId, actor.id) }
}

/* Everything in this community you may read, which for a public channel means
   every member — matching the old repo's `listTenantChannels`. Joining is what
   lets you POST, not what lets you see. Archived channels are excluded, so a
   deleted agent's conversations leave the sidebar. */
export function listChannels(database: DatabaseSync, communityId: string, userId: string, includeArchived = false): Channel[] {
  membershipRow(database, communityId, userId)
  const rows = database.prepare(`SELECT * FROM channels WHERE community_id = ?
    ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY created_at`).all(communityId) as Row[]
  return rows
    .filter((row) => canReadChannel(database, communityId, text(row.id), userId))
    .map((row) => ({
      ...channelFromRow(row),
      unread: isUnread(database, text(row.id), userId),
      joined: isChannelMember(database, text(row.id), userId),
    }))
}

/* The directory of every active public channel, joined or not: a name and a
   count, never what was said inside. Ported from `listTenantChannelDirectory`. */
export function browseChannels(database: DatabaseSync, communityId: string, actor: User): ChannelSummary[] {
  membershipRow(database, communityId, actor.id)
  const rows = database.prepare(`SELECT c.*, (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) AS member_count
    FROM channels c
    WHERE c.community_id = ? AND c.kind = 'channel' AND c.visibility = 'public' AND c.archived_at IS NULL
    ORDER BY c.created_at`).all(communityId) as Row[]
  return rows.map((row) => ({
    id: text(row.id), communityId: text(row.community_id), name: text(row.name),
    memberCount: Number(row.member_count ?? 0), createdAt: text(row.created_at),
  }))
}

export function updateChannel(database: DatabaseSync, communityId: string, actor: User, channelId: string, input: { name?: string; visibility?: Channel["visibility"]; archived?: boolean }): Channel {
  requireTeacher(database, communityId, actor.id)
  const row = database.prepare("SELECT * FROM channels WHERE id = ? AND community_id = ?").get(channelId, communityId) as Row | undefined
  if (!row) fail("not_found", "Channel does not exist")
  /* A DM is named after its agent and belongs to a pair; it is not a channel a
     teacher renames or opens up. */
  if (text(row.kind) === "dm") fail("conflict", "A private conversation cannot be renamed or made public")
  if (input.name !== undefined) database.prepare("UPDATE channels SET name = ? WHERE id = ?").run(input.name, channelId)
  if (input.visibility !== undefined) database.prepare("UPDATE channels SET visibility = ? WHERE id = ?").run(input.visibility, channelId)
  /* Ported from `archiveChannel` / `unarchiveChannel`: a status flip, not a
     deletion. Nothing is removed, so it is reversible. */
  if (input.archived !== undefined) {
    database.prepare("UPDATE channels SET archived_at = ? WHERE id = ?").run(input.archived ? now() : null, channelId)
  }
  return channelFromRow(database.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as Row)
}

export function deleteChannel(database: DatabaseSync, communityId: string, actor: User, channelId: string): Channel {
  requireTeacher(database, communityId, actor.id)
  const row = database.prepare("SELECT * FROM channels WHERE id = ? AND community_id = ?").get(channelId, communityId) as Row | undefined
  if (!row) fail("not_found", "Channel does not exist")
  if (text(row.kind) === "dm") fail("conflict", "A private conversation cannot be deleted")
  /* Ported from `deleteEmptyChannel`: only a channel with no history at all can
     be deleted. Messages, threads, cards and files all count — deleting cascades
     to every one of them, so anything left is something the group would lose. */
  const counts = database.prepare(`SELECT
      (SELECT COUNT(*) FROM messages WHERE channel_id = ?) +
      (SELECT COUNT(*) FROM threads WHERE channel_id = ?) +
      (SELECT COUNT(*) FROM cards WHERE channel_id = ?) +
      (SELECT COUNT(*) FROM attachments WHERE channel_id = ?) AS count`).get(channelId, channelId, channelId, channelId) as Row
  if (Number(counts.count ?? 0) > 0) fail("conflict", "This channel has history. Archive it instead of deleting it.")
  const channel = channelFromRow(row)
  database.prepare("DELETE FROM channels WHERE id = ?").run(channelId)
  return channel
}

export function leaveChannel(database: DatabaseSync, communityId: string, actor: User, channelId: string): Channel {
  const row = requireReadable(database, communityId, channelId, actor.id)
  if (text(row.kind) === "dm") fail("conflict", "A private conversation cannot be left; it is between you and the agent")
  if (!isChannelMember(database, channelId, actor.id)) fail("conflict", "You are not in this channel")
  database.prepare("DELETE FROM channel_members WHERE channel_id = ? AND member_id = ?").run(channelId, actor.id)
  return channelFromRow(row)
}

/* ---- Agents ----------------------------------------------------------------- */

export function agentFromRow(database: DatabaseSync, row: Row, presence: ReadonlyMap<string, Presence>): Agent {
  const channelIds = (database.prepare("SELECT channel_id FROM channel_members WHERE member_id = ? AND member_kind = 'agent'").all(text(row.id)) as Row[]).map((item) => text(item.channel_id))
  return {
    id: text(row.id), communityId: text(row.community_id), name: text(row.name), instructions: text(row.instructions),
    runtime: text(row.runtime) as Runtime, model: text(row.model), status: text(row.status) as Agent["status"],
    createdBy: text(row.created_by),
    /* A server-run agent needs nothing started to be reachable, so it is online
       whenever the endpoint is configured. The others are offline until their
       runner connects. */
    presence: presence.get(text(row.id)) ?? (text(row.runtime) === "api" && apiConfig() ? "online" : "offline"),
    channelIds, createdAt: text(row.created_at),
  }
}

export function createAgent(database: DatabaseSync, communityId: string, actor: User, input: { name: string; instructions: string; runtime: Runtime; model: string; channelIds: string[] }, presence: ReadonlyMap<string, Presence>): { agent: Agent; token: string } {
  requireTeacher(database, communityId, actor.id)
  const id = `agent-${randomUUID()}`
  const token = mintToken()
  const at = now()
  return transaction(database, () => {
    /* Mentions match on the complete name, so two active agents sharing one
       would make "@Ada" ambiguous and wake both. Checked inside the
       transaction, and backed by a unique index, so a race cannot slip past.
       Case-insensitive because mention matching is. */
    const clash = database.prepare("SELECT name FROM agents WHERE community_id = ? AND status != 'deleted' AND lower(name) = lower(?)").get(communityId, input.name) as Row | undefined
    if (clash) fail("conflict", `This community already has an agent called "${text(clash.name)}". Mentions match on the complete name, so two agents cannot share one.`)
    database.prepare(`INSERT INTO agents (id, community_id, name, instructions, runtime, model, status, created_by, runner_token_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(id, communityId, input.name, input.instructions, input.runtime, input.model, actor.id, digest(token), at)
    for (const channelId of input.channelIds) {
      if (!database.prepare("SELECT 1 FROM channels WHERE id = ? AND community_id = ?").get(channelId, communityId)) fail("not_found", "Channel does not exist")
      database.prepare("INSERT OR IGNORE INTO channel_members (channel_id, member_id, member_kind, joined_at) VALUES (?, ?, 'agent', ?)").run(channelId, id, at)
    }
    return { agent: agentFromRow(database, database.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row, presence), token }
  })
}

/* Ported from the old repo's `updateTenantAgent`: a teacher edits any of the
   agent's fields, `channelIds` REPLACES the assignment set rather than adding
   to it, and deleting is the same call with `status: "deleted"`.

   Deleting removes the agent from every channel and ARCHIVES its private
   conversations rather than dropping them: a student's DM history and what the
   agent wrote there outlive the agent, exactly as the old implementation did. */
export function updateAgent(database: DatabaseSync, communityId: string, actor: User, agentId: string, input: {
  name?: string; instructions?: string; runtime?: Runtime; model?: string; channelIds?: string[]; status?: "active" | "deleted"
}, presence: ReadonlyMap<string, Presence> = new Map()): Agent {
  requireTeacher(database, communityId, actor.id)
  const current = database.prepare("SELECT * FROM agents WHERE id = ? AND community_id = ? AND status != 'deleted'").get(agentId, communityId) as Row | undefined
  if (!current) fail("not_found", "Agent does not exist")
  if (input.name !== undefined) {
    const clash = database.prepare("SELECT name FROM agents WHERE community_id = ? AND id != ? AND status != 'deleted' AND lower(name) = lower(?)").get(communityId, agentId, input.name) as Row | undefined
    if (clash) fail("conflict", `This community already has an agent called "${text(clash.name)}". Mentions match on the complete name, so two agents cannot share one.`)
  }
  if (input.channelIds) {
    for (const channelId of input.channelIds) {
      if (!database.prepare("SELECT 1 FROM channels WHERE id = ? AND community_id = ? AND kind = 'channel'").get(channelId, communityId)) fail("not_found", "Channel does not exist")
    }
  }
  const status = input.status ?? (text(current.status) as Agent["status"])
  const timestamp = now()
  return transaction(database, () => {
    database.prepare("UPDATE agents SET name = ?, instructions = ?, runtime = ?, model = ?, status = ? WHERE id = ? AND community_id = ?")
      .run(input.name?.trim() ?? text(current.name), input.instructions ?? text(current.instructions),
        input.runtime ?? text(current.runtime), input.model ?? text(current.model), status, agentId, communityId)
    if (input.name !== undefined) {
      database.prepare("UPDATE channels SET name = ? WHERE community_id = ? AND agent_id = ? AND kind = 'dm'").run(input.name.trim(), communityId, agentId)
    }
    if (input.channelIds) {
      database.prepare(`DELETE FROM channel_members WHERE member_id = ? AND member_kind = 'agent'
        AND channel_id IN (SELECT id FROM channels WHERE community_id = ? AND kind = 'channel')`).run(agentId, communityId)
      for (const channelId of [...new Set(input.channelIds)]) {
        database.prepare("INSERT OR IGNORE INTO channel_members (channel_id, member_id, member_kind, joined_at) VALUES (?, ?, 'agent', ?)").run(channelId, agentId, timestamp)
      }
    }
    if (status === "deleted") {
      database.prepare("DELETE FROM channel_members WHERE member_id = ? AND member_kind = 'agent'").run(agentId)
      database.prepare("UPDATE channels SET archived_at = ? WHERE community_id = ? AND kind = 'dm' AND agent_id = ? AND archived_at IS NULL").run(timestamp, communityId, agentId)
    }
    return agentFromRow(database, database.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Row, presence)
  })
}

export function deleteAgent(database: DatabaseSync, communityId: string, actor: User, agentId: string, presence: ReadonlyMap<string, Presence> = new Map()): Agent {
  return updateAgent(database, communityId, actor, agentId, { status: "deleted" }, presence)
}

export function getAgent(database: DatabaseSync, communityId: string, actor: User, agentId: string, presence: ReadonlyMap<string, Presence>): Agent {
  membershipRow(database, communityId, actor.id)
  const row = database.prepare("SELECT * FROM agents WHERE id = ? AND community_id = ? AND status != 'deleted'").get(agentId, communityId) as Row | undefined
  if (!row) fail("not_found", "Agent does not exist")
  const agent = agentFromRow(database, row, presence)
  return { ...agent, channelIds: agent.channelIds.filter((channelId) => canReadChannel(database, communityId, channelId, actor.id)) }
}

export function rotateAgentToken(database: DatabaseSync, communityId: string, actor: User, agentId: string): string {
  requireTeacher(database, communityId, actor.id)
  const agent = database.prepare("SELECT * FROM agents WHERE id = ? AND community_id = ?").get(agentId, communityId) as Row | undefined
  if (!agent) fail("not_found", "Agent does not exist")
  const token = mintToken()
  database.prepare("UPDATE agents SET runner_token_digest = ? WHERE id = ?").run(digest(token), agentId)
  return token
}

export function listAgents(database: DatabaseSync, communityId: string, userId: string, presence: ReadonlyMap<string, Presence>): Agent[] {
  membershipRow(database, communityId, userId)
  const rows = database.prepare("SELECT * FROM agents WHERE community_id = ? AND status != 'deleted' ORDER BY created_at").all(communityId) as Row[]
  /* An agent's channel list is filtered per viewer: it must not disclose the
     private channels the viewer cannot read. */
  return rows.map((row) => {
    const agent = agentFromRow(database, row, presence)
    return { ...agent, channelIds: agent.channelIds.filter((channelId) => canReadChannel(database, communityId, channelId, userId)) }
  })
}

export function workspace(database: DatabaseSync, communityId: string, actor: User, presence: ReadonlyMap<string, Presence>): Workspace {
  const role = roleIn(database, communityId, actor.id)
  const row = database.prepare("SELECT * FROM communities WHERE id = ?").get(communityId) as Row | undefined
  if (!row) fail("not_found", "Community does not exist")
  return {
    community: communityFromRow(row),
    role,
    members: listMembers(database, communityId, actor),
    channels: listChannels(database, communityId, actor.id),
    agents: listAgents(database, communityId, actor.id, presence),
  }
}

/* ---- Messages --------------------------------------------------------------- */

/* Tallies for a whole channel in one query rather than one per message, so a
   long channel does not turn into hundreds of round trips. */
function reactionsByMessage(database: DatabaseSync, communityId: string, channelId: string): Map<string, Reaction[]> {
  const rows = database.prepare(`SELECT r.message_id, r.emoji, r.user_id FROM message_reactions r
    JOIN messages m ON m.id = r.message_id
    WHERE m.community_id = ? AND m.channel_id = ? ORDER BY r.created_at`).all(communityId, channelId) as Row[]
  const out = new Map<string, Reaction[]>()
  for (const row of rows) {
    const list = out.get(text(row.message_id)) ?? []
    const existing = list.find((item) => item.emoji === text(row.emoji))
    if (existing) existing.userIds.push(text(row.user_id))
    else list.push({ emoji: text(row.emoji), userIds: [text(row.user_id)] })
    out.set(text(row.message_id), list)
  }
  return out
}

export function reactionsFor(database: DatabaseSync, messageId: string): Reaction[] {
  const rows = database.prepare("SELECT emoji, user_id FROM message_reactions WHERE message_id = ? ORDER BY created_at").all(messageId) as Row[]
  const out: Reaction[] = []
  for (const row of rows) {
    const existing = out.find((item) => item.emoji === text(row.emoji))
    if (existing) existing.userIds.push(text(row.user_id))
    else out.push({ emoji: text(row.emoji), userIds: [text(row.user_id)] })
  }
  return out
}

/* Toggling is idempotent in both directions: reacting twice is one reaction,
   un-reacting something you never reacted to is a no-op. */
export function react(database: DatabaseSync, communityId: string, actor: User, messageId: string, emoji: string, on: boolean): { messageId: string; channelId: string; reactions: Reaction[] } {
  const row = database.prepare("SELECT * FROM messages WHERE id = ? AND community_id = ?").get(messageId, communityId) as Row | undefined
  if (!row) fail("not_found", "Message does not exist")
  const channelId = text(row.channel_id)
  requireReadable(database, communityId, channelId, actor.id)
  if (str(row.deleted_at)) fail("conflict", "A deleted message cannot be reacted to")
  if (on) database.prepare("INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)").run(messageId, actor.id, emoji, now())
  else database.prepare("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?").run(messageId, actor.id, emoji)
  return { messageId, channelId, reactions: reactionsFor(database, messageId) }
}

export function listMessages(database: DatabaseSync, communityId: string, actor: User, channelId: string): Message[] {
  requireReadable(database, communityId, channelId, actor.id)
  const rows = database.prepare("SELECT * FROM messages WHERE community_id = ? AND channel_id = ? ORDER BY created_at").all(communityId, channelId) as Row[]
  const reactions = reactionsByMessage(database, communityId, channelId)
  const files = attachmentsForMessages(database, communityId, channelId)
  return rows.map((row) => {
    const message = messageFromRow(row)
    if (message.deletedAt) return message
    const tally = reactions.get(message.id)
    const posted = files.get(message.id)
    return {
      ...message,
      ...(tally?.length ? { reactions: tally } : {}),
      ...(posted?.length ? { attachments: posted.map((file) => ({ id: file.id, name: file.name, mime: file.mime, size: file.size })) } : {}),
    }
  })
}

export function createMessage(database: DatabaseSync, communityId: string, actor: User, channelId: string, input: { paragraphs: Paragraphs; threadId?: string; attachmentIds?: string[]; clientId?: string }): Message {
  requireChannelMember(database, communityId, channelId, actor.id)
  return transaction(database, () => {
    /* Ported from the old repo's `createTenantMessage`: a resend carrying a
       client id this author has already used returns the message that exists.
       It short-circuits BEFORE claiming attachments — re-claiming files that
       the original message already took would fail as a double post, turning a
       harmless retry into an error. */
    if (input.clientId) {
      const existing = database.prepare("SELECT * FROM messages WHERE community_id = ? AND author_id = ? AND client_id = ?")
        .get(communityId, actor.id, input.clientId) as Row | undefined
      if (existing) return withAttachments(database, communityId, channelId, messageFromRow(existing))
    }
    const message = insertMessage(database, communityId, channelId, actor.id, "user", input.paragraphs, input.threadId, undefined, input.clientId)
    /* Claiming happens in the same transaction as the insert: a message must
       never exist referring to files it failed to take, nor files be marked
       posted against a message that was rolled back. */
    if (input.attachmentIds?.length) {
      claimAttachments(database, communityId, channelId, actor.id, roleIn(database, communityId, actor.id) === "teacher", input.attachmentIds, message.id)
    }
    return withAttachments(database, communityId, channelId, message)
  })
}

function withAttachments(database: DatabaseSync, communityId: string, channelId: string, message: Message): Message {
  const files = attachmentsForMessages(database, communityId, channelId).get(message.id)
  if (!files?.length) return message
  return { ...message, attachments: files.map((file) => ({ id: file.id, name: file.name, mime: file.mime, size: file.size })) }
}

/* Seals an agent answer with the cards it was composed from.

   The runner sends card ids only; `oldestAgo` is derived here from this
   server's own rows, because a runner's clock is not evidence. Ids that no
   longer resolve — deleted, or belonging to another community — are dropped
   rather than rejected: a stale id should cost the answer its seal, never the
   answer itself. */
function sealFromFile(database: DatabaseSync, communityId: string, cardIds: readonly string[], at: string): FromFile | undefined {
  const resolved: string[] = []
  const seen = new Set<string>()
  let oldest: number | undefined
  for (const cardId of cardIds) {
    if (seen.has(cardId)) continue
    seen.add(cardId)
    const row = database.prepare("SELECT created_at FROM cards WHERE id = ? AND community_id = ?").get(cardId, communityId) as Row | undefined
    if (!row) continue
    resolved.push(cardId)
    const createdAt = Date.parse(text(row.created_at))
    if (Number.isFinite(createdAt) && (oldest === undefined || createdAt < oldest)) oldest = createdAt
  }
  if (!resolved.length) return undefined
  const composedAt = Date.parse(at)
  const oldestAgo = oldest !== undefined && Number.isFinite(composedAt) ? Math.max(0, Math.round((composedAt - oldest) / 1000)) : 0
  return { cardIds: resolved, oldestAgo }
}

function insertMessage(database: DatabaseSync, communityId: string, channelId: string, authorId: string, authorKind: Message["authorKind"], paragraphs: Paragraphs, threadId?: string, fromFileCardIds?: readonly string[], clientId?: string): Message {
  if (threadId && !database.prepare("SELECT 1 FROM threads WHERE id = ? AND community_id = ? AND channel_id = ?").get(threadId, communityId, channelId)) {
    fail("not_found", "Thread does not exist")
  }
  const id = `message-${randomUUID()}`
  const at = now()
  const body: Record<string, unknown> = { paragraphs }
  if (fromFileCardIds?.length) {
    const seal = sealFromFile(database, communityId, fromFileCardIds, at)
    if (seal) body.fromFile = seal
  }
  database.prepare("INSERT INTO messages (id, community_id, channel_id, author_id, author_kind, body, thread_id, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, communityId, channelId, authorId, authorKind, JSON.stringify(body), threadId ?? null, clientId ?? null, at)
  return messageFromRow(database.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row)
}

export function createAgentMessage(database: DatabaseSync, communityId: string, agentId: string, channelId: string, input: { paragraphs: Paragraphs; threadId?: string; fromFileCardIds?: readonly string[] }): Message {
  if (!database.prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND member_id = ? AND member_kind = 'agent'").get(channelId, agentId)) {
    fail("forbidden", "This agent is not a member of that channel")
  }
  return insertMessage(database, communityId, channelId, agentId, "agent", input.paragraphs, input.threadId, input.fromFileCardIds)
}

/* Only the author edits. A teacher can remove a message but must not be able to
   put words in someone's mouth, which is a different power from moderation.

   The stored body is rewritten around the new paragraphs rather than replaced,
   so an edit cannot silently drop the card-file seal that sits beside them. */
export function editMessage(database: DatabaseSync, communityId: string, actor: User, messageId: string, paragraphs: Paragraphs): Message {
  const row = database.prepare("SELECT * FROM messages WHERE id = ? AND community_id = ?").get(messageId, communityId) as Row | undefined
  if (!row) fail("not_found", "Message does not exist")
  requireReadable(database, communityId, text(row.channel_id), actor.id)
  if (str(row.deleted_at)) fail("conflict", "A deleted message cannot be edited")
  if (text(row.author_id) !== actor.id) fail("forbidden", "Only the author can edit this message")
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text(row.body) || "{}") as Record<string, unknown> } catch { body = {} }
  body.paragraphs = paragraphs
  database.prepare("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?").run(JSON.stringify(body), now(), messageId)
  return messageFromRow(database.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Row)
}

export function deleteMessage(database: DatabaseSync, communityId: string, actor: User, messageId: string): Message {
  const row = database.prepare("SELECT * FROM messages WHERE id = ? AND community_id = ?").get(messageId, communityId) as Row | undefined
  if (!row) fail("not_found", "Message does not exist")
  requireReadable(database, communityId, text(row.channel_id), actor.id)
  if (text(row.author_id) !== actor.id && roleIn(database, communityId, actor.id) !== "teacher") fail("forbidden", "Only the author or a teacher can delete this")
  if (str(row.deleted_at)) return messageFromRow(row)
  /* A tombstone keeps the thread's shape without keeping the content. */
  /* A tombstone carries no content, and a tally on a message nobody can read
     any more is just a number with no subject. */
  database.prepare("DELETE FROM message_reactions WHERE message_id = ?").run(messageId)
  database.prepare("UPDATE messages SET body = '{}', deleted_at = ?, deleted_by = ? WHERE id = ?").run(now(), actor.id, messageId)
  return messageFromRow(database.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Row)
}

/* The immediate memory layer handed to an agent with each mention. */
export function contextFor(database: DatabaseSync, communityId: string, channelId: string, threadId?: string): Message[] {
  const rows = threadId
    ? database.prepare("SELECT * FROM messages WHERE community_id = ? AND channel_id = ? AND thread_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20").all(communityId, channelId, threadId) as Row[]
    : database.prepare("SELECT * FROM messages WHERE community_id = ? AND channel_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20").all(communityId, channelId) as Row[]
  return rows.reverse().map(messageFromRow)
}

/* ---- Threads ----------------------------------------------------------------- */

const threadFromRow = (row: Row): Thread => ({
  id: text(row.id), communityId: text(row.community_id), channelId: text(row.channel_id),
  rootMessageId: text(row.root_message_id), createdAt: text(row.created_at),
})

/* Starting a thread is idempotent: two people hitting reply on the same message
   at the same time should land in one conversation, not race to own it. The
   root message's channel decides where the thread lives, so a thread can never
   be attached to a channel the root does not belong to. */
export function createThread(database: DatabaseSync, communityId: string, actor: User, rootMessageId: string): Thread {
  const root = database.prepare("SELECT * FROM messages WHERE id = ? AND community_id = ?").get(rootMessageId, communityId) as Row | undefined
  if (!root) fail("not_found", "Message does not exist")
  const channelId = text(root.channel_id)
  requireReadable(database, communityId, channelId, actor.id)
  if (str(root.deleted_at)) fail("conflict", "A deleted message cannot start a thread")
  /* A reply is already inside a thread; it cannot also start one. */
  if (str(root.thread_id)) fail("conflict", "That message is already a reply in a thread")
  return transaction(database, () => {
    const existing = database.prepare("SELECT * FROM threads WHERE root_message_id = ? AND community_id = ?").get(rootMessageId, communityId) as Row | undefined
    if (existing) return threadFromRow(existing)
    const id = `thread-${randomUUID()}`
    database.prepare("INSERT INTO threads (id, community_id, channel_id, root_message_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, communityId, channelId, rootMessageId, now())
    return threadFromRow(database.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Row)
  })
}

export function listThreads(database: DatabaseSync, communityId: string, actor: User, channelId: string): Thread[] {
  requireReadable(database, communityId, channelId, actor.id)
  const rows = database.prepare("SELECT * FROM threads WHERE community_id = ? AND channel_id = ? ORDER BY created_at").all(communityId, channelId) as Row[]
  return rows.map(threadFromRow)
}

/* ---- Cards ------------------------------------------------------------------ */

export function publishCard(database: DatabaseSync, communityId: string, agentId: string, input: { channelId: string; path: string; title: string; type: CardType; body: string; sourceMessageIds: string[]; replacesCardId?: string }): Card {
  if (!database.prepare("SELECT 1 FROM channels WHERE id = ? AND community_id = ?").get(input.channelId, communityId)) fail("not_found", "Channel does not exist")
  for (const messageId of input.sourceMessageIds) {
    /* A card may only cite sources from its own community. */
    if (!database.prepare("SELECT 1 FROM messages WHERE id = ? AND community_id = ?").get(messageId, communityId)) fail("invalid_input", "Card sources must belong to this community")
  }
  if (input.replacesCardId && !database.prepare("SELECT 1 FROM cards WHERE id = ? AND community_id = ?").get(input.replacesCardId, communityId)) {
    fail("not_found", "The card this replaces does not exist")
  }
  return transaction(database, () => {
    const existing = database.prepare("SELECT * FROM cards WHERE community_id = ? AND agent_id = ? AND path = ?").get(communityId, agentId, input.path) as Row | undefined
    const version = existing ? Number(existing.version ?? 1) + 1 : 1
    const id = existing ? text(existing.id) : `card-${randomUUID()}`
    const at = now()
    database.prepare(`INSERT INTO cards (id, community_id, agent_id, channel_id, path, title, type, body, version, replaces, source_message_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(community_id, agent_id, path) DO UPDATE SET
        channel_id=excluded.channel_id, title=excluded.title, type=excluded.type, body=excluded.body,
        version=excluded.version, replaces=excluded.replaces, source_message_ids=excluded.source_message_ids`)
      .run(id, communityId, agentId, input.channelId, input.path, input.title, input.type, input.body, version, input.replacesCardId ?? null, JSON.stringify(input.sourceMessageIds), at)
    return cardFromRow(database.prepare("SELECT * FROM cards WHERE community_id = ? AND agent_id = ? AND path = ?").get(communityId, agentId, input.path) as Row)
  })
}

export function listCards(database: DatabaseSync, communityId: string, actor: User): Card[] {
  membershipRow(database, communityId, actor.id)
  const rows = database.prepare("SELECT * FROM cards WHERE community_id = ? ORDER BY created_at").all(communityId) as Row[]
  return rows.filter((row) => canReadChannel(database, communityId, text(row.channel_id), actor.id)).map(cardFromRow)
}

/* ---- Mentions ---------------------------------------------------------------- */

/* Who should answer this message.

   In a private conversation there is exactly one agent and the channel exists
   only for it, so every message is addressed to it — requiring "@name" in a room
   with one other participant is a toll on the person least willing to ask in
   public, which is the whole reason the private door exists.

   In a shared channel an agent is addressed by its complete name, so
   "@Ada Alphabet" does not wake the agent called "Ada Alpha". */
export function mentionedAgents(database: DatabaseSync, communityId: string, channelId: string, paragraphs: Paragraphs): Row[] {
  const channel = database.prepare("SELECT * FROM channels WHERE id = ? AND community_id = ?").get(channelId, communityId) as Row | undefined
  if (channel && text(channel.kind) === "dm" && str(channel.agent_id)) {
    const agent = database.prepare("SELECT * FROM agents WHERE id = ? AND community_id = ? AND status = 'active'").get(text(channel.agent_id), communityId) as Row | undefined
    return agent ? [agent] : []
  }
  const plain = paragraphs.flat().map((block) => ("text" in block ? block.text : "")).join(" ").toLowerCase()
  const rows = database.prepare("SELECT * FROM agents WHERE community_id = ? AND status = 'active'").all(communityId) as Row[]
  return rows.filter((row) => {
    if (!database.prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND member_id = ? AND member_kind = 'agent'").get(channelId, text(row.id))) return false
    const name = text(row.name).toLowerCase()
    const index = plain.indexOf(`@${name}`)
    if (index === -1) return false
    /* The character after the name must not continue it. */
    const after = plain[index + name.length + 1]
    return after === undefined || !/[\w-]/.test(after)
  })
}
