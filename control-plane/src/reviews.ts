/**
 * Review decisions — the TelePost domain semantics that must survive the move to
 * an edge runtime.
 *
 * What is preserved from TelePost:
 *   - a review is a durable pending decision with an explicit terminal state;
 *   - the media lives in Telegram (message ids / file ids), never in the control
 *     plane;
 *   - publishing an accepted review is a SERVER-SIDE copy of the review message,
 *     so no bytes transit the Worker;
 *   - approving twice publishes once.
 *
 * What is new, because the old daemon is gone:
 *   - an ambiguous publish outcome becomes `uncertain` and is NEVER retried
 *     automatically (a blind retry could post the same media twice);
 *   - every transition is a compare-and-set, so concurrent callbacks (a double
 *     tap, a Telegram replay, a retried webhook) converge on one decision.
 */

import type { BotApiClient } from './telegram/client';
import type { ControlPlaneStore, ReviewRecord, ReviewStatus } from './store';

export const CALLBACK_PREFIX = 'review';

/** How long an undecided review stays actionable (TelePost kept ~30 days). */
export const DEFAULT_REVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type ReviewAction = 'approve' | 'reject';

/** `review:<reviewId>:<action>` — bounded, parseable, and never trusted for data. */
export function buildCallbackData(reviewId: string, action: ReviewAction): string {
  return `${CALLBACK_PREFIX}:${reviewId}:${action}`;
}

export function parseCallbackData(data: string | undefined): { reviewId: string; action: ReviewAction } | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3) return null;
  const [prefix, reviewId, action] = parts;
  if (prefix !== CALLBACK_PREFIX || !reviewId) return null;
  if (action !== 'approve' && action !== 'reject') return null;
  return { reviewId, action };
}

export interface CreateReviewInput {
  id: string;
  botId: string;
  chatId: string;
  messageId?: number | null;
  messageIds?: number[] | null;
  mediaGroupId?: string | null;
  fileIds?: string[] | null;
  caption?: string | null;
  publishChatId?: string | null;
  publishThreadId?: number | null;
  slotId?: string | null;
  targetId?: string | null;
  workId?: string | null;
}

export async function createReview(
  store: ControlPlaneStore,
  input: CreateReviewInput,
  nowMs: number
): Promise<{ record: ReviewRecord; created: boolean }> {
  return store.createReview({ ...input, nowMs });
}

export interface DecideReviewInput {
  reviewId: string;
  action: ReviewAction;
  actor?: string;
  /** Populated from the callback when the caller has one (for the acknowledgement). */
  callbackQueryId?: string;
}

export interface DecideReviewOutcome {
  status: ReviewStatus | 'unknown';
  /** true only when THIS call performed the decision. */
  decided: boolean;
  published: boolean;
  /** Set when the publish outcome could not be confirmed. */
  uncertain?: boolean;
  description?: string;
}

export interface DecideReviewDeps {
  store: ControlPlaneStore;
  /** Resolved per bot: a bot1 callback can never publish with a bot2 token. */
  getBot(botId: string): BotApiClient | null;
}

export async function decideReview(
  deps: DecideReviewDeps,
  input: DecideReviewInput,
  nowMs: number
): Promise<DecideReviewOutcome> {
  const { store } = deps;
  const review = await store.getReview(input.reviewId);
  if (!review) return { status: 'unknown', decided: false, published: false };

  // A decision is only ever taken on a pending review. A rejected/approved review
  // replays as "already decided" instead of acting twice — this is what makes a
  // double tap, a Telegram replay and a retried webhook safe.
  if (review.status !== 'pending') {
    return {
      status: review.status,
      decided: false,
      published: review.publishedMessageId !== null,
    };
  }

  const target: ReviewStatus = input.action === 'approve' ? 'approved' : 'rejected';
  const won = await store.transitionReview({
    reviewId: review.id,
    from: 'pending',
    to: target,
    nowMs,
    actor: input.actor ?? null,
  });
  if (!won) {
    // Another callback decided first; that one owns the side effects.
    const current = await store.getReview(review.id);
    return {
      status: current?.status ?? 'unknown',
      decided: false,
      published: (current?.publishedMessageId ?? null) !== null,
    };
  }

  if (input.action === 'reject') {
    await deps.getBot(review.botId)?.editMessageReplyMarkup({
      chatId: review.chatId,
      messageId: review.messageId ?? 0,
    });
    return { status: 'rejected', decided: true, published: false };
  }

  const bot = deps.getBot(review.botId);
  if (!bot) {
    // The decision is recorded, but nothing can be published without that bot's
    // token. Visible and recoverable, never silently "done".
    await store.transitionReview({
      reviewId: review.id,
      from: 'approved',
      to: 'uncertain',
      nowMs,
      error: `no Telegram client for bot ${review.botId}`,
    });
    return {
      status: 'uncertain',
      decided: true,
      published: false,
      uncertain: true,
      description: `no Telegram client configured for ${review.botId}`,
    };
  }

  if (!review.publishChatId) {
    await store.transitionReview({
      reviewId: review.id,
      from: 'approved',
      to: 'uncertain',
      nowMs,
      error: 'review has no publish target',
    });
    return {
      status: 'uncertain',
      decided: true,
      published: false,
      uncertain: true,
      description: 'review has no publish target',
    };
  }

  // Server-side copy: Telegram moves the already-uploaded media, so the Worker
  // never handles bytes.
  const ids = review.messageIds && review.messageIds.length > 0
    ? review.messageIds
    : review.messageId !== null
      ? [review.messageId]
      : [];
  if (ids.length === 0) {
    await store.transitionReview({
      reviewId: review.id,
      from: 'approved',
      to: 'uncertain',
      nowMs,
      error: 'review has no message to copy',
    });
    return { status: 'uncertain', decided: true, published: false, uncertain: true };
  }

  const copyResult = ids.length > 1
    ? await bot.copyMessages({
        fromChatId: review.chatId,
        messageIds: ids,
        toChatId: review.publishChatId,
        ...(review.publishThreadId !== null ? { messageThreadId: review.publishThreadId } : {}),
      })
    : await bot.copyMessage({
        fromChatId: review.chatId,
        messageId: ids[0]!,
        toChatId: review.publishChatId,
        ...(review.publishThreadId !== null ? { messageThreadId: review.publishThreadId } : {}),
        ...(review.caption ? { caption: review.caption } : {}),
      });

  if (copyResult.ok) {
    const publishedId = extractMessageId(copyResult.result);
    await store.markReviewPublished({ reviewId: review.id, publishedMessageId: publishedId, nowMs });
    await bot.editMessageReplyMarkup({ chatId: review.chatId, messageId: review.messageId ?? ids[0]! });
    return { status: 'approved', decided: true, published: true };
  }

  const ambiguous = (copyResult.description ?? '').startsWith('network error');
  if (ambiguous) {
    // We do not know whether Telegram applied the copy. Never retry blindly:
    // a second copy would publish the same media twice.
    await store.transitionReview({
      reviewId: review.id,
      from: 'approved',
      to: 'uncertain',
      nowMs,
      error: copyResult.description ?? 'ambiguous publish outcome',
    });
    return {
      status: 'uncertain',
      decided: true,
      published: false,
      uncertain: true,
      description: copyResult.description,
    };
  }

  // A definitive rejection means nothing was published, so the review can be
  // retried by an operator instead of being stuck.
  await store.transitionReview({
    reviewId: review.id,
    from: 'approved',
    to: 'pending',
    nowMs,
    error: copyResult.description ?? 'publish rejected',
  });
  return {
    status: 'pending',
    decided: true,
    published: false,
    description: copyResult.description,
  };
}

function extractMessageId(result: Record<string, unknown> | undefined): number | null {
  if (!result) return null;
  const direct = result.message_id;
  if (typeof direct === 'number') return direct;
  // copyMessages returns an array of MessageId objects.
  const ids = result.message_ids;
  if (Array.isArray(ids) && ids.length > 0) {
    const first = ids[0];
    if (typeof first === 'number') return first;
    if (first && typeof first === 'object' && typeof (first as { message_id?: unknown }).message_id === 'number') {
      return (first as { message_id: number }).message_id;
    }
  }
  return null;
}

/**
 * Expire reviews nobody decided in time.
 *
 * An expired review is terminal: the media stays in the review chat but will never
 * be published automatically, which is exactly what "expire" means in TelePost.
 */
export async function expirePendingReviews(
  store: ControlPlaneStore,
  nowMs: number,
  ttlMs: number = DEFAULT_REVIEW_TTL_MS,
  limit = 50
): Promise<number> {
  const pending = await store.listPendingReviews(limit);
  let expired = 0;
  for (const review of pending) {
    if (nowMs - review.createdAt < ttlMs) continue;
    const won = await store.transitionReview({
      reviewId: review.id,
      from: 'pending',
      to: 'expired',
      nowMs,
      error: 'review expired without a decision',
    });
    if (won) expired += 1;
  }
  return expired;
}
