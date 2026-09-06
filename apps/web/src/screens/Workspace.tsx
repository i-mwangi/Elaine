import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Paragraphs, ServerEvent } from "@elaine/protocol"
import { api, type Attachment, type Card, type Message, type Session, type Thread, type Workspace as WorkspaceData } from "@/lib/api"
import { useLive } from "@/lib/live"
import { Messages, formatBytes } from "@/components/Messages"
import { CardPanel } from "@/components/CardPanel"

type Dialog = "channel" | "invite" | "agent" | undefined
type Editing = { agentId: string; name: string; instructions: string; runtime: "claude" | "codex" | "api"; channelIds: string[] }

export function Workspace({ token, session, communityId, onLeave }: {
  token: string
  session: Session
  communityId: string
  onLeave: () => void
}) {
  const [data, setData] = useState<WorkspaceData | undefined>()
  const [cards, setCards] = useState<Card[]>([])
  const [channelId, setChannelId] = useState<string | undefined>()
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState("")
  const [dialog, setDialog] = useState<Dialog>()
  const [notice, setNotice] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [sending, setSending] = useState(false)
  /* Which agent is being renamed, and the text so far. Held here rather than in
     the row so that only one rename is open at a time. */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | undefined>()
  const [renameError, setRenameError] = useState<string | undefined>()
  const [threads, setThreads] = useState<Thread[]>([])
  const [openThreadId, setOpenThreadId] = useState<string | undefined>()
  const [threadDraft, setThreadDraft] = useState("")
  const [removing, setRemoving] = useState<string | undefined>()
  const [leaving, setLeaving] = useState(false)
  const [memberError, setMemberError] = useState<string | undefined>()
  const [renamingChannel, setRenamingChannel] = useState<{ id: string; value: string } | undefined>()
  const [deletingChannel, setDeletingChannel] = useState<string | undefined>()
  const [editingAgent, setEditingAgent] = useState<Editing | undefined>()
  const [deletingAgent, setDeletingAgent] = useState<string | undefined>()
  const [channelError, setChannelError] = useState<string | undefined>()
  const [renamingCommunity, setRenamingCommunity] = useState<string | undefined>()
  /* Narrow screens only: the sidebar becomes a drawer over the conversation
     rather than a column beside it. */
  const [navOpen, setNavOpen] = useState(false)
  const [openCardId, setOpenCardId] = useState<string | undefined>()
  /* Files already uploaded but not yet posted. They exist on the server, which
     is why cancelling one deletes it rather than just forgetting it. */
  const [pending, setPending] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  /* Who is typing where. Server-side expiry is the safety net; this only
     mirrors what it says. */
  const [typing, setTyping] = useState<Record<string, string[]>>({})
  const lastTypingSent = useRef(0)
  const sendId = useRef<string | undefined>(undefined)

  const selected = useRef<string | undefined>(undefined)
  selected.current = channelId

  const load = useCallback(async (): Promise<void> => {
    const [workspace, cardList] = await Promise.all([
      api.workspace(token, communityId), api.cards(token, communityId),
    ])
    setData(workspace)
    setCards(cardList)
    /* If the open channel was deleted or left, fall back rather than showing an
       empty room whose name no longer exists. */
    setChannelId((current) => (current && workspace.channels.some((item) => item.id === current) ? current : workspace.channels[0]?.id))
  }, [token, communityId])

  useEffect(() => { void load().catch((cause: Error) => setError(cause.message)) }, [load])

  /* Picking somewhere to go is the end of navigating: the drawer closes itself
     rather than leaving the conversation behind it. */
  useEffect(() => { setNavOpen(false) }, [channelId])

  useEffect(() => {
    if (!navOpen) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") setNavOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navOpen])

  useEffect(() => {
    if (!channelId) return
    let cancelled = false
    setOpenThreadId(undefined)
    void Promise.all([api.messages(token, communityId, channelId), api.threads(token, communityId, channelId)])
      .then(([list, threadList]) => {
        if (cancelled) return
        setMessages(list)
        setThreads(threadList)
        /* The marker is the timestamp of what is actually on screen, never
           "now": it must not claim more than was displayed. */
        const newest = list.length ? list[list.length - 1].at : new Date().toISOString()
        void api.markRead(token, communityId, channelId, newest).catch(() => undefined)
      })
      .catch(() => { if (!cancelled) { setMessages([]); setThreads([]) } })
    return () => { cancelled = true }
  }, [token, communityId, channelId])

  /* Live updates. The socket only ever carries what this viewer may read, so
     an event arriving is itself the authorization decision. */
  const onEvent = useCallback((event: ServerEvent): void => {
    switch (event.type) {
      case "message.created": {
        const arrived = event.payload.message
        if (arrived.channelId !== selected.current) {
          /* Somewhere else in the sidebar. Your own message never counts. */
          if (arrived.authorId !== session.user.id) {
            setData((current) => current && {
              ...current,
              channels: current.channels.map((channel) => channel.id === arrived.channelId ? { ...channel, unread: true } : channel),
            })
          }
          return
        }
        setMessages((current) => current.some((item) => item.id === arrived.id) ? current : [...current, arrived])
        /* You are looking at this channel, so it stays read. */
        if (arrived.authorId !== session.user.id) void api.markRead(token, communityId, arrived.channelId, arrived.at).catch(() => undefined)
        return
      }
      case "typing.updated": {
        const { channelId: where, userId, typing: isTyping } = event.payload
        /* The server broadcasts to everyone in the channel, the typist
           included, so the echo of your own typing is dropped here. */
        if (userId === session.user.id) return
        setTyping((current) => {
          const present = current[where] ?? []
          const next = isTyping ? (present.includes(userId) ? present : [...present, userId]) : present.filter((id) => id !== userId)
          return { ...current, [where]: next }
        })
        return
      }
      case "channel.read":
        setData((current) => current && {
          ...current,
          channels: current.channels.map((channel) => channel.id === event.payload.channelId ? { ...channel, unread: event.payload.unread } : channel),
        })
        return
      case "message.updated":
        setMessages((current) => current.map((item) => item.id === event.payload.message.id ? event.payload.message : item))
        return
      case "message.deleted":
        /* The server keeps a tombstone so a thread does not lose its shape, and
           the event carries no content. Marking it deleted is what a reload
           shows; removing the row outright would disagree with that. */
        setMessages((current) => current.map((item) => item.id === event.payload.messageId
          ? { ...item, deletedAt: event.at, deletedBy: event.payload.deletedBy, paragraphs: [[{ kind: "text" as const, text: "" }]] }
          : item))
        return
      case "thread.created":
        if (event.payload.thread.channelId !== selected.current) return
        setThreads((current) => current.some((item) => item.id === event.payload.thread.id) ? current : [...current, event.payload.thread])
        return
      case "message.reacted":
        setMessages((current) => current.map((item) => item.id === event.payload.messageId
          ? { ...item, reactions: event.payload.reactions.length ? event.payload.reactions : undefined }
          : item))
        return
      case "card.published":
        setCards((current) => [...current.filter((card) => card.id !== event.payload.card.id), event.payload.card])
        return
      case "runner.presence":
        setData((current) => current && {
          ...current,
          agents: current.agents.map((agent) => agent.id === event.payload.agentId ? { ...agent, presence: event.payload.presence } : agent),
        })
        return
      case "member.removed":
        /* If it is me, the socket is closing too; step back to the picker
           rather than sitting on a workspace that will start 403ing. */
        if (event.payload.userId === session.user.id) { onLeave(); return }
        void load()
        return
      case "channel.deleted":
        setMessages((current) => current)
        void load()
        return
      case "community.updated":
      case "channel.archived":
      case "channel.updated":
      case "channel.created":
      case "member.joined":
      case "member.updated":
      case "agent.updated":
      case "agent.deleted":
        void load()
        return
    }
  }, [load])

  const { status, send: sendFrame } = useLive(token, communityId, onEvent)

  /* The server forgets a typist after a few seconds of silence, so this
     re-announces while keys are actually being pressed and stops the moment
     the message goes or the box empties. */
  const announceTyping = (isTyping: boolean): void => {
    if (!channelId) return
    if (!isTyping) {
      lastTypingSent.current = 0
      sendFrame({ type: "typing.set", payload: { channelId, typing: false } })
      return
    }
    const nowMs = Date.now()
    if (nowMs - lastTypingSent.current < 2_000) return
    lastTypingSent.current = nowMs
    sendFrame({ type: "typing.set", payload: { channelId, typing: true } })
  }

  const channels = useMemo(() => (data?.channels ?? []).filter((channel) => channel.kind === "channel"), [data])
  const dms = useMemo(() => (data?.channels ?? []).filter((channel) => channel.kind === "dm"), [data])
  const current = data?.channels.find((channel) => channel.id === channelId)
  const isTeacher = data?.role === "teacher"

  const rename = async (): Promise<void> => {
    if (!renaming) return
    const name = renaming.value.trim()
    const agent = data?.agents.find((item) => item.id === renaming.id)
    if (!name || name === agent?.name) { setRenaming(undefined); setRenameError(undefined); return }
    setRenameError(undefined)
    try {
      await api.updateAgent(token, communityId, renaming.id, { name })
      /* The rename also retitles the private conversations that carried the old
         name, so the whole workspace is reloaded rather than patched in place. */
      await load()
      setRenaming(undefined)
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : "Could not rename that agent")
    }
  }

  /* The channel shows only what is not a reply; replies live in their thread. */
  const rootMessages = useMemo(() => messages.filter((message) => !message.threadId), [messages])
  const threadByRoot = useMemo(() => new Map(threads.map((thread) => [thread.rootMessageId, thread])), [threads])
  const repliesFor = useCallback((messageId: string): number => {
    const thread = threadByRoot.get(messageId)
    return thread ? messages.filter((message) => message.threadId === thread.id).length : 0
  }, [threadByRoot, messages])

  const openCard = cards.find((card) => card.id === openCardId)
  const showCard = (cardId: string): void => { setOpenThreadId(undefined); setOpenCardId(cardId) }

  const openThread = threads.find((thread) => thread.id === openThreadId)
  const threadRoot = openThread ? messages.find((message) => message.id === openThread.rootMessageId) : undefined
  const threadReplies = openThread ? messages.filter((message) => message.threadId === openThread.id) : []

  /* Opening a thread creates it on first reply. Two people clicking at once is
     fine: the server returns the same thread rather than a second one. */
  const openThreadFor = async (message: Message): Promise<void> => {
    setOpenCardId(undefined)
    const existing = threadByRoot.get(message.id)
    if (existing) { setOpenThreadId(existing.id); return }
    try {
      const thread = await api.createThread(token, communityId, message.id)
      setThreads((current) => current.some((item) => item.id === thread.id) ? current : [...current, thread])
      setOpenThreadId(thread.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open that thread")
    }
  }

  /* The edit is not applied locally: the message.updated event is the single
     path by which everyone, including the editor, sees the new text. */
  const editMessage = async (messageId: string, paragraphs: Paragraphs): Promise<void> => {
    await api.editMessage(token, communityId, messageId, paragraphs)
  }

  const runChannelAction = async (action: () => Promise<unknown>): Promise<void> => {
    setChannelError(undefined)
    try {
      await action()
      await load()
    } catch (cause) {
      setChannelError(cause instanceof Error ? cause.message : "That did not work")
    }
  }

  const runMemberAction = async (action: () => Promise<unknown>): Promise<void> => {
    setMemberError(undefined)
    try {
      await action()
      await load()
    } catch (cause) {
      setMemberError(cause instanceof Error ? cause.message : "That did not work")
    }
  }

  const attach = async (files: FileList | null): Promise<void> => {
    if (!files?.length || !channelId) return
    setUploading(true); setError(undefined)
    try {
      for (const file of Array.from(files)) {
        const stored = await api.uploadAttachment(token, communityId, channelId, file)
        setPending((current) => [...current, stored])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload that file")
    } finally {
      setUploading(false)
    }
  }

  const cancelPending = async (attachmentId: string): Promise<void> => {
    setPending((current) => current.filter((file) => file.id !== attachmentId))
    /* It was already stored, so dropping the chip has to remove it too. */
    await api.removeAttachment(token, communityId, attachmentId).catch(() => undefined)
  }

  /* The bytes need the bearer token, so the browser is handed an object URL
     rather than a link it could fetch on its own. */
  const download = async (attachmentId: string, name: string): Promise<void> => {
    try {
      const blob = await api.downloadAttachment(token, communityId, attachmentId)
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = name
      link.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not download that file")
    }
  }

  const react = async (messageId: string, emoji: string, on: boolean): Promise<void> => {
    try {
      await api.react(token, communityId, messageId, emoji, on)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add that reaction")
    }
  }

  const deleteMessage = async (messageId: string): Promise<void> => {
    try {
      await api.deleteMessage(token, communityId, messageId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete that message")
    }
  }

  const sendToThread = async (): Promise<void> => {
    const text = threadDraft.trim()
    if (!text || !openThread || !channelId) return
    setError(undefined)
    try {
      await api.send(token, communityId, channelId, [[{ kind: "text", text }]], openThread.id)
      setThreadDraft("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send that")
    }
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    /* One id per composed message, kept for the life of this send: if the
       response is lost and the send is repeated, the server returns the
       original instead of posting it twice. */
    const clientId = sendId.current ?? (sendId.current = crypto.randomUUID())
    /* A file on its own is a message worth sending. */
    if ((!text && !pending.length) || !channelId) return
    setSending(true); setError(undefined)
    /* Paragraphs, not markdown: blank lines separate, and a fenced block stays
       a code block. */
    const paragraphs = text.split(/\n\s*\n/).map((part) => [{ kind: "text" as const, text: part.trim() }]).filter((part) => part[0].text)
    try {
      await api.send(token, communityId, channelId, paragraphs.length ? paragraphs : [[{ kind: "text", text }]], undefined, pending.map((file) => file.id), clientId)
      setDraft("")
      setPending([])
      sendId.current = undefined
      announceTyping(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send that")
    } finally {
      setSending(false)
    }
  }

  if (error && !data) return <div className="boot">{error} <button onClick={onLeave}>Back</button></div>
  if (!data) return <div className="boot">Loading the community…</div>

  return (
    <div className={`workspace${openThread || openCard ? " with-thread" : ""}${navOpen ? " nav-open" : ""}`}>
      {/* Only reachable on a narrow screen, where the drawer covers the page. */}
      {navOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}
      <nav className="sidebar" id="workspace-nav">
        <header>
          <button className="link" onClick={onLeave}>← communities</button>
          {renamingCommunity !== undefined ? (
            <form
              className="rename-form"
              onSubmit={(event) => {
                event.preventDefault()
                const name = renamingCommunity.trim()
                if (!name || name === data.community.name) { setRenamingCommunity(undefined); return }
                void runChannelAction(() => api.updateCommunity(token, communityId, { name })).then(() => setRenamingCommunity(undefined))
              }}
            >
              <input
                value={renamingCommunity}
                onChange={(event) => setRenamingCommunity(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Escape") setRenamingCommunity(undefined) }}
                aria-label={`New name for ${data.community.name}`}
                autoFocus
              />
              <button type="submit" disabled={!renamingCommunity.trim()}>Save</button>
              <button type="button" onClick={() => setRenamingCommunity(undefined)}>Cancel</button>
            </form>
          ) : (
            <div className="community-name">
              <h2>{data.community.name}</h2>
              {isTeacher && (
                <button
                  className="rename"
                  aria-label={`Rename ${data.community.name}`}
                  onClick={() => { setChannelError(undefined); setRenamingCommunity(data.community.name) }}
                >
                  rename
                </button>
              )}
            </div>
          )}
          <span className={`badge ${data.role}`}>{data.role}</span>
          {data.community.term && <span className="muted small"> {data.community.term}</span>}
        </header>

        <section>
          <h3>Channels</h3>
          <ul>
            {channels.map((channel) => (
              <li key={channel.id} className="agent-row">
                {renamingChannel?.id === channel.id ? (
                  <form
                    className="rename-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      const name = renamingChannel.value.trim()
                      if (!name || name === channel.name) { setRenamingChannel(undefined); return }
                      void runChannelAction(() => api.updateChannel(token, communityId, channel.id, { name })).then(() => setRenamingChannel(undefined))
                    }}
                  >
                    <input
                      value={renamingChannel.value}
                      onChange={(event) => setRenamingChannel({ id: channel.id, value: event.target.value })}
                      onKeyDown={(event) => { if (event.key === "Escape") setRenamingChannel(undefined) }}
                      aria-label={`New name for ${channel.name}`}
                      autoFocus
                    />
                    <button type="submit" disabled={!renamingChannel.value.trim()}>Save</button>
                    <button type="button" onClick={() => setRenamingChannel(undefined)}>Cancel</button>
                  </form>
                ) : deletingChannel === channel.id ? (
                  <span className="confirm" role="group" aria-label={`Confirm deleting ${channel.name}`}>
                    <span className="muted small">Delete #{channel.name}?</span>
                    <button className="danger" onClick={() => void runChannelAction(() => api.deleteChannel(token, communityId, channel.id)).then(() => setDeletingChannel(undefined))}>Delete</button>
                    <button onClick={() => setDeletingChannel(undefined)}>Cancel</button>
                  </span>
                ) : (
                  <>
                    <button
                      className={`grow${channel.id === channelId ? " active" : ""}${channel.unread ? " unread" : ""}`}
                      onClick={() => setChannelId(channel.id)}
                    >
                      # {channel.name}
                      {channel.unread && <span className="unread-dot" aria-label="unread" />}
                      {channel.visibility === "private" && <span className="chip">private</span>}
                    </button>
                    <span className="member-actions">
                      {isTeacher && (
                        <button aria-label={`Rename ${channel.name}`} onClick={() => { setChannelError(undefined); setRenamingChannel({ id: channel.id, value: channel.name }) }}>rename</button>
                      )}
                      {channel.joined
                        ? <button aria-label={`Leave ${channel.name}`} onClick={() => void runChannelAction(() => api.leaveChannel(token, communityId, channel.id))}>leave</button>
                        : <button aria-label={`Join ${channel.name}`} onClick={() => void runChannelAction(() => api.joinChannel(token, communityId, channel.id))}>join</button>}
                      {isTeacher && (
                        <button
                          aria-label={`Archive ${channel.name}`}
                          onClick={() => void runChannelAction(() => api.updateChannel(token, communityId, channel.id, { archived: true }))}
                        >
                          archive
                        </button>
                      )}
                      {isTeacher && (
                        <button aria-label={`Delete ${channel.name}`} onClick={() => { setChannelError(undefined); setDeletingChannel(channel.id) }}>delete</button>
                      )}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
          {channelError && <p className="error small" role="alert">{channelError}</p>}
          {isTeacher && <button className="link" onClick={() => setDialog("channel")}>+ new channel</button>}

        </section>

        <section>
          <h3>Agents</h3>
          <ul>
            {data.agents.map((agent) => (
              <li key={agent.id} className="agent-row">
                {deletingAgent === agent.id ? (
                  <span className="confirm" role="group" aria-label={`Confirm deleting ${agent.name}`}>
                    {/* Naming what survives: deleting an agent archives its
                        private conversations rather than destroying them. */}
                    <span className="muted small">Delete {agent.name}? Its conversations are kept.</span>
                    <button
                      className="danger"
                      onClick={async () => {
                        await runChannelAction(() => api.deleteAgent(token, communityId, agent.id))
                        setDeletingAgent(undefined)
                      }}
                    >
                      Delete
                    </button>
                    <button onClick={() => setDeletingAgent(undefined)}>Cancel</button>
                  </span>
                ) : renaming?.id === agent.id ? (
                  <form
                    className="rename-form"
                    onSubmit={(event) => { event.preventDefault(); void rename() }}
                  >
                    <input
                      value={renaming.value}
                      onChange={(event) => setRenaming({ id: agent.id, value: event.target.value })}
                      onKeyDown={(event) => { if (event.key === "Escape") { setRenaming(undefined); setRenameError(undefined) } }}
                      aria-label={`New name for ${agent.name}`}
                      autoFocus
                    />
                    <button type="submit" disabled={!renaming.value.trim()}>Save</button>
                    <button type="button" onClick={() => { setRenaming(undefined); setRenameError(undefined) }}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <button
                      className="grow"
                      onClick={async () => {
                        try {
                          const channel = await api.openDm(token, communityId, agent.id)
                          await load()
                          setChannelId(channel.id)
                        } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open that conversation") }
                      }}
                    >
                      <span className={`dot ${agent.presence}`} aria-hidden />
                      {agent.name}
                      <span className="muted"> {agent.presence === "offline" ? "offline" : agent.presence}</span>
                    </button>
                    {/* Only a teacher may change an agent, and every control
                        carries the agent's name so none is an unlabelled icon
                        in a list. */}
                    {isTeacher && (
                      <span className="member-actions">
                        <button
                          aria-label={`Rename ${agent.name}`}
                          onClick={() => { setRenameError(undefined); setRenaming({ id: agent.id, value: agent.name }) }}
                        >
                          rename
                        </button>
                        <button
                          aria-label={`Edit ${agent.name}`}
                          onClick={() => {
                            setRenameError(undefined)
                            setEditingAgent({ agentId: agent.id, name: agent.name, instructions: agent.instructions, runtime: agent.runtime, channelIds: agent.channelIds })
                          }}
                        >
                          edit
                        </button>
                        <button aria-label={`Delete ${agent.name}`} onClick={() => { setRenameError(undefined); setDeletingAgent(agent.id) }}>delete</button>
                      </span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
          {renameError && <p className="error small" role="alert">{renameError}</p>}
          {isTeacher && <button className="link" onClick={() => setDialog("agent")}>+ new agent</button>}
        </section>

        {dms.length > 0 && (
          <section>
            <h3>Private</h3>
            <ul>
              {dms.map((channel) => (
                <li key={channel.id}>
                  <button className={channel.id === channelId ? "active" : ""} onClick={() => setChannelId(channel.id)}>
                    {channel.name}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3>Card file</h3>
          {cards.length === 0 ? (
            <p className="muted small">Nothing compiled yet. Cards appear here as the agents work things out.</p>
          ) : (
            <ul>
              {cards.map((card) => (
                <li key={card.id} className="agent-row">
                  <button
                    className={`grow${card.id === openCardId ? " active" : ""}`}
                    onClick={() => showCard(card.id)}
                    title={card.path}
                  >
                    {card.title}
                    <span className="muted"> {card.type}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3>Members</h3>
          <ul className="plain">
            {data.members.map((member) => (
              <li key={member.userId} className="member-row">
                <span className="grow">
                  {member.displayName}
                  {member.userId === session.user.id && <span className="muted"> (you)</span>}
                  <span className={`badge ${member.role}`}>{member.role}</span>
                </span>
                {isTeacher && removing !== member.userId && (
                  <span className="member-actions">
                    <button
                      aria-label={member.role === "teacher" ? `Make ${member.displayName} a student` : `Make ${member.displayName} a teacher`}
                      onClick={() => void runMemberAction(() => api.updateMemberRole(token, communityId, member.userId, member.role === "teacher" ? "student" : "teacher"))}
                    >
                      {member.role === "teacher" ? "make student" : "make teacher"}
                    </button>
                    {member.userId !== session.user.id && (
                      <button aria-label={`Remove ${member.displayName}`} onClick={() => { setMemberError(undefined); setRemoving(member.userId) }}>remove</button>
                    )}
                  </span>
                )}
                {isTeacher && removing === member.userId && (
                  <span className="confirm" role="group" aria-label={`Confirm removing ${member.displayName}`}>
                    <span className="muted small">Remove {member.displayName}?</span>
                    <button className="danger" onClick={async () => { await runMemberAction(() => api.removeMember(token, communityId, member.userId)); setRemoving(undefined) }}>Remove</button>
                    <button onClick={() => setRemoving(undefined)}>Cancel</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {memberError && <p className="error small" role="alert">{memberError}</p>}
          {isTeacher && <button className="link" onClick={() => setDialog("invite")}>+ invite someone</button>}
          {leaving ? (
            <span className="confirm" role="group" aria-label="Confirm leaving">
              <span className="muted small">Leave this community?</span>
              <button className="danger" onClick={() => void runMemberAction(async () => { await api.leaveCommunity(token, communityId); onLeave() })}>Leave</button>
              <button onClick={() => setLeaving(false)}>Cancel</button>
            </span>
          ) : (
            <button className="link" onClick={() => { setMemberError(undefined); setLeaving(true) }}>leave this community</button>
          )}
        </section>

        <footer>
          <span className={`dot ${status === "live" ? "online" : "offline"}`} aria-hidden />
          <span className="muted">{status === "live" ? "live" : status}</span>
          <span className="muted"> · {cards.length} {cards.length === 1 ? "card" : "cards"} on file</span>
        </footer>
      </nav>

      <main>
        <header className="channel-head">
          <button
            className="nav-toggle"
            aria-label="Show channels"
            aria-expanded={navOpen}
            aria-controls="workspace-nav"
            onClick={() => setNavOpen(true)}
          >
            <span aria-hidden>☰</span>
          </button>
          <h1>{current ? (current.kind === "dm" ? current.name : `# ${current.name}`) : "No channel"}</h1>
          {current?.kind === "dm" && <p className="muted">Private. Only you and whoever created this agent can read it.</p>}
        </header>

        <Messages
          messages={rootMessages}
          members={data.members}
          agents={data.agents}
          cards={cards}
          emptyHint={current ? "Nothing here yet. Mention an agent by its full name to bring it in." : "Pick a channel to start."}
          replyCount={repliesFor}
          onOpenThread={(message) => void openThreadFor(message)}
          viewerId={session.user.id}
          onEdit={editMessage}
          onDownload={download}
          canDelete={(message) => message.authorId === session.user.id || data.role === "teacher"}
          onDelete={deleteMessage}
          onReact={react}
          onOpenCard={showCard}
        />

        {pending.length > 0 && (
          <ul className="pending" aria-label="Files ready to send">
            {pending.map((file) => (
              <li key={file.id}>
                {file.name} <span className="muted">{formatBytes(file.size)}</span>
                <button aria-label={`Remove ${file.name}`} onClick={() => void cancelPending(file.id)}>remove</button>
              </li>
            ))}
          </ul>
        )}

        {!!(channelId && typing[channelId]?.length) && (
          <p className="typing" aria-live="polite">
            {typing[channelId]
              .map((id) => data.members.find((member) => member.userId === id)?.displayName ?? "someone")
              .join(", ")}
            {typing[channelId].length === 1 ? " is typing…" : " are typing…"}
          </p>
        )}

        <form
          className="composer"
          onSubmit={(event) => { event.preventDefault(); void send() }}
        >
          <label className="attach" title="Attach a file">
            <input
              type="file"
              multiple
              disabled={!current || uploading}
              onChange={(event) => { void attach(event.target.files); event.target.value = "" }}
            />
            <span aria-hidden>{uploading ? "…" : "+"}</span>
            <span className="visually-hidden">Attach a file</span>
          </label>
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              announceTyping(event.target.value.trim().length > 0)
            }}
            onBlur={() => announceTyping(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send() }
            }}
            placeholder={
              !current ? "Pick a channel"
                : current.kind !== "dm" && current.joined === false ? `Join #${current.name} to post in it`
                : `Message ${current.kind === "dm" ? current.name : `#${current.name}`} — Enter to send, Shift+Enter for a new line`
            }
            disabled={!current || sending || (current.kind !== "dm" && current.joined === false)}
            rows={2}
          />
          <button className="primary" type="submit" disabled={!current || sending || (current.kind !== "dm" && current.joined === false) || (!draft.trim() && !pending.length)}>Send</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </main>

      {openCard && (
        <CardPanel
          card={openCard}
          cards={cards}
          agents={data.agents}
          onClose={() => setOpenCardId(undefined)}
          onOpenCard={showCard}
        />
      )}

      {openThread && threadRoot && (
        <aside className="thread-panel">
          <header className="channel-head">
            <h2>Thread</h2>
            <button className="link" onClick={() => setOpenThreadId(undefined)}>close</button>
          </header>
          <Messages
            messages={[threadRoot, ...threadReplies]}
            members={data.members}
            agents={data.agents}
            cards={cards}
            emptyHint="No replies yet."
            viewerId={session.user.id}
            onEdit={editMessage}
            onDownload={download}
            canDelete={(message) => message.authorId === session.user.id || data.role === "teacher"}
            onDelete={deleteMessage}
            onReact={react}
            onOpenCard={showCard}
          />
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendToThread() }}>
            <textarea
              value={threadDraft}
              onChange={(event) => setThreadDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendToThread() } }}
              placeholder="Reply in thread — mention an agent to bring it in here"
              rows={2}
            />
            <button className="primary" type="submit" disabled={!threadDraft.trim()}>Reply</button>
          </form>
        </aside>
      )}

      {editingAgent && (
        <EditAgent
          editing={editingAgent}
          channels={channels.map((channel) => ({ id: channel.id, name: channel.name }))}
          onClose={() => setEditingAgent(undefined)}
          onSave={async (input) => {
            await api.updateAgent(token, communityId, editingAgent.agentId, input)
            await load()
            setEditingAgent(undefined)
          }}
        />
      )}

      {dialog && (
        <Dialogs
          kind={dialog}
          token={token}
          communityId={communityId}
          channels={channels.map((channel) => ({ id: channel.id, name: channel.name }))}
          onClose={() => setDialog(undefined)}
          onDone={async (message) => { setNotice(message); await load() }}
        />
      )}

      {notice && (
        <div className="toast" role="status">
          <pre>{notice}</pre>
          <button onClick={() => setNotice(undefined)}>Dismiss</button>
        </div>
      )}
    </div>
  )
}

/* Editing an existing agent, as opposed to creating one. `channelIds` is sent
   whole because the server treats it as a replacement, so an unchecked box has
   to arrive as an absence rather than be omitted. */
function EditAgent({ editing, channels, onClose, onSave }: {
  editing: Editing
  channels: { id: string; name: string }[]
  onClose: () => void
  onSave: (input: { name: string; instructions: string; runtime: "claude" | "codex" | "api"; channelIds: string[] }) => Promise<void>
}) {
  const [name, setName] = useState(editing.name)
  const [instructions, setInstructions] = useState(editing.instructions)
  const [runtime, setRuntime] = useState<"claude" | "codex" | "api">(editing.runtime)
  /* An agent's channelIds also contains its DM channels, which are not
     assignable and would be rejected if sent back. Only the channels actually
     offered here can be picked, so the round trip stays valid. */
  const assignable = new Set(channels.map((channel) => channel.id))
  const [picked, setPicked] = useState<string[]>(editing.channelIds.filter((id) => assignable.has(id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(event) => event.stopPropagation()}>
        <h2>Edit {editing.name}</h2>

        <label htmlFor="edit-agent-name">Name</label>
        <input id="edit-agent-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />

        <label htmlFor="edit-agent-instructions">Instructions</label>
        <textarea id="edit-agent-instructions" rows={4} value={instructions} onChange={(event) => setInstructions(event.target.value)} />

        <label htmlFor="edit-agent-runtime">Runs on</label>
        <select id="edit-agent-runtime" value={runtime} onChange={(event) => setRuntime(event.target.value as "claude" | "codex" | "api")}>
          <option value="claude">claude — your Claude subscription</option>
          <option value="codex">codex — your Codex subscription</option>
          <option value="api">this server — no runner to start</option>
        </select>

        <fieldset>
          <legend>Channels it belongs to</legend>
          {channels.map((channel) => (
            <label key={channel.id} className="checkbox">
              <input
                type="checkbox"
                checked={picked.includes(channel.id)}
                onChange={(event) => setPicked((current) => event.target.checked ? [...current, channel.id] : current.filter((id) => id !== channel.id))}
              />
              # {channel.name}
            </label>
          ))}
        </fieldset>
        <p className="muted">Changing the runtime takes effect the next time its runner connects.</p>

        {error && <p className="error small" role="alert">{error}</p>}
        <div className="row">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true); setError(undefined)
              try {
                await onSave({ name: name.trim(), instructions, runtime, channelIds: picked })
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not save that")
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}

function Dialogs({ kind, token, communityId, channels, onClose, onDone }: {
  kind: Exclude<Dialog, undefined>
  token: string
  communityId: string
  channels: { id: string; name: string }[]
  onClose: () => void
  onDone: (notice: string) => void | Promise<void>
}) {
  const [name, setName] = useState("")
  const [instructions, setInstructions] = useState("")
  const [runtime, setRuntime] = useState<"claude" | "codex" | "api">("claude")
  const [visibility, setVisibility] = useState<"public" | "private">("public")
  const [role, setRole] = useState<"student" | "teacher">("student")
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const submit = async (): Promise<void> => {
    setBusy(true); setError(undefined)
    try {
      if (kind === "channel") {
        await api.createChannel(token, communityId, name.trim(), visibility)
        await onDone(`Created #${name.trim()}.`)
      } else if (kind === "invite") {
        const invite = await api.createInvite(token, communityId, role, "reusable")
        await onDone(`Invite code for a ${role}: ${invite.code}`)
      } else {
        const created = await api.createAgent(token, communityId, {
          name: name.trim(), instructions, runtime, model: "default", channelIds: picked,
        })
        /* The runner token is in this response and nowhere else. Showing the
           whole command once is the only chance to copy it. */
        await onDone(`Run this where your ${runtime} subscription is logged in.\nIt is shown once:\n\n${created.enrollment.setupCommand}`)
      }
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(event) => event.stopPropagation()}>
        <h2>{kind === "channel" ? "New channel" : kind === "invite" ? "Invite someone" : "New agent"}</h2>

        {kind === "invite" ? (
          <>
            <label htmlFor="role">They join as</label>
            <select id="role" value={role} onChange={(event) => setRole(event.target.value as "student" | "teacher")}>
              <option value="student">student</option>
              <option value="teacher">teacher</option>
            </select>
            <p className="muted">A reusable code. No email is sent — read it out or paste it wherever the group already talks.</p>
          </>
        ) : (
          <>
            <label htmlFor="dialog-name">Name</label>
            <input id="dialog-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus
              placeholder={kind === "channel" ? "questions" : "Elaine"} />
          </>
        )}

        {kind === "channel" && (
          <>
            <label htmlFor="visibility">Visibility</label>
            <select id="visibility" value={visibility} onChange={(event) => setVisibility(event.target.value as "public" | "private")}>
              <option value="public">public — any member can join</option>
              <option value="private">private — only who is added</option>
            </select>
          </>
        )}

        {kind === "agent" && (
          <>
            <label htmlFor="instructions">Instructions</label>
            <textarea id="instructions" rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)}
              placeholder="Answer from the course material. Say when you don't know." />
            <label htmlFor="runtime">Runs on</label>
            <select id="runtime" value={runtime} onChange={(event) => setRuntime(event.target.value as "claude" | "codex" | "api")}>
              <option value="claude">claude — your Claude subscription</option>
              <option value="codex">codex — your Codex subscription</option>
              <option value="api">this server — no runner to start</option>
            </select>
            <fieldset>
              <legend>Channels it belongs to</legend>
              {channels.map((channel) => (
                <label key={channel.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={picked.includes(channel.id)}
                    onChange={(event) => setPicked((current) => event.target.checked ? [...current, channel.id] : current.filter((id) => id !== channel.id))}
                  />
                  # {channel.name}
                </label>
              ))}
            </fieldset>
            <p className="muted">
              {runtime === "api"
                ? "Answered by this server, so there is nothing to start. It uses the endpoint this deployment is configured with."
                : "Elaine never asks for an API key. The agent runs where you are already signed in."}
            </p>
          </>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void submit()} disabled={busy || (kind !== "invite" && !name.trim())}>
            {busy ? "Working…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  )
}
