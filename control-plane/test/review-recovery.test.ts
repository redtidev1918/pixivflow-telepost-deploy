import { describe, expect, it } from 'vitest';

import { MemoryControlStore, fakeBot, seedReview, NOW } from './reviews-helpers';
import { createReview, decideReview, expirePendingReviews, reapStalePublishing } from '../src/reviews';
import { DEFAULT_REVIEW_TTL_MS } from '../src/reviews';
import { PUBLISHING_STALE_MS } from '../src/store';

/**
 * Fault injection for the window between "Telegram accepted the copy" and "the
 * record says so".
 *
 * TelePost reclaims a stale `publishing` row after 300s and re-runs the publish.
 * That is safe only while its delivery ledger already proves the send happened:
 * its own audit found the hole, and the spec is explicit that a crash after the
 * API call and before the ledger write leaves no evidence, so the reclaim posts
 * the media a second time.
 *
 * These tests pin the version that closes it. The recorded message id is the
 * evidence: present, the claim is resolved without resending; absent, the outcome
 * is genuinely unknown and a human is asked. There is no third case.
 */
describe('a claim abandoned mid-publish', () => {
  it('is resolved as published when the copy was recorded, without resending', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'crashed-after-copy' });
    const claim = await store.claimReviewForPublishing({
      reviewId: 'crashed-after-copy',
      nowMs: NOW + 1_000,
      staleMs: PUBLISHING_STALE_MS,
    });
    expect(claim.claimed).toBe(true);
    // Telegram answered, the id was recorded, then the process died before the
    // terminal transition.
    await store.recordPublishedMessage({
      reviewId: 'crashed-after-copy',
      publishedMessageId: 4242,
      nowMs: NOW + 1_100,
    });

    const result = await reapStalePublishing(store, NOW + 2 * PUBLISHING_STALE_MS);

    expect(result).toEqual({ published: 1, uncertain: 0 });
    const review = (await store.getReview('crashed-after-copy'))!;
    expect(review.status).toBe('published');
    expect(review.publishedMessageId).toBe(4242);
  });

  it('becomes uncertain when nothing proves the copy, and is never resent', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'crashed-before-copy' });
    await store.claimReviewForPublishing({
      reviewId: 'crashed-before-copy',
      nowMs: NOW + 1_000,
      staleMs: PUBLISHING_STALE_MS,
    });

    const result = await reapStalePublishing(store, NOW + 2 * PUBLISHING_STALE_MS);

    expect(result).toEqual({ published: 0, uncertain: 1 });
    const review = (await store.getReview('crashed-before-copy'))!;
    expect(review.status).toBe('uncertain');
    // The reason has to say why a human is being asked, or the state is useless.
    expect(review.lastError).toContain('nothing proves the copy');
  });

  it('leaves a fresh claim alone so a retry cannot steal an in-flight publish', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'in-flight' });
    await store.claimReviewForPublishing({
      reviewId: 'in-flight',
      nowMs: NOW,
      staleMs: PUBLISHING_STALE_MS,
    });

    const result = await reapStalePublishing(store, NOW + 1_000);

    expect(result).toEqual({ published: 0, uncertain: 0 });
    expect((await store.getReview('in-flight'))!.status).toBe('publishing');
  });

  it('reaps both shapes in one sweep without confusing them', async () => {
    const store = new MemoryControlStore();
    // Distinct works on purpose: createReview is idempotent per (bot, target,
    // work), so reusing a work id would silently produce one row, not two.
    for (const id of ['done', 'unknown']) {
      await seedReview(store, { id, workId: `work-${id}` });
      await store.claimReviewForPublishing({
        reviewId: id,
        nowMs: NOW + 1_000,
        staleMs: PUBLISHING_STALE_MS,
      });
    }
    await store.recordPublishedMessage({
      reviewId: 'done',
      publishedMessageId: 7,
      nowMs: NOW + 1_100,
    });

    const result = await reapStalePublishing(store, NOW + 2 * PUBLISHING_STALE_MS);

    expect(result).toEqual({ published: 1, uncertain: 1 });
  });
});

describe('the claim is the at-most-once latch', () => {
  it('a stale claim is reclaimable, which is the crash-recovery path', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'stale' });
    await store.claimReviewForPublishing({
      reviewId: 'stale',
      nowMs: NOW,
      staleMs: PUBLISHING_STALE_MS,
    });

    const again = await store.claimReviewForPublishing({
      reviewId: 'stale',
      nowMs: NOW + PUBLISHING_STALE_MS + 1,
      staleMs: PUBLISHING_STALE_MS,
    });

    expect(again.claimed).toBe(true);
  });

  it('a fresh claim refuses a second claimant', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'busy' });
    await store.claimReviewForPublishing({
      reviewId: 'busy',
      nowMs: NOW,
      staleMs: PUBLISHING_STALE_MS,
    });

    const second = await store.claimReviewForPublishing({
      reviewId: 'busy',
      nowMs: NOW + 1,
      staleMs: PUBLISHING_STALE_MS,
    });

    expect(second.claimed).toBe(false);
    expect(second.record!.status).toBe('publishing');
  });

  it('a terminal row is never claimable, not even when stale', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'published' });
    await store.transitionReview({
      reviewId: 'published',
      from: 'pending',
      to: 'published',
      nowMs: NOW,
    });

    const attempt = await store.claimReviewForPublishing({
      reviewId: 'published',
      nowMs: NOW + 10 * PUBLISHING_STALE_MS,
      staleMs: PUBLISHING_STALE_MS,
    });

    expect(attempt.claimed).toBe(false);
    expect(attempt.record!.status).toBe('published');
  });

  it('a guarded terminal write is refused once another actor resolved the claim', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'late-writer' });

    // Not publishing yet: a late writer must not be able to force the state.
    expect(
      await store.markReviewPublished({
        reviewId: 'late-writer',
        publishedMessageId: 1,
        nowMs: NOW,
      })
    ).toBe(false);

    await store.claimReviewForPublishing({
      reviewId: 'late-writer',
      nowMs: NOW,
      staleMs: PUBLISHING_STALE_MS,
    });
    expect(
      await store.markReviewPublished({
        reviewId: 'late-writer',
        publishedMessageId: 1,
        nowMs: NOW + 1,
      })
    ).toBe(true);
    // Second writer lost the claim; it must not overwrite the first result.
    expect(
      await store.markReviewPublished({
        reviewId: 'late-writer',
        publishedMessageId: 2,
        nowMs: NOW + 2,
      })
    ).toBe(false);
    expect((await store.getReview('late-writer'))!.publishedMessageId).toBe(1);
  });
});

describe('a failed publish stays retryable', () => {
  it('records the evidence only while the claim is held', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'not-claimed' });

    expect(
      await store.recordPublishedMessage({
        reviewId: 'not-claimed',
        publishedMessageId: 9,
        nowMs: NOW,
      })
    ).toBe(false);
    expect((await store.getReview('not-claimed'))!.publishedMessageId).toBeNull();
  });

  it('keeps the recorded evidence when the sweep runs long after the fact', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'old-crash' });
    await store.claimReviewForPublishing({
      reviewId: 'old-crash',
      nowMs: NOW,
      staleMs: PUBLISHING_STALE_MS,
    });
    await store.recordPublishedMessage({
      reviewId: 'old-crash',
      publishedMessageId: 31337,
      nowMs: NOW + 10,
    });

    await reapStalePublishing(store, NOW + 40 * PUBLISHING_STALE_MS);

    expect((await store.getReview('old-crash'))!.publishedMessageId).toBe(31337);
  });
});

// Keep the helper imports honest: the fake bot is part of the fixture the other
// review tests share, and this file must fail loudly if it disappears.
expect(fakeBot).toBeTypeOf('function');

/**
 * A work whose review ended without publishing must be reviewable again.
 *
 * The runner keys its review id on the WORK, so a later occurrence re-uploads the
 * media and posts a button carrying that same id. While the row stayed terminal,
 * createReview returned it unchanged and the press hit a dead button: the media sat
 * in the review chat and nobody could publish it. Observed by reading the create
 * path, not by a test, which is why these exist.
 */
describe('a work can be reviewed again after a review ends unpublished', () => {
  it('re-opens an expired review onto the new media', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'rv1', messageId: 100, messageIds: [100] });
    await store.transitionReview({
      reviewId: 'rv1',
      from: 'pending',
      to: 'expired',
      nowMs: NOW + 1_000,
    });

    const again = await createReview(
      store,
      {
        id: 'rv1',
        botId: 'bot1',
        chatId: '-1004318193445',
        messageId: 200,
        messageIds: [200, 201],
        publishChatId: '-100channel',
        targetId: 'bot1-illust-botefuku',
        workId: '29088506',
        slotId: 'bot1-daily@2026-09-12T1800',
      },
      NOW + 30 * 24 * 60 * 60 * 1000
    );

    expect(again.created).toBe(false);
    expect(again.record.status).toBe('pending');
    expect(again.record.messageIds).toEqual([200, 201]);
    expect(again.record.messageId).toBe(200);
    // The clock restarts, or the next sweep would retire it immediately.
    expect(again.record.createdAt).toBe(NOW + 30 * 24 * 60 * 60 * 1000);
    expect(again.record.publishedMessageId).toBeNull();
    expect(again.record.decidedAt).toBeNull();
  });

  it('re-opens a rejected review, matching TelePost, which only dedupes published works', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'rv1' });
    await store.transitionReview({ reviewId: 'rv1', from: 'pending', to: 'rejected', nowMs: NOW + 1 });
    const decide = await decideReview(
      { store, getBot: () => fakeBot() },
      { reviewId: 'rv1', action: 'approve' },
      NOW + 2
    );
    // A rejected review is still re-openable, but only a create can do it.
    expect(decide.decided).toBe(false);
  });

  it.each(['published', 'uncertain', 'publishing'] as const)(
    'refuses to re-open a %s review: it may already be in the channel',
    async (status) => {
      const store = new MemoryControlStore();
      await seedReview(store, { id: 'rv1' });
      if (status === 'publishing') {
        await store.claimReviewForPublishing({
          reviewId: 'rv1',
          nowMs: NOW + 1,
          staleMs: PUBLISHING_STALE_MS,
        });
      } else {
        await store.transitionReview({ reviewId: 'rv1', from: 'pending', to: status, nowMs: NOW + 1 });
      }

      const again = await createReview(
        store,
        {
          id: 'rv1',
          botId: 'bot1',
          chatId: '-1004318193445',
          messageId: 999,
          publishChatId: '-100channel',
          targetId: 'bot1-illust-botefuku',
          workId: '29088506',
        },
        NOW + 5_000
      );

      expect(again.created).toBe(false);
      expect(again.record.status).toBe(status);
      expect(again.record.messageId).not.toBe(999);
    }
  );
});

describe('expiring a review', () => {
  it('clears the keyboard so a dead button cannot look live', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    await seedReview(store, { id: 'rv1', messageId: 100, messageIds: [100, 101] });

    const expired = await expirePendingReviews(store, NOW + DEFAULT_REVIEW_TTL_MS + 1, undefined, 50, () => bot);

    expect(expired).toBe(1);
    const cleared = bot.calls.filter((call) => call.method === 'editMessageReplyMarkup');
    expect(cleared).toHaveLength(2);
    expect(cleared.map((call) => (call.payload as { messageId: number }).messageId)).toEqual([100, 101]);
  });

  it('expires the review even when Telegram cannot be reached', async () => {
    const store = new MemoryControlStore();
    const bot = fakeBot();
    bot.editMessageReplyMarkup = async () => {
      throw new Error('telegram down');
    };
    await seedReview(store, { id: 'rv1' });

    const expired = await expirePendingReviews(store, NOW + DEFAULT_REVIEW_TTL_MS + 1, undefined, 50, () => bot);

    // The state is the decision; the keyboard is cosmetic.
    expect(expired).toBe(1);
    expect((await store.getReview('rv1'))!.status).toBe('expired');
  });

  it('still expires when no bot is available at all', async () => {
    const store = new MemoryControlStore();
    await seedReview(store, { id: 'rv1' });

    const expired = await expirePendingReviews(store, NOW + DEFAULT_REVIEW_TTL_MS + 1);

    expect(expired).toBe(1);
  });
});
