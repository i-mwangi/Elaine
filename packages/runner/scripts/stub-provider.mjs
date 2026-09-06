/* Stands in for the `claude` binary during the runner check.

   It behaves the way the card rules ask an agent to behave, so the check can
   assert the runner's side of that contract without a subscription:
   - the first time it is asked, it COMPILES: it writes a card into wiki/ and
     cites it;
   - afterwards it COMPOSES: it writes nothing and cites the existing card.

   It also records whether a provider API key survived into its environment,
   which is the thing the runner promises to strip. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const cwd = process.cwd()
let prompt = ""
process.stdin.setEncoding("utf8")
for await (const chunk of process.stdin) prompt += chunk

writeFileSync(join(cwd, "env-probe.json"), JSON.stringify({
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
  openaiKey: process.env.OPENAI_API_KEY ?? null,
  elaineToken: process.env.ELAINE_RUNNER_TOKEN ?? null,
  sawPrompt: prompt.length > 0,
  prompt,
  argv: process.argv.slice(2),
}, null, 2))

const card = join(cwd, "wiki", "modules", "backprop.md")
const sourceMatch = /sources: \[([^\]]+)\]/.exec(prompt)

if (!existsSync(card)) {
  mkdirSync(dirname(card), { recursive: true })
  writeFileSync(card, `---
type: topic
title: Backpropagation
sources: [${sourceMatch ? sourceMatch[1] : ""}]
---

Backprop applies the chain rule backwards through the network.
`)
  process.stdout.write("I read the material and wrote this up. Backprop is the chain rule applied backwards through the network [[modules/backprop.md|Backpropagation]].\n")
} else {
  /* Composing: nothing is written, and the answer is built from the card. */
  const body = readFileSync(card, "utf8")
  process.stdout.write(`Short version, from what we already worked out: ${body.includes("chain rule") ? "it is the chain rule, applied backwards" : "see the card"} [[modules/backprop.md|Backpropagation]].\n`)
}
