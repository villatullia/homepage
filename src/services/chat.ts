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
  input: { message: string; locale: string; context: ChatContext; clientMessageId?: string; clientToken?: string },
): { conversationId: string; token: string; messages: ChatMessage[]; created: boolean } {
  if (input.clientMessageId && input.clientToken) {
    const existing = db.prepare(`
      SELECT c.id FROM chat_conversations c
      JOIN chat_messages m ON m.conversation_id = c.id
      WHERE c.visitor_token_hash = ? AND m.client_message_id = ?
    `).get(sha256(input.clientToken), input.clientMessageId) as { id: string } | undefined;
    if (existing) return { conversationId: existing.id, token: input.clientToken, messages: publicMessages(db, existing.id), created: false };
  }
  const conversationId = randomUUID();
  const token = input.clientToken ?? randomToken();
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO chat_conversations
      (id, visitor_token_hash, locale, context_json, status, created_at, updated_at, last_visitor_message_at)
    VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?)
  `).run(conversationId, sha256(token), input.locale, JSON.stringify(input.context), timestamp, timestamp, timestamp);
  db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, sender, body, client_message_id, created_at)
    VALUES (?, ?, 'VISITOR', ?, ?, ?)
  `).run(randomUUID(), conversationId, input.message, input.clientMessageId ?? null, timestamp);
  return { conversationId, token, messages: publicMessages(db, conversationId), created: true };
}

export function ensureConversation(
  db: Database,
  input: { locale: string; context: ChatContext; clientToken: string },
): { conversationId: string; token: string; messages: ChatMessage[]; created: boolean } {
  const tokenHash = sha256(input.clientToken);
  const existing = db.prepare('SELECT id FROM chat_conversations WHERE visitor_token_hash = ?')
    .get(tokenHash) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE chat_conversations SET locale = ?, context_json = ?, status = 'OPEN', updated_at = ? WHERE id = ?")
      .run(input.locale, JSON.stringify(input.context), nowIso(), existing.id);
    return { conversationId: existing.id, token: input.clientToken, messages: publicMessages(db, existing.id), created: false };
  }
  const conversationId = randomUUID();
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO chat_conversations
      (id, visitor_token_hash, locale, context_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'OPEN', ?, ?)
  `).run(conversationId, tokenHash, input.locale, JSON.stringify(input.context), timestamp, timestamp);
  return { conversationId, token: input.clientToken, messages: [], created: true };
}

export function addVisitorMessage(db: Database, conversationId: string, body: string, clientMessageId?: string): { messages: ChatMessage[]; created: boolean } {
  if (clientMessageId && db.prepare('SELECT 1 FROM chat_messages WHERE client_message_id = ?').get(clientMessageId)) {
    return { messages: publicMessages(db, conversationId), created: false };
  }
  const timestamp = nowIso();
  db.prepare(`INSERT INTO chat_messages (id, conversation_id, sender, body, client_message_id, created_at) VALUES (?, ?, 'VISITOR', ?, ?, ?)`)
    .run(randomUUID(), conversationId, body, clientMessageId ?? null, timestamp);
  db.prepare(`UPDATE chat_conversations SET updated_at = ?, last_visitor_message_at = ? WHERE id = ?`)
    .run(timestamp, timestamp, conversationId);
  return { messages: publicMessages(db, conversationId), created: true };
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

export function updateConversationContext(db: Database, conversationId: string, currentJson: string, next: ChatContext | undefined): ChatContext {
  const current = JSON.parse(currentJson) as ChatContext;
  if (!next) return current;
  const merged = { ...current, ...next };
  db.prepare('UPDATE chat_conversations SET context_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(merged), nowIso(), conversationId);
  return merged;
}

export function telegramEnabled(config: AppConfig): boolean {
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID && config.TELEGRAM_WEBHOOK_SECRET);
}

export function wasForwardedToTelegram(db: Database, conversationId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM chat_telegram_links WHERE conversation_id = ? LIMIT 1').get(conversationId));
}

export function wasInterestForwarded(db: Database, interestId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM chat_interest_notifications WHERE id = ?').get(interestId));
}

export async function forwardInterestNotification(
  db: Database,
  config: AppConfig,
  conversationId: string,
  interestId: string,
  locale: string,
  context: ChatContext,
): Promise<boolean> {
  if (!telegramEnabled(config)) return false;
  const details = [
    '🔔 Someone clicked “Let’s make it happen”',
    '',
    context.selectedWeek ? `Selected week: ${context.selectedWeek}` : undefined,
    context.price ? `Price: ${context.price}` : undefined,
    `Language: ${locale.toUpperCase()}`,
    context.page ? `Page: ${context.page}` : undefined,
    '',
    'They have not written a message yet. Reply here to greet them in the website chat.',
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
  const timestamp = nowIso();
  db.prepare('INSERT OR IGNORE INTO chat_interest_notifications (id, conversation_id, created_at) VALUES (?, ?, ?)')
    .run(interestId, conversationId, timestamp);
  db.prepare('INSERT OR REPLACE INTO chat_telegram_links (telegram_message_id, conversation_id, created_at) VALUES (?, ?, ?)')
    .run(payload.result.message_id, conversationId, timestamp);
  return true;
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

export async function forwardVisitorTyping(config: AppConfig): Promise<boolean> {
  if (!telegramEnabled(config)) return false;
  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, action: 'typing' }),
    signal: AbortSignal.timeout(7000),
  });
  const payload = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.description || 'Telegram typing notification failed');
  return true;
}

export function conversationForTelegramReply(db: Database, telegramMessageId: number): string | undefined {
  return (db.prepare(`SELECT conversation_id FROM chat_telegram_links WHERE telegram_message_id = ?`).get(telegramMessageId) as { conversation_id: string } | undefined)?.conversation_id;
}
