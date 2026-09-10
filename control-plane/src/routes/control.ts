/**
 * Runner-facing control routes.
 *
 * These are the only write endpoints the disposable runners use, and every one of
 * them is idempotent: a replayed claim, a duplicated result callback or a GitHub
 * rerun must return the current state rather than execute business logic twice.
 *
 * Authentication is a dedicated callback secret, deliberately separate from the
 * Telegram token, the Pixiv token and the GitHub token so a leak of one cannot be
 * replayed against the others.
 */

import { applyExecutionResult, claimExecution } from '../execution';
import { buildCallbackData } from '../reviews';
import type { ControlPlaneStore, ExecutionStatus, ItemStatus } from '../store';
import { SCHEDULES } from '../schedules';

const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'dispatching',
  'dispatched',
  'running',
  'success',
  'partial',
  'failed',
  'cancelled',
  'timeout',
  'uncertain',
];

const ITEM_STATUSES: readonly ItemStatus[] = [
  'pending',
  'selected',
  'downloaded',
  'delivery_pending',
  'submitted',
  'no_candidate',
  'duplicate',
  'failed',
  'uncertain',
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Constant-time comparison so the secret cannot be probed byte by byte. */
function secretsMatch(presented: string, expected: string): boolean {
  const subtle = (crypto as { subtle?: { timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean } }).subtle;
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  if (subtle?.timingSafeEqual) return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function authorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false; // fail closed: no configured secret means no writes
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return presented.length > 0 && secretsMatch(presented, secret);
}

const CONTROL_PATTERN = /^\/control\/executions\/([^/]+)\/(claim|result|items)$/;

export async function handleControl(
  request: Request,
  store: ControlPlaneStore,
  url: URL,
  callbackSecret: string | undefined
): Promise<Response | null> {
  // Pre-flight for the runner's retry safety: if the review already exists, the
  // media is already in the review chat and the runner must NOT post it again.
  const reviewLookup = /^\/control\/reviews\/([^/]+)$/.exec(url.pathname);
  if (reviewLookup) {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    if (!authorized(request, callbackSecret)) return json({ error: 'unauthorized' }, 401);
    const review = await store.getReview(decodeURIComponent(reviewLookup[1] ?? ''));
    if (!review) return json({ error: 'unknown review' }, 404);
    return json({
      ok: true,
      reviewId: review.id,
      botId: review.botId,
      status: review.status,
      messageIds: review.messageIds,
      messageId: review.messageId,
      publishChatId: review.publishChatId,
      publishedMessageId: review.publishedMessageId,
    });
  }

  // Runner side of the review flow: the runner has already posted the media to the
  // review chat (media never passes through this Worker) and reports the ids so a
  // decision can be taken and the publish can be a server-side copy.
  if (url.pathname === '/control/reviews') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!authorized(request, callbackSecret)) return json({ error: 'unauthorized' }, 401);

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ error: 'invalid json body' }, 400);
    }

    const reviewId = typeof body.review_id === 'string' ? body.review_id : '';
    const botId = typeof body.bot_id === 'string' ? body.bot_id : '';
    const chatId = typeof body.chat_id === 'string' ? body.chat_id : '';
    if (!reviewId || !botId || !chatId) {
      return json({ error: 'review_id, bot_id and chat_id are required' }, 400);
    }
    const numberArray = (value: unknown): number[] | null =>
      Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : null;
    const stringArray = (value: unknown): string[] | null =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null;

    const { record, created } = await store.createReview({
      id: reviewId,
      botId,
      chatId,
      slotId: typeof body.slot_id === 'string' ? body.slot_id : null,
      targetId: typeof body.target_id === 'string' ? body.target_id : null,
      workId: typeof body.work_id === 'string' ? body.work_id : null,
      messageId: typeof body.message_id === 'number' ? body.message_id : null,
      messageIds: numberArray(body.message_ids),
      mediaGroupId: typeof body.media_group_id === 'string' ? body.media_group_id : null,
      fileIds: stringArray(body.file_ids),
      caption: typeof body.caption === 'string' ? body.caption : null,
      publishChatId: typeof body.publish_chat_id === 'string' ? body.publish_chat_id : null,
      publishThreadId: typeof body.publish_thread_id === 'number' ? body.publish_thread_id : null,
      // Only two initial states are accepted: a normal review awaiting a decision,
      // or an unconfirmed send that must never be approved automatically.
      ...(body.status === 'uncertain' ? { status: 'uncertain' as const } : {}),
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
      nowMs: Date.now(),
    });

    return json({
      ok: true,
      reviewId: record.id,
      created,
      status: record.status,
      // The runner needs these before it posts the media, so they are documented
      // here as the one supported shape: `review:<reviewId>:<action>`.
      callbackData: {
        approve: buildCallbackData(record.id, 'approve'),
        reject: buildCallbackData(record.id, 'reject'),
      },
    });
  }

  const match = CONTROL_PATTERN.exec(url.pathname);
  if (!match) return null;

  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!authorized(request, callbackSecret)) return json({ error: 'unauthorized' }, 401);

  const executionId = decodeURIComponent(match[1] ?? '');
  const action = match[2];
  const nowMs = Date.now();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }

  if (action === 'claim') {
    const providerRunId =
      typeof body.provider_run_id === 'string' && body.provider_run_id.length > 0
        ? body.provider_run_id
        : null;
    const outcome = await claimExecution(store, { executionId, providerRunId }, nowMs);
    if (!outcome.execution) return json({ error: 'unknown execution' }, 404);
    return json({
      ok: true,
      executionId,
      status: outcome.execution.status,
      slotStatus: (await store.getOccurrence(outcome.execution.slotId))?.status ?? null,
    });
  }

  if (action === 'result') {
    const status = typeof body.status === 'string' ? (body.status as ExecutionStatus) : undefined;
    if (!status || !EXECUTION_STATUSES.includes(status)) {
      return json({ error: `invalid status; expected one of ${EXECUTION_STATUSES.join(', ')}` }, 400);
    }
    const existing = await store.getExecution(executionId);
    if (!existing) return json({ error: 'unknown execution' }, 404);
    const scheduleId = existing.slotId.slice(0, Math.max(0, existing.slotId.indexOf('@')));
    const maxAttempts =
      SCHEDULES.find((schedule) => schedule.id === scheduleId)?.maxAttempts ?? 1;

    const outcome = await applyExecutionResult(
      store,
      {
        executionId,
        status,
        maxAttempts,
        ...(typeof body.result === 'string' ? { result: body.result } : {}),
        ...(typeof body.error === 'string' ? { error: body.error } : {}),
        ...(typeof body.error_class === 'string' ? { errorClass: body.error_class } : {}),
      },
      nowMs
    );
    if (!outcome) return json({ error: 'unknown execution' }, 404);
    return json({
      ok: true,
      applied: outcome.applied,
      executionId,
      status: outcome.execution.status,
      slotStatus: outcome.slotStatus,
    });
  }

  // items: per-target outcomes. A target that already finished is never rewritten.
  const existing = await store.getExecution(executionId);
  if (!existing) return json({ error: 'unknown execution' }, 404);
  const slot = await store.getOccurrence(existing.slotId);
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const results: Array<{ targetId: string; outcome: string }> = [];
  for (const raw of rawItems) {
    const item = raw as Record<string, unknown>;
    const targetId = typeof item.target_id === 'string' ? item.target_id : undefined;
    const status = typeof item.status === 'string' ? (item.status as ItemStatus) : undefined;
    if (!targetId || !status || !ITEM_STATUSES.includes(status)) {
      return json({ error: 'each item requires target_id and a valid status' }, 400);
    }
    const outcome = await store.upsertSlotItem({
      slotId: existing.slotId,
      botId: slot?.botId ?? 'unknown',
      item: {
        targetId,
        status,
        ...(typeof item.work_type === 'string' ? { workType: item.work_type } : {}),
        ...(typeof item.work_id === 'string' ? { workId: item.work_id } : {}),
        ...(typeof item.error === 'string' ? { error: item.error } : {}),
        ...(typeof item.error_class === 'string' ? { errorClass: item.error_class } : {}),
      },
      nowMs,
    });
    results.push({ targetId, outcome });
  }
  return json({ ok: true, executionId, items: results });
}
