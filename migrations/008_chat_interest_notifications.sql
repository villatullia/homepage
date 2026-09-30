CREATE TABLE IF NOT EXISTS chat_interest_notifications (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_interest_notifications_conversation_idx
  ON chat_interest_notifications(conversation_id, created_at DESC);
