import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/lib/crypto.js';
import { createTestContext } from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllGlobals();
});

describe('anonymous website chat', () => {
  it('creates a token-protected conversation without contact details and supports local test replies', async () => {
    const context = createTestContext();
    const app = await buildApp({ config: context.config, db: context.db, logger: false });
    cleanup.push(async () => { await app.close(); context.close(); });

    const created = await app.inject({
      method: 'POST',
      url: '/api/chat/conversations',
      payload: {
        message: 'Is the pool open in May?',
        locale: 'en',
        context: { page: '/calendarw.html', selectedWeek: '15–22 May 2027', price: '€3,675' },
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { conversationId: string; token: string; telegramForwarded: boolean };
    expect(body.token).toBeTruthy();
    expect(body.telegramForwarded).toBe(false);
    const stored = context.db.prepare('SELECT visitor_token_hash, context_json FROM chat_conversations WHERE id = ?').get(body.conversationId) as { visitor_token_hash: string; context_json: string };
    expect(stored.visitor_token_hash).toBe(sha256(body.token));
    expect(stored.context_json).not.toContain('email');

    expect((await app.inject({ method: 'GET', url: `/api/chat/conversations/${body.conversationId}/messages` })).statusCode).toBe(404);
    const followUp = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${body.conversationId}/messages`,
      headers: { 'x-chat-token': body.token },
      payload: { message: 'And is it heated?' },
    });
    expect(followUp.statusCode).toBe(201);
    const testReply = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${body.conversationId}/test-reply`,
      headers: { 'x-chat-token': body.token },
      payload: { message: 'Yes, I will confirm the seasonal dates for you.' },
    });
    expect(testReply.statusCode).toBe(201);
    expect(testReply.json().messages).toHaveLength(3);
  });

  it('forwards visitor messages and accepts only authenticated Telegram replies from the configured chat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 987 } }), { status: 200 })));
    const context = createTestContext({
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
      TELEGRAM_CHAT_ID: '123456',
      TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret',
    });
    const app = await buildApp({ config: context.config, db: context.db, logger: false });
    cleanup.push(async () => { await app.close(); context.close(); });

    const created = await app.inject({
      method: 'POST',
      url: '/api/chat/conversations',
      payload: { message: 'Can we bring a cot?', locale: 'en', context: { selectedWeek: '15–22 May 2027' } },
    });
    const chat = created.json() as { conversationId: string; token: string; telegramForwarded: boolean };
    expect(chat.telegramForwarded).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/webhooks/telegram', payload: {} })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST',
      url: '/webhooks/telegram',
      headers: { 'x-telegram-bot-api-secret-token': 'test_webhook_secret' },
      payload: { update_id: 42, message: { message_id: 988, text: 'Yes, a cot is available.', chat: { id: 123456 }, reply_to_message: { message_id: 987 } } },
    })).statusCode).toBe(200);

    const messages = await app.inject({
      method: 'GET',
      url: `/api/chat/conversations/${chat.conversationId}/messages`,
      headers: { 'x-chat-token': chat.token },
    });
    expect(messages.json().messages).toMatchObject([
      { sender: 'visitor', body: 'Can we bring a cot?' },
      { sender: 'owner', body: 'Yes, a cot is available.' },
    ]);
    expect(context.db.prepare('SELECT COUNT(*) count FROM chat_messages WHERE telegram_update_id = 42').get()).toEqual({ count: 1 });
  });
});
