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
import {
  CLAIMABLE_REVIEW_STATUSES,
  PUBLISHING_STALE_MS,
  type ControlPlaneStore,
  type ReviewRecord,
  type ReviewStatus,
} from './store';

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
  /**
   * Ordered media message ids: one album or several consecutive groups.
   *
   * Separate from the text and the control card because publishing has to reproduce
   * the reviewer's layout in the channel, and the keyboard belongs to the control
   * card rather than to a file.
   */
  mediaMessageIds?: number[] | null;
  /** The one message carrying the work's text, sent after ALL media. */
  captionMessageId?: number | null;
  /** The approve/reject card. Never published. */
  controlMessageId?: number | null;
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
  /** How long a `publishing` claim may stay untouched before it is stale. */
  staleMs?: number;
}

export async function decideReview(
  deps: DecideReviewDeps,
  input: DecideReviewInput,
  nowMs: number
): Promise<DecideReviewOutcome> {
  const { store } = deps;
  const review = await store.getReview(input.reviewId);
  if (!review) return { status: 'unknown', decided: false, published: false };

  // Rejection is a plain conditional UPDATE from `pending`/`failed` — the same
  // transition set TelePost's reject uses. It never goes through `publishing`
  // because it publishes nothing.
  if (input.action === 'reject') {
    // TelePost's reject transitions from the claimable set only, so a rejected
    // callback arriving after a publish cannot undo it.
    const from = CLAIMABLE_REVIEW_STATUSES.includes(review.status) ? review.status : null;
    const won = from !== null && (await store.transitionReview({
      reviewId: review.id,
      from,
      to: 'rejected',
      nowMs,
      actor: input.actor ?? null,
    }));
    if (!won) {
      const current = await store.getReview(review.id);
      return {
        status: current?.status ?? 'unknown',
        decided: false,
        published: (current?.publishedMessageId ?? null) !== null,
        description: current ? `already ${current.status}` : undefined,
      };
    }
    // The keyboard lives on the control card, never on a file. Rows written before the
    // card existed fall back to the first media message.
    await deps.getBot(review.botId)?.editMessageReplyMarkup({
      chatId: review.chatId,
      messageId: review.controlMessageId ?? review.messageId ?? review.mediaMessageIds?.[0] ?? 0,
    });
    return { status: 'rejected', decided: true, published: false };
  }

  // The claim is the at-most-once latch: a double tap, a Telegram replay and a
  // retried webhook all converge here, and exactly one of them proceeds.
  const { claimed, record } = await store.claimReviewForPublishing({
    reviewId: review.id,
    nowMs,
    staleMs: deps.staleMs ?? PUBLISHING_STALE_MS,
  });

  if (!claimed) {
    const current = record ?? review;
    // TelePost's three-way branch, kept verbatim: an already-published row is an
    // idempotent success, an in-flight row is busy, anything else is not decidable.
    if (current.status === 'published') {
      return { status: 'published', decided: false, published: true };
    }
    return {
      status: current.status,
      decided: false,
      published: false,
      description:
        current.status === 'publishing' ? 'another actor is publishing' : `already ${current.status}`,
    };
  }

  const bot = deps.getBot(review.botId);
  if (!bot) {
    await failPublish(store, review.id, nowMs, `no Telegram client for bot ${review.botId}`);
    return {
      status: 'failed',
      decided: true,
      published: false,
      description: `no Telegram client configured for ${review.botId}`,
    };
  }
  if (!review.publishChatId) {
    await failPublish(store, review.id, nowMs, 'review has no publish target');
    return {
      status: 'failed',
      decided: true,
      published: false,
      description: 'review has no publish target',
    };
  }

  // Server-side copy: Telegram moves the already-uploaded media, so the Worker never
  // handles bytes. The channel must end up with the SAME shape the reviewer saw:
  //
  //   [file1 | file2 | file3]   <- the media, kept together as an album
  //   正文                       <- the text, copied on its own afterwards
  //
  // The control card is deliberately not published: it is review UI, not content.
  const media = review.mediaMessageIds && review.mediaMessageIds.length > 0
    ? review.mediaMessageIds
    : review.messageIds && review.messageIds.length > 0
      ? review.messageIds
      : review.messageId !== null
        ? [review.messageId]
        : [];
  if (media.length === 0) {
    await failPublish(store, review.id, nowMs, 'review has no media to copy');
    return { status: 'failed', decided: true, published: false };
  }

  const thread = review.publishThreadId !== null ? { messageThreadId: review.publishThreadId } : {};
  // copyMessages keeps album grouping — and the caption, which lives ON the last media
  // item, so the text arrives with the group instead of as a separate bubble.
  const copyResult = media.length > 1
    ? await bot.copyMessages({ fromChatId: review.chatId, messageIds: media, toChatId: review.publishChatId, ...thread })
    : await bot.copyMessage({
        fromChatId: review.chatId,
        messageId: media[0]!,
        toChatId: review.publishChatId,
        ...thread,
        // A single-file review has no separate text message to copy, so the text rides
        // along here. With an album the text is its own message (below) and a caption
        // here would visually belong to one file.
        ...(review.caption && review.captionMessageId === null ? { caption: review.caption } : {}),
      });

  // Legacy only: rows written before the text became a caption ON the media item have a
  // separate caption message, so it is still copied for them. A new review never has
  // one, because its text travels inside the album.
  let publishedCaptionId: number | null = null;
  if (copyResult.ok && review.captionMessageId !== null) {
    const captionCopy = await bot.copyMessage({
      fromChatId: review.chatId,
      messageId: review.captionMessageId,
      toChatId: review.publishChatId,
      ...thread,
    });
    publishedCaptionId = extractMessageId(captionCopy.result);
    if (!captionCopy.ok) {
      // The media IS in the channel but the text is not. That is a partial publish and
      // must never be recorded as a clean success.
      await failPublish(store, review.id, nowMs, `media published but the caption was not: ${captionCopy.description ?? 'unknown'}`);
      return {
        status: 'failed',
        decided: true,
        published: false,
        description: 'media published but the caption was not; the review is retryable',
      };
    }
  }

  if (copyResult.ok) {
    const publishedId = extractMessageId(copyResult.result);
    // Record the evidence BEFORE the terminal transition. A crash in between
    // leaves a `publishing` row that already proves the copy landed, so the
    // reaper resolves it as published rather than resending the media. This is
    // TelePost's load-bearing ordering (ledger before terminal write).
    await store.recordPublishedMessage({
      reviewId: review.id,
      publishedMessageId: publishedId,
      nowMs,
    });
    const marked = await store.markReviewPublished({
      reviewId: review.id,
      publishedMessageId: publishedId,
      publishedCaptionMessageId: publishedCaptionId,
      nowMs,
      actor: input.actor ?? null,
    });
    // The keyboard lives on the control card, not on a file. Fall back to the first
    // media message only for rows written before the control card existed.
    await bot.editMessageReplyMarkup({
      chatId: review.chatId,
      messageId: review.controlMessageId ?? review.messageId ?? media[0]!,
    });
    if (!marked) {
      // Another actor resolved the claim while we were copying. We must not
      // overwrite their result; the copy did happen, so this is reported as such.
      const current = await store.getReview(review.id);
      return {
        status: current?.status ?? 'published',
        decided: true,
        published: true,
        description: 'the claim was resolved by another actor while publishing',
      };
    }
    return { status: 'published', decided: true, published: true };
  }

  const ambiguous = (copyResult.description ?? '').startsWith('network error');
  if (ambiguous) {
    // We do not know whether Telegram applied the copy. Never resend: a second
    // copy publishes the same media twice. `uncertain` is terminal and visible.
    await store.transitionReview({
      reviewId: review.id,
      from: 'publishing',
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

  // A definitive rejection means Telegram applied nothing, so the review is
  // retryable — which is exactly what `failed` means, and why the approve button
  // can be relabelled "retry publish" without any doubt about the state.
  await failPublish(store, review.id, nowMs, copyResult.description ?? 'publish rejected');
  return {
    status: 'failed',
    decided: true,
    published: false,
    description: copyResult.description,
  };
}

/** `publishing -> failed`: nothing was published and a retry is safe. */
async function failPublish(
  store: ControlPlaneStore,
  reviewId: string,
  nowMs: number,
  error: string
): Promise<void> {
  await store.transitionReview({ reviewId, from: 'publishing', to: 'failed', nowMs, error });
}

/**
 * Resolves claims nobody finished.
 *
 * TelePost reclaims a stale `publishing` row and re-runs the publish, which is
 * safe only because its delivery ledger usually proves the send happened. This
 * closes that hole and keeps the recovery: the recorded message id IS the proof.
 *
 *   - a claim with a recorded message id means Telegram accepted the copy, so the
 *     review is resolved as published — no resend, no human needed;
 *   - a claim without one is genuinely unknown (the crash may have happened
 *     before or after the copy), so it becomes `uncertain` for a human to check.
 *     Resending there is precisely how the same media gets posted twice.
 */
export async function reapStalePublishing(
  store: ControlPlaneStore,
  nowMs: number,
  staleMs: number = PUBLISHING_STALE_MS,
  limit = 50
): Promise<{ published: number; uncertain: number }> {
  const stale = await store.listStalePublishing({ olderThanMs: nowMs - staleMs, limit });
  let published = 0;
  let uncertain = 0;

  for (const review of stale) {
    if (review.publishedMessageId !== null) {
      const marked = await store.markReviewPublished({
        reviewId: review.id,
        publishedMessageId: review.publishedMessageId,
        nowMs,
      });
      if (marked) published += 1;
      continue;
    }
    const won = await store.transitionReview({
      reviewId: review.id,
      from: 'publishing',
      to: 'uncertain',
      nowMs,
      error: 'the claim was abandoned mid-publish and nothing proves the copy',
    });
    if (won) uncertain += 1;
  }

  return { published, uncertain };
}

function readMessageId(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && typeof (value as { message_id?: unknown }).message_id === 'number') {
    return (value as { message_id: number }).message_id;
  }
  return null;
}

/**
 * The id Telegram created, whatever shape it answered with.
 *
 * `copyMessages` returns a bare ARRAY of MessageId objects, `copyMessage` returns one
 * object, and an older/defensive shape nests them under `message_ids`. Only handling
 * the last of those is how an album publish ended up recording nothing: the fake in the
 * tests answered with `{message_id}` while Telegram answers with `[{message_id}]`, so
 * the ledger silently lost the id on every album approval.
 */
function extractMessageId(result: unknown): number | null {
  if (!result) return null;
  if (Array.isArray(result)) {
    for (const item of result) {
      const id = readMessageId(item);
      if (id !== null) return id;
    }
    return null;
  }
  const record = result as Record<string, unknown>;
  const direct = readMessageId(record.message_id);
  if (direct !== null) return direct;
  const nested = record.message_ids;
  if (Array.isArray(nested)) {
    for (const item of nested) {
      const id = readMessageId(item);
      if (id !== null) return id;
    }
  }
  return null;
}

/**
 * Expire reviews nobody decided in time.
 *
 * An expired review is terminal: the media stays in the review chat but will never
 * be published automatically, which is exactly what "expire" means in TelePost.
 *
 * TelePost deletes the preview and control messages here. This keeps the media
 * (evidence survives a mistake) but clears the keyboard, which is the part that
 * matters: a dead button on a terminal review is indistinguishable from a live one
 * to the reviewer. The state moves first and the Telegram call second, so a failed
 * call can never leave a review that is still decidable but has lost its buttons.
 */
export async function expirePendingReviews(
  store: ControlPlaneStore,
  nowMs: number,
  ttlMs: number = DEFAULT_REVIEW_TTL_MS,
  limit = 50,
  getBot?: (botId: string) => BotApiClient | null
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
    if (!won) continue;
    expired += 1;

    const bot = getBot?.(review.botId);
    if (!bot) continue;
    // Best effort: the decision above is already durable, so a failure here must
    // not surface as an expiry that did not happen.
    // The keyboard is on the control card. Older rows carried it on the first media
    // message, so both are cleared; a file with no keyboard is a harmless no-op.
    const ids = [
      ...(review.controlMessageId !== null ? [review.controlMessageId] : []),
      ...(review.messageIds ?? []),
      ...(review.messageId !== null ? [review.messageId] : []),
    ];
    for (const messageId of new Set(ids)) {
      await bot
        .editMessageReplyMarkup({ chatId: review.chatId, messageId })
        .catch(() => undefined);
    }
  }
  return expired;
}
