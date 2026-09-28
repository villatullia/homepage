CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  visitor_token_hash TEXT NOT NULL UNIQUE,
  locale TEXT NOT NULL DEFAULT 'en',
  context_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','SPAM')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_visitor_message_at TEXT,
  last_owner_message_at TEXT
);

CREATE INDEX IF NOT EXISTS chat_conversations_updated_idx ON chat_conversations(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('VISITOR','OWNER')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  telegram_update_id INTEGER UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages(conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS chat_telegram_links (
  telegram_message_id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
