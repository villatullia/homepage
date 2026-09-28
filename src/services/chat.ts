import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { sha256, randomToken } from '../lib/crypto.js';
import { nowIso } from '../lib/format.js';

export interface ChatContext {
  page?: string;
  selectedWeek?: string;
  price?: string;
}

export interface ChatMessage {
  id: string;
  sender: 'visitor' | 'owner';
  body: string;
  createdAt: string;
}

function publicMessages(db: Database, conversationId: string): ChatMessage[] {
  return (db.prepare(`
    SELECT id, sender, body, created_at FROM chat_messages
    WHERE conversation_id = ? ORDER BY created_at, id
  `).all(conversationId) as Array<{ id: string; sender: 'VISITOR' | 'OWNER'; body: string; created_at: string }>).map((message) => ({
    id: message.id,
    sender: message.sender === 'OWNER' ? 'owner' : 'visitor',
    body: message.body,
    createdAt: message.created_at,
  }));
}

export function authorizedConversation(db: Database, conversationId: string, token: string | undefined) {
  if (!token) return undefined;
  return db.prepare(`
    SELECT id, locale, context_json, status FROM chat_conversations
    WHERE id = ? AND visitor_token_hash = ? AND status = 'OPEN'
  `).get(conversationId, sha256(token)) as { id: string; locale: string; context_json: string; status: string } | undefined;
}

export function createConversation(
  db: Database,
  input: { message: string; locale: string; context: ChatContext },
): { conversationId: string; token: string; messages: ChatMessage[] } {
  const conversationId = randomUUID();
  const token = randomToken();
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO chat_conversations
      (id, visitor_token_hash, locale, context_json, status, created_at, updated_at, last_visitor_message_at)
    VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?)
  `).run(conversationId, sha256(token), input.locale, JSON.stringify(input.context), timestamp, timestamp, timestamp);
  db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, sender, body, created_at)
    VALUES (?, ?, 'VISITOR', ?, ?)
  `).run(randomUUID(), conversationId, input.message, timestamp);
  return { conversationId, token, messages: publicMessages(db, conversationId) };
}

export function addVisitorMessage(db: Database, conversationId: string, body: string): ChatMessage[] {
  const timestamp = nowIso();
  db.prepare(`INSERT INTO chat_messages (id, conversation_id, sender, body, created_at) VALUES (?, ?, 'VISITOR', ?, ?)`)
    .run(randomUUID(), conversationId, body, timestamp);
  db.prepare(`UPDATE chat_conversations SET updated_at = ?, last_visitor_message_at = ? WHERE id = ?`)
    .run(timestamp, timestamp, conversationId);
  return publicMessages(db, conversationId);
}

export function addOwnerMessage(db: Database, conversationId: string, body: string, telegramUpdateId?: number): ChatMessage[] {
  const timestamp = nowIso();
  db.prepare(`INSERT INTO chat_messages (id, conversation_id, sender, body, telegram_update_id, created_at) VALUES (?, ?, 'OWNER', ?, ?, ?)`)
    .run(randomUUID(), conversationId, body, telegramUpdateId ?? null, timestamp);
  db.prepare(`UPDATE chat_conversations SET updated_at = ?, last_owner_message_at = ? WHERE id = ?`)
    .run(timestamp, timestamp, conversationId);
  return publicMessages(db, conversationId);
}

export function getMessages(db: Database, conversationId: string): ChatMessage[] {
  return publicMessages(db, conversationId);
}

export function telegramEnabled(config: AppConfig): boolean {
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID && config.TELEGRAM_WEBHOOK_SECRET);
}

export async function forwardVisitorMessage(
  db: Database,
  config: AppConfig,
  conversationId: string,
  body: string,
  locale: string,
  context: ChatContext,
): Promise<boolean> {
  if (!telegramEnabled(config)) return false;
  const details = [
    '💬 Villa Tullia website chat',
    '',
    body,
    '',
    context.selectedWeek ? `Selected week: ${context.selectedWeek}` : undefined,
    context.price ? `Price: ${context.price}` : undefined,
    `Language: ${locale.toUpperCase()}`,
    context.page ? `Page: ${context.page}` : undefined,
    '',
    'Reply to this message to answer the visitor.',
  ].filter((line) => line !== undefined).join('\n');
  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.TELEGRAM_CHAT_ID,
      text: details,
      reply_markup: { force_reply: true, input_field_placeholder: 'Reply to this visitor' },
    }),
    signal: AbortSignal.timeout(7000),
  });
  const payload = await response.json() as { ok?: boolean; description?: string; result?: { message_id?: number } };
  if (!response.ok || !payload.ok || !payload.result?.message_id) throw new Error(payload.description || 'Telegram delivery failed');
  db.prepare(`INSERT OR REPLACE INTO chat_telegram_links (telegram_message_id, conversation_id, created_at) VALUES (?, ?, ?)`)
    .run(payload.result.message_id, conversationId, nowIso());
  return true;
}

export function conversationForTelegramReply(db: Database, telegramMessageId: number): string | undefined {
  return (db.prepare(`SELECT conversation_id FROM chat_telegram_links WHERE telegram_message_id = ?`).get(telegramMessageId) as { conversation_id: string } | undefined)?.conversation_id;
}
