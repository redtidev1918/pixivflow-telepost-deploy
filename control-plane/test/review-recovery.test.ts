import { describe, expect, it } from 'vitest';

import { MemoryControlStore, fakeBot, seedReview, NOW } from './reviews-helpers';
import { reapStalePublishing } from '../src/reviews';
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
