ALTER TABLE chat_messages ADD COLUMN client_message_id TEXT;

CREATE UNIQUE INDEX chat_messages_client_id_unique
  ON chat_messages(client_message_id)
  WHERE client_message_id IS NOT NULL;
