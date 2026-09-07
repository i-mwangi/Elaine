# Elaine

**Humans and agents learn together, and what they learn stays with them.**

Elaine is a course community where people and AI agents share the same channels,
and what the group understands once compiles into **cards**: markdown pages with
a type, a version, sources and "replaces". They live on the filesystem, so
there's nothing in here the group can't `ls`.

Built for **organizations that run cohort-based courses — bootcamps,
academies, corporate training programs, universities**.

## How an answer works

An agent answers one of two ways, and it always tells you which.

**Compiled.** Nothing on file covered the question, so it worked the answer out
and wrote a card.

**Composed.** Cards already covered it, so the answer is built from them and
carries a seal that links to the ones it used:

> already on file · 3 days ago

The second one isn't a cache. That answer is written fresh for whoever asked. It
just isn't made up from scratch, and it says where it came from.

A card also never gets published because a model said it learned something. It
gets published because a file changed. The agent writes markdown into a folder,
and the diff on that folder is what makes the card. If the model claims it
updated its notes and no file moved, nothing happens.

## What's here

| Piece | State |
|---|---|
| `apps/web` — React 19 + Vite client: channels, threads, members, private conversations, the card reader | ✅ |
| `apps/server` — Hono + SQLite: communities, memberships, channels, messages, agents, invites, filtered WS events | ✅ |
| `packages/protocol` — the Zod contract both ends parse against | ✅ |
| `packages/runner` — outbound runner for agents that use a subscription CLI | ✅ |
| cards on the filesystem, published from a wiki diff | ✅ |

## Run it

```bash
npm install
```

```bash
npm run seed
```

```bash
npm run dev
```

The client is on <http://localhost:5173> and proxies to the server on `:8787`.
`npm run seed` prints sign-in keys for a teacher and a student and writes them to
`seed.local.json`, which is gitignored.

## Configuring the model

An agent is created in the browser and runs in the server, so there's nothing to
start on anyone's machine. It needs one endpoint, given as three variables in a
`.env` file at the repository root. No provider is named anywhere in the code,
so switching provider is an edit to this file and nothing else.

The key is read from the environment, used to sign the request, and never
written to the database, a projection, an event, or a prompt. There's a check
for each of those.

```
ELAINE_API_BASE_URL=   an OpenAI-compatible base, e.g. https://host/v1
ELAINE_API_KEY=        the bearer token for that endpoint
ELAINE_API_MODEL=      the model name to request
```

### Google Gemini

Gemini publishes an OpenAI-compatible endpoint, so it needs no code change. Get
a key from Google AI Studio and use:

```
ELAINE_API_KEY=<your Google AI Studio key>
ELAINE_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
ELAINE_API_MODEL=gemini-2.5-flash
```

A trailing slash on the base URL is fine. It gets trimmed before the path is
appended.

### Anything else

Any endpoint that speaks the OpenAI chat-completions shape works the same way.
Set the base URL up to and including `/v1`, and the model name exactly as that
provider spells it.

Restart the server after editing `.env`. The values are read when the process
starts.

### What an endpoint has to support

The runtime only assumes four things, which is what keeps a provider swap to an
`.env` edit:

1. `POST <base>/chat/completions`
2. `Authorization: Bearer <key>`
3. A response shaped `{ choices: [{ message: { content } }] }`
4. `messages`, `model` and `temperature` in the request body

It also asks for `response_format: { type: "json_object" }`, because the model
has to return its answer and any cards together and one that drifts into prose
loses the cards quietly. That part isn't a requirement. An endpoint that refuses
the field gets retried once without it, and a reply wrapped in a code fence gets
unwrapped.

## How it's put together

An agent is **identity + folder + runner**. The identity lives in the database,
the folder is where its markdown lives, and the runner is whatever executes the
model and writes into that folder. Keeping those three separate is what lets the
same agent run in the server today and on someone's own machine tomorrow without
changing how cards are published.

Multi-tenancy is in the schema rather than bolted on. A user is global, a
membership joins them to one community with a role, and every row that belongs
to a community carries its `communityId`. Not-found and forbidden give the same
response, so you can't map out what exists by reading refusals. Socket events are
filtered per viewer before they're sent, so membership decides what arrives
rather than the client deciding what to render.

## Checks

```bash
npm run check
```

Typechecks every workspace, then runs three executable checks and the web build:

- **core** — the domain end to end: multi-tenancy, permissions, channels,
  messages, threads, reactions, attachments, unread, agent lifecycle, and the
  seal.
- **api** — the server-run agent against a stub endpoint: a mention compiles a
  card and publishes it, the next question composes from that card and carries
  the seal, an endpoint that refuses `response_format` is retried without it,
  and the key reaches neither a prompt, a projection, nor the database.
- **runner** — the CLI runtimes: process handling, bounded output, and the
  stripping of provider keys and inherited Node options from the child.

There's no unit-test framework. Each check is a script that fails loudly.

---

An agent can also be given `runtime: "claude"` or `runtime: "codex"` instead, in
which case its model runs through that CLI on someone's own machine rather than
in the server. The runner dials out, so the provider credential stays where it
already is and Elaine only gets the finished work back. Start one with
`npm run runner` and the setup command the UI prints.
