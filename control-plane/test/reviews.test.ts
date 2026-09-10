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
import { handleControl } from '../src/routes/control';
import { MemoryControlStore } from './memory-store';
import { fakeBot, seedReview, NOW } from './reviews-helpers';

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

    expect(outcome).toMatchObject({ status: 'published', decided: true, published: true });
    const copies = bot.calls.filter((call) => call.method === 'copyMessage');
    expect(copies).toHaveLength(1);
    expect(copies[0]!.payload).toMatchObject({
      fromChatId: '-1004318193445',
      messageId: 42,
      toChatId: '-100channel',
    });
    const review = (await store.getReview('rv1'))!;
    expect(review.status).toBe('published');
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
    expect(replay.status).toBe('published');
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
    expect(['published', 'rejected']).toContain(review.status);
    if (approve.decided && approve.status === 'published') {
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

  it('a definitive rejection becomes failed so an operator can retry', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    bot.script = () => ({ ok: false, description: 'Bad Request: message to copy not found' });
    await seedReview(store);

    const outcome = await decideReview(
      { store, getBot: () => bot },
      { reviewId: 'rv1', action: 'approve' },
      NOW + 1000
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.uncertain).toBeUndefined();
    expect((await store.getReview('rv1'))!.status).toBe('failed');
  });

  it('refuses to publish when the bot token or the publish target is missing', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'no-bot' });
    const noBot = await decideReview(
      { store, getBot: () => null },
      { reviewId: 'no-bot', action: 'approve' },
      NOW + 1000
    );
    // Nothing was sent, so this is retryable rather than ambiguous. Marking it
    // uncertain would wedge the review behind a decision no operator can make.
    expect(noBot).toMatchObject({ status: 'failed' });

    await seedReview(store, { id: 'no-target', workId: 'other', publishChatId: null });
    const noTarget = await decideReview(
      { store, getBot: () => fakeBot() },
      { reviewId: 'no-target', action: 'approve' },
      NOW + 1000
    );
    expect(noTarget).toMatchObject({ status: 'failed' });
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
      message: { message_id: 42, chat: { id: -1004318193445 } },
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
    expect(body).toMatchObject({ ok: true, status: 'published', decided: true, published: true });
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
      makeRequest('bot1', { update_id: 2, message: { message_id: 1, chat: { id: -1004318193445 } } }),
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

describe('runner-side review endpoints', () => {
  const secret = 'control-secret';
  const post = (path: string, body: unknown, token = secret) =>
    new Request(`https://control.example${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const get = (path: string, token = secret) =>
    new Request(`https://control.example${path}`, { headers: { authorization: `Bearer ${token}` } });

  it('looks a review up so a runner can prove it must not post again', async () => {
    const store = new MemoryControlStore();
    await seedReview(store);

    const found = await handleControl(get('/control/reviews/rv1'), store, new URL('https://c/control/reviews/rv1'), secret);
    expect(found?.status).toBe(200);
    expect(await found!.json()).toMatchObject({ ok: true, reviewId: 'rv1', status: 'pending' });

    const missing = await handleControl(get('/control/reviews/nope'), store, new URL('https://c/control/reviews/nope'), secret);
    expect(missing?.status).toBe(404);

    const unauthorized = await handleControl(get('/control/reviews/rv1', 'wrong'), store, new URL('https://c/control/reviews/rv1'), secret);
    expect(unauthorized?.status).toBe(401);
  });

  it('records an unconfirmed send as uncertain instead of pending', async () => {
    const store = new MemoryControlStore();
    const response = await handleControl(
      post('/control/reviews', {
        review_id: 'rv_uncertain',
        bot_id: 'bot1',
        chat_id: '-1004318193445',
        publish_chat_id: '-100channel',
        status: 'uncertain',
        error: 'Telegram send outcome unconfirmed',
      }),
      store,
      new URL('https://control.example/control/reviews'),
      secret
    );

    expect(response?.status).toBe(200);
    const review = (await store.getReview('rv_uncertain'))!;
    expect(review.status).toBe('uncertain');
    // An uncertain review can never be approved: the send may not have happened.
    const bot = fakeBot();
    const outcome = await decideReview(
      { store, getBot: () => bot },
      { reviewId: 'rv_uncertain', action: 'approve' },
      NOW + 1000
    );
    expect(outcome.decided).toBe(false);
    expect(bot.calls).toHaveLength(0);
  });
});

/**
 * The channel must end up with the same shape the reviewer saw:
 *
 *   [file1 | file2 | file3]   <- media, kept together
 *   正文                       <- the text, copied on its own after the media
 *
 * and the control card is review UI, not content, so it is never published.
 */
describe('publishing keeps the media and the text apart', () => {
  it('copies the album with copyMessages, then the caption as its own message', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    await seedReview(store, {
      id: 'rv_layout',
      messageId: 100,
      messageIds: [100, 101],
      mediaMessageIds: [100, 101],
      captionMessageId: 102,
      controlMessageId: 103,
      caption: '正文',
    });

    const outcome = await decideReview(
      { store, getBot: () => bot },
      { reviewId: 'rv_layout', action: 'approve' },
      NOW + 1000
    );

    expect(outcome).toMatchObject({ status: 'published', published: true });
    const copies = bot.calls.filter((call) => call.method === 'copyMessages' || call.method === 'copyMessage');
    expect(copies.map((call) => call.method)).toEqual(['copyMessages', 'copyMessage']);
    // The album carries no caption; the text is its own copy.
    expect(copies[0]!.payload).toMatchObject({ messageIds: [100, 101] });
    expect(copies[1]!.payload).toMatchObject({ messageId: 102 });
    // The control card is not published.
    expect(copies.some((call) => (call.payload as { messageId?: number }).messageId === 103)).toBe(false);
  });

  it('copies a single file and its text as two messages too', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    await seedReview(store, {
      id: 'rv_layout_one',
      messageId: 200,
      messageIds: [200],
      mediaMessageIds: [200],
      captionMessageId: 201,
      controlMessageId: 202,
      caption: '正文',
    });

    await decideReview({ store, getBot: () => bot }, { reviewId: 'rv_layout_one', action: 'approve' }, NOW + 1);

    const copies = bot.calls.filter((call) => call.method === 'copyMessage');
    expect(copies.map((call) => (call.payload as { messageId: number }).messageId)).toEqual([200, 201]);
    // The text must NOT ride along as a caption on the file: that is the layout this
    // replaces.
    expect((copies[0]!.payload as { caption?: string }).caption).toBeUndefined();
  });

  it('clears the keyboard on the control card, never on a file', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    await seedReview(store, {
      id: 'rv_layout_reject',
      messageId: 300,
      mediaMessageIds: [300, 301],
      captionMessageId: 302,
      controlMessageId: 303,
    });

    await decideReview({ store, getBot: () => bot }, { reviewId: 'rv_layout_reject', action: 'reject' }, NOW + 1);

    const edits = bot.calls.filter((call) => call.method === 'editMessageReplyMarkup');
    expect((edits[0]!.payload as { messageId: number }).messageId).toBe(303);
  });

  it('does not report success when the media landed but the caption did not', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    let copy = 0;
    bot.script = (method) => {
      if (method === 'copyMessages') {
        copy += 1;
        return { ok: true, result: { message_id: 900 } };
      }
      if (method === 'copyMessage') {
        // The text copy is refused outright.
        return { ok: false, description: 'Bad Request: message to copy not found' };
      }
      return undefined;
    };
    await seedReview(store, {
      id: 'rv_partial',
      messageId: 400,
      mediaMessageIds: [400, 401],
      captionMessageId: 402,
      controlMessageId: 403,
    });

    const outcome = await decideReview(
      { store, getBot: () => bot },
      { reviewId: 'rv_partial', action: 'approve' },
      NOW + 1
    );

    // A half-published review must never look like a clean success.
    expect(outcome.published).toBe(false);
    expect(outcome.status).toBe('failed');
    expect((await store.getReview('rv_partial'))!.status).toBe('failed');
    expect(copy).toBe(1);
  });
});
