import { describe, expect, it } from 'vitest';

import {
  buildCallbackData,
  createReview,
  decideReview,
  expirePendingReviews,
  parseCallbackData,
  DEFAULT_REVIEW_TTL_MS,
} from '../src/reviews';
import { handleTelegramWebhook } from '../src/routes/telegram';
import type { BotApiClient, TelegramResult } from '../src/telegram/client';
import { MemoryControlStore } from './memory-store';

const NOW = Date.parse('2026-09-11T10:00:00Z');

interface FakeBot extends BotApiClient {
  calls: Array<{ method: string; payload: unknown }>;
  /** Optional script: return a crafted Telegram result for one method. */
  script?: (method: string) => TelegramResult | undefined;
}

function fakeBot(botId = 'bot1'): FakeBot {
  const calls: FakeBot['calls'] = [];
  const bot = {
    botId,
    calls,
    script: undefined as ((method: string) => TelegramResult | undefined) | undefined,
    answerCallbackQuery: async (id: string, text?: string) => record('answerCallbackQuery', { id, text }),
    copyMessage: async (input: Parameters<BotApiClient['copyMessage']>[0]) => record('copyMessage', input),
    copyMessages: async (input: Parameters<BotApiClient['copyMessages']>[0]) => record('copyMessages', input),
    editMessageReplyMarkup: async (input: Parameters<BotApiClient['editMessageReplyMarkup']>[0]) =>
      record('editMessageReplyMarkup', input),
    sendMessage: async (input: Parameters<BotApiClient['sendMessage']>[0]) => record('sendMessage', input),
  } satisfies FakeBot;

  function record(method: string, payload: unknown): TelegramResult {
    calls.push({ method, payload });
    const scripted = bot.script?.(method);
    return scripted ?? { ok: true, result: { message_id: 555 } };
  }

  return bot;
}

async function seedReview(
  store: MemoryControlStore,
  overrides: Partial<Parameters<typeof createReview>[1]> = {},
  nowMs = NOW
) {
  return createReview(
    store,
    {
      id: 'rv1',
      botId: 'bot1',
      chatId: '-100review',
      messageId: 42,
      publishChatId: '-100channel',
      targetId: 'bot1-illust-botefuku',
      workId: '29088506',
      slotId: 'bot1-daily@2026-09-11T1800',
      ...overrides,
    },
    nowMs
  );
}

describe('creating a review is idempotent per work', () => {
  it('returns the existing review when the runner reports the same work twice', async () => {
    const store = new MemoryControlStore();
    const first = await seedReview(store);
    const second = await seedReview(store, { id: 'rv-duplicate', messageId: 99 });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe('rv1');
    // The original message ids are kept: a retried callback cannot re-point the
    // review at a second copy of the media.
    expect(second.record.messageId).toBe(42);
    expect(store.reviews.size).toBe(1);
  });
});

describe('decisions are write-once and side effects follow the winner', () => {
  it('approves once and publishes by server-side copy', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    await seedReview(store);

    const outcome = await decideReview(
      { store, getBot: () => bot },
      { reviewId: 'rv1', action: 'approve', actor: 'owner' },
      NOW + 1000
    );

    expect(outcome).toMatchObject({ status: 'approved', decided: true, published: true });
    const copies = bot.calls.filter((call) => call.method === 'copyMessage');
    expect(copies).toHaveLength(1);
    expect(copies[0]!.payload).toMatchObject({
      fromChatId: '-100review',
      messageId: 42,
      toChatId: '-100channel',
    });
    const review = (await store.getReview('rv1'))!;
    expect(review.status).toBe('approved');
    expect(review.publishedMessageId).toBe(555);
    expect(review.decidedBy).toBe('owner');
  });

  it('a replayed approve does not publish again', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    await seedReview(store);

    await decideReview({ store, getBot: () => bot }, { reviewId: 'rv1', action: 'approve' }, NOW + 1000);
    const replay = await decideReview(
      { store, getBot: () => bot },
      { reviewId: 'rv1', action: 'approve' },
      NOW + 2000
    );

    expect(replay.decided).toBe(false);
    expect(replay.status).toBe('approved');
    expect(replay.published).toBe(true);
    expect(bot.calls.filter((call) => call.method === 'copyMessage')).toHaveLength(1);
  });

  it('a reject publishes nothing and clears the keyboard', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    await seedReview(store);

    const outcome = await decideReview(
      { store, getBot: () => bot },
      { reviewId: 'rv1', action: 'reject' },
      NOW + 1000
    );

    expect(outcome).toMatchObject({ status: 'rejected', decided: true, published: false });
    expect(bot.calls.some((call) => call.method === 'copyMessage')).toBe(false);
    expect(bot.calls.some((call) => call.method === 'editMessageReplyMarkup')).toBe(true);
  });

  it('an approve/reject race elects exactly one winner', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    await seedReview(store);

    const [approve, reject] = await Promise.all([
      decideReview({ store, getBot: () => bot }, { reviewId: 'rv1', action: 'approve' }, NOW + 1000),
      decideReview({ store, getBot: () => bot }, { reviewId: 'rv1', action: 'reject' }, NOW + 1000),
    ]);

    const decided = [approve, reject].filter((outcome) => outcome.decided);
    expect(decided).toHaveLength(1);
    // Whatever won, the review is in exactly one terminal state.
    const review = (await store.getReview('rv1'))!;
    expect(['approved', 'rejected']).toContain(review.status);
    if (approve.decided && approve.status === 'approved') {
      expect(bot.calls.filter((call) => call.method === 'copyMessage')).toHaveLength(1);
    } else {
      expect(bot.calls.filter((call) => call.method === 'copyMessage')).toHaveLength(0);
    }
  });

  it('an album is copied with copyMessages (one server-side call, no media through the Worker)', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    await seedReview(store, { messageId: null, messageIds: [42, 43, 44], mediaGroupId: 'mg1' });

    await decideReview({ store, getBot: () => bot }, { reviewId: 'rv1', action: 'approve' }, NOW + 1000);

    const copies = bot.calls.filter((call) => call.method === 'copyMessages');
    expect(copies).toHaveLength(1);
    expect(copies[0]!.payload).toMatchObject({ messageIds: [42, 43, 44], toChatId: '-100channel' });
  });
});

describe('an unconfirmed publish is never retried', () => {
  it('marks the review uncertain on an ambiguous (network) failure', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    bot.script = () => ({ ok: false, description: 'network error: socket hang up' });
    await seedReview(store);

    const outcome = await decideReview(
      { store, getBot: () => bot },
      { reviewId: 'rv1', action: 'approve' },
      NOW + 1000
    );

    expect(outcome).toMatchObject({ status: 'uncertain', decided: true, published: false, uncertain: true });
    const review = (await store.getReview('rv1'))!;
    expect(review.status).toBe('uncertain');
    expect(review.publishedMessageId).toBeNull();

    // A second press must not re-attempt the copy: the media may already be in the
    // channel, and copying again would publish it twice.
    const second = await decideReview(
      { store, getBot: () => bot },
      { reviewId: 'rv1', action: 'approve' },
      NOW + 2000
    );
    expect(second.decided).toBe(false);
    expect(bot.calls.filter((call) => call.method === 'copyMessage')).toHaveLength(1);
  });

  it('a definitive rejection returns to pending so an operator can retry', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    bot.script = () => ({ ok: false, description: 'Bad Request: message to copy not found' });
    await seedReview(store);

    const outcome = await decideReview(
      { store, getBot: () => bot },
      { reviewId: 'rv1', action: 'approve' },
      NOW + 1000
    );

    expect(outcome.status).toBe('pending');
    expect(outcome.uncertain).toBeUndefined();
    expect((await store.getReview('rv1'))!.status).toBe('pending');
  });

  it('refuses to publish when the bot token or the publish target is missing', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'no-bot' });
    const noBot = await decideReview(
      { store, getBot: () => null },
      { reviewId: 'no-bot', action: 'approve' },
      NOW + 1000
    );
    expect(noBot).toMatchObject({ status: 'uncertain', uncertain: true });

    await seedReview(store, { id: 'no-target', workId: 'other', publishChatId: null });
    const noTarget = await decideReview(
      { store, getBot: () => fakeBot() },
      { reviewId: 'no-target', action: 'approve' },
      NOW + 1000
    );
    expect(noTarget).toMatchObject({ status: 'uncertain', uncertain: true });
  });
});

describe('expiry', () => {
  it('expires only reviews past their TTL and never publishes them', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'old', workId: 'w-old' }, NOW - DEFAULT_REVIEW_TTL_MS - 1000);
    await seedReview(store, { id: 'fresh', workId: 'w-fresh' }, NOW);

    const expired = await expirePendingReviews(store, NOW, DEFAULT_REVIEW_TTL_MS);

    expect(expired).toBe(1);
    expect((await store.getReview('old'))!.status).toBe('expired');
    expect((await store.getReview('fresh'))!.status).toBe('pending');
    // A later press on the expired review does nothing.
    const bot = fakeBot();
    const outcome = await decideReview(
      { store, getBot: () => bot },
      { reviewId: 'old', action: 'approve' },
      NOW + 1000
    );
    expect(outcome.decided).toBe(false);
    expect(bot.calls).toHaveLength(0);
  });
});

describe('callback data', () => {
  it('round-trips and rejects anything malformed', () => {
    expect(parseCallbackData(buildCallbackData('rv1', 'approve'))).toEqual({
      reviewId: 'rv1',
      action: 'approve',
    });
    expect(parseCallbackData(buildCallbackData('rv1', 'reject'))).toEqual({
      reviewId: 'rv1',
      action: 'reject',
    });
    for (const bad of ['', 'review:rv1', 'review:rv1:maybe', 'other:rv1:approve', 'review::approve', 'review:a:b:approve']) {
      expect(parseCallbackData(bad)).toBeNull();
    }
  });
});

describe('webhook', () => {
  const secret = 'webhook-secret';
  const makeRequest = (botId: string, body: unknown, token = secret) =>
    new Request(`https://control.example/telegram/webhook/${botId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': token },
      body: JSON.stringify(body),
    });

  const callbackUpdate = (reviewId: string, action: 'approve' | 'reject') => ({
    update_id: 1,
    callback_query: {
      id: 'cb-1',
      data: buildCallbackData(reviewId, action),
      from: { id: 12345, username: 'owner' },
      message: { message_id: 42, chat: { id: -100 } },
    },
  });

  it('fails closed without a configured secret or with a wrong one', async () => {
    const store = new MemoryControlStore();
    await seedReview(store);
    const bots = { bot1: fakeBot() };

    const noSecret = await handleTelegramWebhook(
      makeRequest('bot1', callbackUpdate('rv1', 'approve')),
      store,
      new URL('https://control.example/telegram/webhook/bot1'),
      { getBot: (id) => bots[id as 'bot1'] ?? null }
    );
    expect(noSecret?.status).toBe(503);

    const wrongSecret = await handleTelegramWebhook(
      makeRequest('bot1', callbackUpdate('rv1', 'approve'), 'wrong'),
      store,
      new URL('https://control.example/telegram/webhook/bot1'),
      { TELEGRAM_WEBHOOK_SECRET: secret, getBot: (id) => bots[id as 'bot1'] ?? null }
    );
    expect(wrongSecret?.status).toBe(401);
    expect((await store.getReview('rv1'))!.status).toBe('pending');
  });

  it('approves the review and acknowledges the press', async () => {
    const store = new MemoryControlStore();
    await seedReview(store);
    const bot = fakeBot();
    const response = await handleTelegramWebhook(
      makeRequest('bot1', callbackUpdate('rv1', 'approve')),
      store,
      new URL('https://control.example/telegram/webhook/bot1'),
      { TELEGRAM_WEBHOOK_SECRET: secret, getBot: () => bot }
    );
    const body = (await response!.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: 'approved', decided: true, published: true });
    expect(bot.calls.some((call) => call.method === 'answerCallbackQuery')).toBe(true);
  });

  it('refuses a callback routed to the wrong bot (isolation)', async () => {
    const store = new MemoryControlStore();
    await seedReview(store); // bot1's review
    const bot2 = fakeBot('bot2');

    const response = await handleTelegramWebhook(
      makeRequest('bot2', callbackUpdate('rv1', 'approve')),
      store,
      new URL('https://control.example/telegram/webhook/bot2'),
      { TELEGRAM_WEBHOOK_SECRET: secret, getBot: () => bot2 }
    );

    expect(response?.status).toBe(403);
    expect((await store.getReview('rv1'))!.status).toBe('pending');
    expect(bot2.calls.some((call) => call.method === 'copyMessage')).toBe(false);
  });

  it('replays and unknown reviews are safe', async () => {
    const store = new MemoryControlStore();
    await seedReview(store);
    const bot = fakeBot();

    const first = await handleTelegramWebhook(
      makeRequest('bot1', callbackUpdate('rv1', 'reject')),
      store,
      new URL('https://control.example/telegram/webhook/bot1'),
      { TELEGRAM_WEBHOOK_SECRET: secret, getBot: () => bot }
    );
    const replay = await handleTelegramWebhook(
      makeRequest('bot1', callbackUpdate('rv1', 'reject')),
      store,
      new URL('https://control.example/telegram/webhook/bot1'),
      { TELEGRAM_WEBHOOK_SECRET: secret, getBot: () => bot }
    );
    expect(((await first!.json()) as { decided: boolean }).decided).toBe(true);
    expect(((await replay!.json()) as { decided: boolean }).decided).toBe(false);

    const unknown = await handleTelegramWebhook(
      makeRequest('bot1', callbackUpdate('nope', 'approve')),
      store,
      new URL('https://control.example/telegram/webhook/bot1'),
      { TELEGRAM_WEBHOOK_SECRET: secret, getBot: () => bot }
    );
    expect(unknown?.status).toBe(404);
  });

  it('ignores updates that are not review callbacks without failing them', async () => {
    const store = new MemoryControlStore();
    const response = await handleTelegramWebhook(
      makeRequest('bot1', { update_id: 2, message: { message_id: 1, chat: { id: -100 } } }),
      store,
      new URL('https://control.example/telegram/webhook/bot1'),
      { TELEGRAM_WEBHOOK_SECRET: secret, getBot: () => fakeBot() }
    );
    // 200 so Telegram does not retry the same non-review update forever.
    expect(response?.status).toBe(200);
    expect(((await response!.json()) as Record<string, unknown>).ignored).toBe('not a callback_query');
  });

  it('is not mounted on unrelated paths', async () => {
    const store = new MemoryControlStore();
    const response = await handleTelegramWebhook(
      new Request('https://control.example/api/status'),
      store,
      new URL('https://control.example/api/status'),
      { TELEGRAM_WEBHOOK_SECRET: secret, getBot: () => null }
    );
    expect(response).toBeNull();
  });
});
