import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { safeEqual } from '../lib/crypto.js';
import {
  addOwnerMessage,
  addVisitorMessage,
  authorizedConversation,
  conversationForTelegramReply,
  createConversation,
  forwardVisitorMessage,
  forwardVisitorTyping,
  getMessages,
  telegramEnabled,
} from '../services/chat.js';

const messageSchema = z.string().trim().min(1).max(1000);
const contextSchema = z.object({
  page: z.string().max(300).optional(),
  selectedWeek: z.string().max(100).optional(),
  price: z.string().max(50).optional(),
}).default({});
const createSchema = z.object({ message: messageSchema, locale: z.enum(['en', 'de', 'it', 'nl']).default('en'), context: contextSchema });

export async function registerChatRoutes(app: FastifyInstance, deps: { db: Database; config: AppConfig }): Promise<void> {
  const { db, config } = deps;

  app.post('/api/chat/conversations', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please enter a shorter message.' });
    const conversation = createConversation(db, parsed.data);
    let telegramForwarded = false;
    try {
      telegramForwarded = await forwardVisitorMessage(db, config, conversation.conversationId, parsed.data.message, parsed.data.locale, parsed.data.context);
    } catch (error) {
      request.log.error({ err: error, conversationId: conversation.conversationId }, 'Telegram chat notification failed');
    }
    return reply.code(201).send({ ...conversation, telegramForwarded });
  });

  app.get('/api/chat/conversations/:id/messages', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const token = request.headers['x-chat-token'];
    if (!authorizedConversation(db, id, typeof token === 'string' ? token : undefined)) return reply.code(404).send({ error: 'Conversation unavailable' });
    return reply.header('Cache-Control', 'no-store').send({ messages: getMessages(db, id), telegramEnabled: telegramEnabled(config) });
  });

  app.post('/api/chat/conversations/:id/messages', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const token = request.headers['x-chat-token'];
    const conversation = authorizedConversation(db, id, typeof token === 'string' ? token : undefined);
    if (!conversation) return reply.code(404).send({ error: 'Conversation unavailable' });
    const parsed = z.object({ message: messageSchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please enter a shorter message.' });
    const messages = addVisitorMessage(db, id, parsed.data.message);
    let telegramForwarded = false;
    try {
      telegramForwarded = await forwardVisitorMessage(db, config, id, parsed.data.message, conversation.locale, JSON.parse(conversation.context_json));
    } catch (error) {
      request.log.error({ err: error, conversationId: id }, 'Telegram chat notification failed');
    }
    return reply.code(201).send({ messages, telegramForwarded });
  });

  app.post('/api/chat/conversations/:id/typing', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const token = request.headers['x-chat-token'];
    if (!authorizedConversation(db, id, typeof token === 'string' ? token : undefined)) return reply.code(404).send({ error: 'Conversation unavailable' });
    try {
      await forwardVisitorTyping(config);
    } catch (error) {
      request.log.warn({ err: error, conversationId: id }, 'Telegram typing notification failed');
    }
    return reply.code(204).send();
  });

  app.post('/api/chat/conversations/:id/test-reply', async (request, reply) => {
    if (config.NODE_ENV === 'production') return reply.code(404).send({ error: 'Not found' });
    const id = (request.params as { id: string }).id;
    const token = request.headers['x-chat-token'];
    if (!authorizedConversation(db, id, typeof token === 'string' ? token : undefined)) return reply.code(404).send({ error: 'Conversation unavailable' });
    const parsed = z.object({ message: messageSchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please enter a shorter message.' });
    return reply.code(201).send({ messages: addOwnerMessage(db, id, parsed.data.message) });
  });

  app.post('/webhooks/telegram', async (request, reply) => {
    if (!telegramEnabled(config)) return reply.code(404).send({ error: 'Not configured' });
    const secret = request.headers['x-telegram-bot-api-secret-token'];
    if (typeof secret !== 'string' || !safeEqual(secret, config.TELEGRAM_WEBHOOK_SECRET)) return reply.code(401).send({ error: 'Invalid webhook secret' });
    const update = request.body as { update_id?: number; message?: { message_id?: number; text?: string; chat?: { id?: number }; reply_to_message?: { message_id?: number } } };
    const message = update.message;
    if (!Number.isInteger(update.update_id) || !message?.text || String(message.chat?.id) !== config.TELEGRAM_CHAT_ID) return reply.send({ ok: true });
    const repliedTo = message.reply_to_message?.message_id;
    if (!repliedTo) return reply.send({ ok: true });
    const conversationId = conversationForTelegramReply(db, repliedTo);
    if (!conversationId) return reply.send({ ok: true });
    try {
      addOwnerMessage(db, conversationId, message.text.trim().slice(0, 1000), update.update_id);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('UNIQUE constraint failed')) throw error;
    }
    return reply.send({ ok: true });
  });
}
