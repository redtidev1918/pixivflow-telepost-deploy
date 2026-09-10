/**
 * Telegram webhook: the edge review adapter's entry point.
 *
 * Scope is deliberately narrow — this is the 24/7 part of TelePost that must
 * survive without a daemon: review button presses, their durable decision, and the
 * server-side publish. It is NOT a rewrite of TelePost; the submission pipeline,
 * the proposal formatting and the review UI stay where they already are.
 *
 * Two invariants:
 *  - **bot isolation**: the bot in the URL must own the review, AND the press must
 *    have happened in that review's chat. A bot2 webhook can never decide a bot1
 *    review (and therefore can never publish to bot1's channel).
 *  - **idempotent decisions**: a double tap, a Telegram replay or a retried webhook
 *    all converge on one decision, because the decision is a compare-and-set.
 *
 * The chat check is an addition, not a port. TelePost relies on the callback landing
 * on the right per-bot webhook and on each bot having its own database; nothing
 * verifies the press came from the review chat. With one shared database that is no
 * longer sufficient, so the chat is checked explicitly.
 */

import { decideReview, parseCallbackData } from '../reviews';
import type { BotApiClient } from '../telegram/client';
import type { ControlPlaneStore } from '../store';

export interface TelegramEnv {
  TELEGRAM_WEBHOOK_SECRET?: string;
  getBot(botId: string): BotApiClient | null;
}

const WEBHOOK_PATTERN = /^\/telegram\/webhook\/([A-Za-z0-9_-]+)$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

interface TelegramUpdate {
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number; username?: string };
    message?: { message_id?: number; chat?: { id?: number | string } };
  };
  message?: { message_id?: number; chat?: { id?: number | string } };
}

export async function handleTelegramWebhook(
  request: Request,
  store: ControlPlaneStore,
  url: URL,
  env: TelegramEnv
): Promise<Response | null> {
  const match = WEBHOOK_PATTERN.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Fail closed: without a configured secret nothing may be decided through here.
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'webhook secret not configured' }, 503);
  if (request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return json({ error: 'unauthorized' }, 401);
  }

  const botId = match[1] ?? '';
  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    // Always 200 an unparseable update: a 4xx makes Telegram retry it forever.
    return json({ ok: true, ignored: 'unparseable' });
  }

  const callback = update.callback_query;
  if (!callback) {
    // Messages and everything else are not this adapter's business.
    return json({ ok: true, ignored: 'not a callback_query' });
  }

  const parsed = parseCallbackData(callback.data);
  if (!parsed) {
    await answerSafe(env, botId, callback.id, 'Unrecognised action');
    return json({ ok: true, ignored: 'unparseable callback data' });
  }

  const review = await store.getReview(parsed.reviewId);
  if (!review) {
    await answerSafe(env, botId, callback.id, 'Review not found');
    return json({ ok: false, error: 'unknown review' }, 404);
  }

  // Bot isolation: the URL's bot must be the review's bot. Otherwise a webhook
  // routed to the wrong bot could publish another bot's work to its channel.
  if (review.botId !== botId) {
    await answerSafe(env, botId, callback.id, 'Not your review');
    return json({ ok: false, error: 'bot mismatch' }, 403);
  }

  // And the press must come from the chat that review lives in. A message id is
  // only meaningful within its own chat, so a press relayed from elsewhere must
  // never be able to decide this review.
  const pressedIn = callback.message?.chat?.id;
  if (pressedIn !== undefined && String(pressedIn) !== review.chatId) {
    await answerSafe(env, botId, callback.id, 'Not your review');
    return json({ ok: false, error: 'chat mismatch' }, 403);
  }

  const actor = callback.from?.username ?? (callback.from?.id !== undefined ? String(callback.from.id) : 'unknown');

  // Audit what was actually pressed, before deciding anything.
  //
  // Two real presses in a row arrived as `reject` while the operator believed they had
  // pressed approve, and there was no record of the raw action to tell either of us what
  // happened. A decision is worth an audit line, and "which button was that" has to be
  // answerable from state rather than from a conversation.
  await store.logEvents([
    {
      ts: Date.now(),
      event: 'review_callback_received',
      botId,
      detail: JSON.stringify({ reviewId: parsed.reviewId, action: parsed.action, actor }),
    },
  ]);
  const outcome = await decideReview(
    { store, getBot: env.getBot },
    { reviewId: parsed.reviewId, action: parsed.action, actor },
    Date.now()
  );

  // The acknowledgement is UX only: the decision above is already durable, so a
  // failure to answer must not change the result.
  const text = acknowledgeText(parsed.action, outcome.status, outcome.decided, outcome.description);
  await answerSafe(env, botId, callback.id, text);

  return json({
    ok: true,
    reviewId: parsed.reviewId,
    action: parsed.action,
    status: outcome.status,
    decided: outcome.decided,
    published: outcome.published,
    ...(outcome.uncertain ? { uncertain: true } : {}),
  });
}

function acknowledgeText(
  action: string,
  status: string,
  decided: boolean,
  description?: string
): string {
  if (status === 'uncertain') return '发送结果未能确认，请人工核对（不会自动重试）';
  if (status === 'expired') return '该审核已过期';
  if (!decided) return `已处理过：${status}`;
  if (action === 'reject') return '已拒绝';
  if (status === 'published') return '已发布';
  if (status === 'pending' && description) return `发布被拒绝：${description}`;
  return '已处理';
}

async function answerSafe(
  env: TelegramEnv,
  botId: string,
  callbackQueryId: string | undefined,
  text: string
): Promise<void> {
  if (!callbackQueryId) return;
  try {
    await env.getBot(botId)?.answerCallbackQuery(callbackQueryId, text);
  } catch {
    // Never let an acknowledgement failure fail the webhook.
  }
}
