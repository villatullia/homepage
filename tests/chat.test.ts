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
        clientMessageId: '2df85d8c-6011-4bbb-958d-99cb85e865ab',
        clientToken: 'visitor-generated-token-that-is-long-enough',
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { conversationId: string; token: string; telegramForwarded: boolean };
    expect(body.token).toBeTruthy();
    expect(body.telegramForwarded).toBe(false);
    const stored = context.db.prepare('SELECT visitor_token_hash, context_json FROM chat_conversations WHERE id = ?').get(body.conversationId) as { visitor_token_hash: string; context_json: string };
    expect(stored.visitor_token_hash).toBe(sha256(body.token));
    expect(stored.context_json).not.toContain('email');

    const retried = await app.inject({
      method: 'POST',
      url: '/api/chat/conversations',
      payload: {
        message: 'Is the pool open in May?',
        locale: 'en',
        context: { page: '/calendarw.html' },
        clientMessageId: '2df85d8c-6011-4bbb-958d-99cb85e865ab',
        clientToken: 'visitor-generated-token-that-is-long-enough',
      },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().conversationId).toBe(body.conversationId);
    expect(context.db.prepare("SELECT COUNT(*) count FROM chat_messages WHERE sender = 'VISITOR'").get()).toEqual({ count: 1 });

    expect((await app.inject({ method: 'GET', url: `/api/chat/conversations/${body.conversationId}/messages` })).statusCode).toBe(404);
    const followUp = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${body.conversationId}/messages`,
      headers: { 'x-chat-token': body.token },
      payload: { message: 'And is it heated?', clientMessageId: 'bbf78ad5-04bb-4137-8e27-a335805a90df', context: { page: '/calendarw.html', selectedWeek: '22–29 May 2027', price: '€3,850' } },
    });
    expect(followUp.statusCode).toBe(201);
    const repeatedFollowUp = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${body.conversationId}/messages`,
      headers: { 'x-chat-token': body.token },
      payload: { message: 'And is it heated?', clientMessageId: 'bbf78ad5-04bb-4137-8e27-a335805a90df' },
    });
    expect(repeatedFollowUp.statusCode).toBe(200);
    expect((context.db.prepare('SELECT context_json FROM chat_conversations WHERE id = ?').get(body.conversationId) as { context_json: string }).context_json)
      .toContain('22–29 May 2027');
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
    const telegramFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 987 } }), { status: 200 }));
    vi.stubGlobal('fetch', telegramFetch);
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
    expect((await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${chat.conversationId}/typing`,
      headers: { 'x-chat-token': chat.token },
    })).statusCode).toBe(204);
    expect(telegramFetch).toHaveBeenCalledWith(expect.stringContaining('/sendChatAction'), expect.objectContaining({
      body: JSON.stringify({ chat_id: '123456', action: 'typing' }),
    }));
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
