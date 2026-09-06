-- A user is global; a membership joins it to one community with a role there.
-- Only token DIGESTS are stored: the raw token exists in the response that
-- mints it and nowhere else.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  term TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (community_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'dm')),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  -- Set only for a dm: the student/agent pair it belongs to.
  user_id TEXT,
  agent_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_community ON channels(community_id);
CREATE UNIQUE INDEX IF NOT EXISTS channels_dm_pair ON channels(community_id, user_id, agent_id) WHERE kind = 'dm';

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  member_kind TEXT NOT NULL CHECK (member_kind IN ('user', 'agent')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, member_id)
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  runtime TEXT NOT NULL CHECK (runtime IN ('claude', 'codex', 'api')),
  model TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')),
  -- Whoever creates the agent sees what the agent writes.
  created_by TEXT NOT NULL,
  runner_token_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_community ON agents(community_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent')),
  -- { paragraphs: [...], fromFile?: { cardIds, oldestAgo } }
  body TEXT NOT NULL,
  thread_id TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(community_id, channel_id, created_at);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  root_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  created_at TEXT NOT NULL
);

-- A card is a page in an agent's wiki, mirrored here so the community can read
-- it. Its identity is (community, agent, path); a new version replaces rather
-- than edits, and `replaces` keeps the trail.
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  replaces TEXT,
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (community_id, agent_id, path)
);
CREATE INDEX IF NOT EXISTS cards_channel ON cards(community_id, channel_id, created_at);

-- One row per person per emoji per message. The primary key is the idempotency
-- rule: reacting twice with the same emoji is the same fact, not two.
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS message_reactions_message ON message_reactions(message_id);

-- Where each person had got to in each channel. Ported from the old repo's
-- channel_reads: the client supplies the timestamp it has actually displayed,
-- so a marker can never claim more than was on screen.
CREATE TABLE IF NOT EXISTS channel_reads (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

-- Attachment metadata; the bytes live on disk under the file store. A file is
-- "unattached" until a message claims it, which is what makes an upload
-- cancellable and a posted file permanent.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL REFERENCES users(id),
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
