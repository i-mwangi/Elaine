import { useEffect, useRef, useState } from "react"
import type { Agent, Card, Member, Message } from "@/lib/api"
import type { Paragraphs } from "@elaine/protocol"

/* `oldestAgo` arrives in seconds, frozen at the moment the answer was composed.
   Turning it into words is the client's job, which is why the contract carries
   a number and not a phrase. */
function ago(seconds: number): string {
  if (seconds < 90) return "moments earlier"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minutes earlier`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} earlier`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} earlier`
}

/* A small fixed set rather than a picker: enough to say "yes", "thanks",
   "I do not follow" and "done", which is most of what a course channel needs. */
const PALETTE = ["👍", "✅", "🤔", "❤️", "🎉"]

/* Sizes are for a human deciding whether to click, not for accounting. */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/* Editing works on plain text: paragraphs in, paragraphs out, so a message that
   was written in the composer round-trips through the editor unchanged. */
const toText = (message: Message): string =>
  message.paragraphs.map((paragraph) => paragraph.map((block) => block.text).join("")).join("\n\n")
const toParagraphs = (text: string): Paragraphs =>
  text.split(/\n\s*\n/).map((part) => [{ kind: "text" as const, text: part.trim() }]).filter((part) => part[0].text) as Paragraphs

export function Messages({ messages, members, agents, cards, emptyHint, replyCount, onOpenThread, viewerId, onEdit, canDelete, onDelete, onReact, onDownload, onOpenCard }: {
  messages: Message[]
  members: Member[]
  agents: Agent[]
  cards: Card[]
  emptyHint: string
  /* Undefined inside a thread panel, where replying to a reply is not a thing. */
  replyCount?: (messageId: string) => number
  onOpenThread?: (message: Message) => void
  viewerId?: string
  onEdit?: (messageId: string, paragraphs: Paragraphs) => Promise<void>
  /* A teacher may delete anyone's message; everyone may delete their own. */
  canDelete?: (message: Message) => boolean
  onDelete?: (messageId: string) => Promise<void>
  onReact?: (messageId: string, emoji: string, on: boolean) => Promise<void>
  onDownload?: (attachmentId: string, name: string) => Promise<void>
  /* Opens the card a citation points at. */
  onOpenCard?: (cardId: string) => void
}) {
  const [picking, setPicking] = useState<string | undefined>()
  const [editing, setEditing] = useState<{ id: string; text: string } | undefined>()
  const [editError, setEditError] = useState<string | undefined>()
  /* Deleting is destructive and cannot be undone, so it asks first — inline,
     so the confirmation names the message it is about. */
  const [confirming, setConfirming] = useState<string | undefined>()
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }) }, [messages.length])

  const nameFor = (message: Message): string =>
    message.authorKind === "agent"
      ? agents.find((agent) => agent.id === message.authorId)?.name ?? "agent"
      : members.find((member) => member.userId === message.authorId)?.displayName ?? "someone"

  const nameOf = (userId: string): string =>
    members.find((member) => member.userId === userId)?.displayName ?? "someone"

  const cardTitle = (cardId: string): string => cards.find((card) => card.id === cardId)?.title ?? "a card"
  const cardPath = (cardId: string): string | undefined => cards.find((card) => card.id === cardId)?.path

  if (!messages.length) return <div className="empty">{emptyHint}</div>

  return (
    <div className="messages">
      {messages.map((message) => (
        <article key={message.id} className={`message ${message.authorKind}`}>
          <header>
            <strong>{nameFor(message)}</strong>
            {message.authorKind === "agent" && <span className="chip">agent</span>}
            <time dateTime={message.at}>{time(message.at)}</time>
            {message.editedAt && !message.deletedAt && <span className="muted small">edited</span>}
          </header>

          {editing?.id === message.id ? (
            <form
              className="edit-form"
              onSubmit={async (event) => {
                event.preventDefault()
                const paragraphs = toParagraphs(editing.text)
                if (!paragraphs.length) return
                setEditError(undefined)
                try {
                  await onEdit?.(message.id, paragraphs)
                  setEditing(undefined)
                } catch (cause) {
                  setEditError(cause instanceof Error ? cause.message : "Could not save that edit")
                }
              }}
            >
              <textarea
                value={editing.text}
                onChange={(event) => setEditing({ id: message.id, text: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { setEditing(undefined); setEditError(undefined) }
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
                }}
                aria-label="Edit your message"
                rows={2}
                autoFocus
              />
              <div className="row">
                <button type="button" onClick={() => { setEditing(undefined); setEditError(undefined) }}>Cancel</button>
                <button className="primary" type="submit" disabled={!editing.text.trim()}>Save</button>
              </div>
              {editError && <p className="error small" role="alert">{editError}</p>}
            </form>
          ) : message.deletedAt ? (
            /* Naming the remover only when it was not the author: "removed by
               Henry" on your own deletion would be noise, but on someone
               else's it is the difference between a gap and moderation. */
            <p className="muted deleted">
              {message.deletedBy && message.deletedBy !== message.authorId
                ? `Message removed by ${nameOf(message.deletedBy)}`
                : "Message deleted"}
            </p>
          ) : (
            message.paragraphs.map((paragraph, index) =>
              paragraph.length === 1 && paragraph[0].kind === "code" ? (
                <pre key={index}><code>{paragraph[0].text}</code></pre>
              ) : (
                <p key={index}>
                  {paragraph.map((block, blockIndex) =>
                    block.kind === "cite" ? (
                      <button
                        key={blockIndex}
                        className="cite"
                        title={cardPath(block.cite.cardId) ?? "card"}
                        onClick={() => onOpenCard?.(block.cite.cardId)}
                      >
                        {block.text || cardTitle(block.cite.cardId)}
                      </button>
                    ) : (
                      <span key={blockIndex}>{block.text}</span>
                    ),
                  )}
                </p>
              ),
            )
          )}

          {!!message.attachments?.length && !message.deletedAt && (
            <ul className="attachments">
              {message.attachments.map((file) => (
                <li key={file.id}>
                  <button
                    className="file"
                    onClick={() => void onDownload?.(file.id, file.name)}
                    title={`${file.mime} · ${formatBytes(file.size)}`}
                  >
                    {file.name} <span className="muted">{formatBytes(file.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {onReact && !message.deletedAt && editing?.id !== message.id && (
            <div className="reactions">
              {(message.reactions ?? []).map((reaction) => {
                const mine = !!viewerId && reaction.userIds.includes(viewerId)
                return (
                  <button
                    key={reaction.emoji}
                    className={`pill${mine ? " mine" : ""}`}
                    title={reaction.userIds.map(nameOf).join(", ")}
                    aria-label={`${reaction.emoji}, ${reaction.userIds.length}${mine ? ", including you" : ""}`}
                    aria-pressed={mine}
                    onClick={() => void onReact(message.id, reaction.emoji, !mine)}
                  >
                    <span aria-hidden>{reaction.emoji}</span> {reaction.userIds.length}
                  </button>
                )
              })}
              {picking === message.id ? (
                <span className="palette" role="group" aria-label="Pick a reaction">
                  {PALETTE.map((emoji) => (
                    <button key={emoji} aria-label={`React with ${emoji}`} onClick={() => { void onReact(message.id, emoji, true); setPicking(undefined) }}>
                      {emoji}
                    </button>
                  ))}
                  <button onClick={() => setPicking(undefined)} aria-label="Close reaction picker">x</button>
                </span>
              ) : (
                <button className="pill add" aria-label="Add a reaction" onClick={() => setPicking(message.id)}>+</button>
              )}
            </div>
          )}

          {onEdit && viewerId === message.authorId && !message.deletedAt && editing?.id !== message.id && (
            <button className="reply" onClick={() => { setEditError(undefined); setEditing({ id: message.id, text: toText(message) }) }}>
              edit
            </button>
          )}

          {onDelete && canDelete?.(message) && !message.deletedAt && editing?.id !== message.id && (
            confirming === message.id ? (
              <span className="confirm" role="group" aria-label="Confirm delete">
                <span className="muted small">Delete this message?</span>
                <button
                  className="danger"
                  onClick={async () => {
                    try { await onDelete(message.id) } catch { /* the event is the source of truth */ }
                    setConfirming(undefined)
                  }}
                >
                  Delete
                </button>
                <button onClick={() => setConfirming(undefined)}>Cancel</button>
              </span>
            ) : (
              <button className="reply" onClick={() => setConfirming(message.id)}>delete</button>
            )
          )}

          {onOpenThread && !message.deletedAt && editing?.id !== message.id && (() => {
            const replies = replyCount?.(message.id) ?? 0
            return (
              <button className={`reply${replies ? " has-replies" : ""}`} onClick={() => onOpenThread(message)}>
                {replies ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "reply"}
              </button>
            )
          })()}

          {/* Provenance, not a cache. The answer above is new; what was reused is
              the understanding behind it. */}
          {message.fromFile && (
            <p className="seal">
              Composed from the card file ·{" "}
              {message.fromFile.cardIds.map((cardId, index) => (
                <span key={cardId}>
                  {index > 0 && ", "}
                  <button className="seal-card" onClick={() => onOpenCard?.(cardId)}>{cardTitle(cardId)}</button>
                </span>
              ))}
              , the oldest written {ago(message.fromFile.oldestAgo)}
            </p>
          )}
        </article>
      ))}
      <div ref={bottom} />
    </div>
  )
}
