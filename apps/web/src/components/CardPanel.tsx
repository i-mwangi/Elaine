import type { ReactElement } from "react"
import type { Agent, Card } from "@/lib/api"

/* Reading a card.

   A card is markdown a person wrote for other people, so it is rendered as
   prose rather than shown as a file. What is NOT decoration is the header: its
   type, its version, what it replaced, and which messages it came from. That is
   the difference between a page and a claim you can check. */

const time = (iso: string): string =>
  new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })

/* Enough markdown for what an agent writes: headings, list items, fenced code
   and paragraphs. Anything else is left as the text it is. */
function render(body: string): ReactElement[] {
  const blocks: ReactElement[] = []
  const parts = body.replace(/\r\n/g, "\n").split(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g)
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      blocks.push(<pre key={`code-${index}`}><code>{part.replace(/\n$/, "")}</code></pre>)
      return
    }
    for (const [paragraphIndex, paragraph] of part.split(/\n\s*\n/).entries()) {
      const lines = paragraph.split("\n").map((line) => line.trim()).filter(Boolean)
      if (!lines.length) continue
      const key = `${index}-${paragraphIndex}`
      const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0])
      if (heading && lines.length === 1) {
        blocks.push(<h4 key={key}>{heading[2]}</h4>)
        continue
      }
      if (lines.every((line) => /^([-*•]|\d+[.)])\s+/.test(line))) {
        blocks.push(
          <ul key={key}>
            {lines.map((line, item) => <li key={item}>{line.replace(/^([-*•]|\d+[.)])\s+/, "")}</li>)}
          </ul>,
        )
        continue
      }
      blocks.push(<p key={key}>{lines.join(" ")}</p>)
    }
  })
  return blocks
}

export function CardPanel({ card, cards, agents, onClose, onOpenCard }: {
  card: Card
  cards: Card[]
  agents: Agent[]
  onClose: () => void
  onOpenCard: (cardId: string) => void
}) {
  const author = agents.find((agent) => agent.id === card.agentId)?.name ?? "an agent"
  /* `replaces` points at what this card corrected. The old card is not deleted,
     so the trail stays walkable. */
  const replaced = card.replaces ? cards.find((item) => item.id === card.replaces) : undefined
  const replacedBy = cards.find((item) => item.replaces === card.id)

  return (
    <aside className="card-panel">
      <header className="channel-head">
        <div>
          <h2>{card.title}</h2>
          <p className="muted small">
            <span className={`badge type-${card.type}`}>{card.type}</span>
            {" "}v{card.version} · written by {author} · {time(card.createdAt)}
          </p>
        </div>
        <button className="link" onClick={onClose}>close</button>
      </header>

      <div className="card-body">
        {render(card.body)}

        <dl className="card-meta">
          <dt>Path</dt>
          <dd><code>{card.path}</code></dd>

          <dt>Sources</dt>
          <dd>
            {card.sourceMessageIds.length
              ? `${card.sourceMessageIds.length} message${card.sourceMessageIds.length === 1 ? "" : "s"} in this community`
              : "none recorded"}
          </dd>

          {replaced && (
            <>
              <dt>Replaces</dt>
              <dd>
                <button className="link" onClick={() => onOpenCard(replaced.id)}>{replaced.title}</button>
                {" "}— kept, not deleted
              </dd>
            </>
          )}

          {replacedBy && (
            <>
              <dt>Replaced by</dt>
              <dd>
                <button className="link" onClick={() => onOpenCard(replacedBy.id)}>{replacedBy.title}</button>
                {" "}— this one is superseded
              </dd>
            </>
          )}
        </dl>
      </div>
    </aside>
  )
}
