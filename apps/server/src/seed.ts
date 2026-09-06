/* `npm run seed` — a community worth opening.

   This is NOT a port of the old repo's seed, which loaded the legacy
   course-fixture stack (modules, assignments, feedback, reports) that this
   build deliberately does not have. It seeds what this model actually has: a
   teacher, a student, a channel, two agents, and a question waiting.

   It goes through the store rather than writing rows directly, so a seeded
   community is reachable by exactly the same rules as one made in the UI —
   a seed that bypassed authorization would be a seed that proves nothing. */
import { writeFileSync } from "node:fs"
import { openDatabase } from "./db.js"
import {
  createAgent, createChannel, createCommunity, createInvite, createMessage,
  createUser, joinChannel, redeemInvite,
} from "./store.js"

const DEMO = "Neural Networks 2026"

export type SeedResult = {
  communityId: string
  channelId: string
  teacher: { name: string; token: string }
  student: { name: string; token: string }
  inviteCode: string
  agents: { name: string; agentId: string; setupCommand: string }[]
}

const setupCommand = (agentId: string, token: string, runtime: string): string =>
  `npm run runner -- --token ${token} --runtime ${runtime} --cwd ./agents/${agentId}`

export function seed(databaseFile: string, options: { force?: boolean } = {}): SeedResult {
  const database = openDatabase(databaseFile)
  try {
    const existing = database.prepare("SELECT id FROM communities WHERE name = ?").get(DEMO) as { id?: string } | undefined
    if (existing && !options.force) {
      /* Seeding twice would silently pile up identical communities and leave
         you guessing which keys belong to which. */
      throw new Error(`"${DEMO}" already exists in ${databaseFile}. Delete the database, or run with --force to add another.`)
    }

    const teacher = createUser(database, "Henry")
    const student = createUser(database, "Harry")
    const { community } = createCommunity(database, teacher.user, { name: DEMO, term: "2026" })

    const invite = createInvite(database, community.id, teacher.user, { role: "student", mode: "reusable" })
    redeemInvite(database, student.user, invite.code)

    const channel = createChannel(database, community.id, teacher.user, { name: "questions", visibility: "public" })
    joinChannel(database, community.id, student.user, channel.id)

    const elaine = createAgent(database, community.id, teacher.user, {
      name: "Elaine", instructions: "Answer from the cards. Cite them. Say when you don't know.",
      runtime: "claude", model: "default", channelIds: [channel.id],
    }, new Map())
    const turing = createAgent(database, community.id, teacher.user, {
      name: "Turing", instructions: "Answer from the cards.",
      runtime: "codex", model: "default", channelIds: [],
    }, new Map())

    /* Something to answer, so the first thing you see is a question rather than
       an empty room. */
    createMessage(database, community.id, student.user, channel.id, {
      paragraphs: [[{ kind: "text", text: "Does anyone have a clean explanation of backprop?" }]],
    })

    return {
      communityId: community.id,
      channelId: channel.id,
      teacher: { name: "Henry", token: teacher.token },
      student: { name: "Harry", token: student.token },
      inviteCode: invite.code,
      agents: [
        { name: "Elaine", agentId: elaine.agent.id, setupCommand: setupCommand(elaine.agent.id, elaine.token, "claude") },
        { name: "Turing", agentId: turing.agent.id, setupCommand: setupCommand(turing.agent.id, turing.token, "codex") },
      ],
    }
  } finally {
    database.close()
  }
}

if (process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.js")) {
  const databaseFile = process.env.ELAINE_DB ?? "elaine.db"
  const result = seed(databaseFile, { force: process.argv.includes("--force") })

  console.log(`\nSeeded "${DEMO}" into ${databaseFile}\n`)
  console.log(`  community   ${result.communityId}`)
  console.log(`  #questions  ${result.channelId}\n`)
  /* These are the only time each key is readable, so they are printed in full
     and written to a file rather than left to be scrolled back to. */
  console.log(`  Henry (teacher)  ${result.teacher.token}`)
  console.log(`  Harry (student)  ${result.student.token}`)
  console.log(`  invite code      ${result.inviteCode}\n`)
  console.log("  Bring an agent to life where its provider CLI is logged in:")
  for (const agent of result.agents) console.log(`    ${agent.name}: ${agent.setupCommand}`)

  writeFileSync("seed.local.json", JSON.stringify(result, null, 2) + "\n")
  console.log("\n  Written to seed.local.json (gitignored).\n")
}
