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
import { decryptSecret, encryptSecret } from '../credentials';
import { secretsMatch } from '../secrets';
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
function authorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false; // fail closed: no configured secret means no writes
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (presented.length === 0) return false;
  const subtle = (crypto as { subtle?: { timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean } })
    .subtle;
  return secretsMatch(presented, secret, subtle);
}

const CONTROL_PATTERN = /^\/control\/executions\/([^/]+)\/(claim|result|items)$/;

export async function handleControl(
  request: Request,
  store: ControlPlaneStore,
  url: URL,
  callbackSecret: string | undefined,
  env: { CREDENTIAL_MASTER_KEY?: string } = {}
): Promise<Response | null> {
  // ---- the execution plane's shared credential ------------------------------
  //
  // A runner is destroyed when the job ends, so a refresh token it rotates and
  // drops is unrecoverable. Pixiv may return a new refresh token from any refresh,
  // and nothing proves it will not, so a rotation is written here before the run is
  // allowed to report success.
  //
  // The value never appears in a GET: metadata is one endpoint and reading the
  // secret is an explicit POST, so a probe, a dashboard or a log line cannot leak
  // it by accident.
  const masterKey = env.CREDENTIAL_MASTER_KEY;

  // The collection, so an operator can see which accounts exist without reading
  // D1 by hand. Values are never part of it.
  if (url.pathname === '/control/credentials') {
    if (!authorized(request, callbackSecret)) return json({ error: 'unauthorized' }, 401);
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const rows = await store.listRunnerCredentials();
    return json({
      ok: true,
      count: rows.length,
      credentials: rows.map((row) => ({
        name: row.name,
        updatedAt: row.updatedAt,
        rotations: row.rotations,
        previousHash: row.previousHash,
      })),
    });
  }
  const credentialPath = /^\/control\/credentials\/([^/]+)$/.exec(url.pathname);
  if (credentialPath) {
    const name = decodeURIComponent(credentialPath[1] ?? '');
    if (!name) return json({ error: 'name is required' }, 400);
    if (!authorized(request, callbackSecret)) return json({ error: 'unauthorized' }, 401);

    if (request.method === 'GET') {
      const row = await store.getRunnerCredential(name);
      if (!row) return json({ ok: true, name, stored: false });
      return json({
        ok: true,
        name,
        stored: true,
        updatedAt: row.updatedAt,
        previousHash: row.previousHash,
        rotations: row.rotations,
      });
    }

    if (request.method === 'PUT') {
      let body: { value?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: 'invalid json body' }, 400);
      }
      const value = typeof body.value === 'string' ? body.value.trim() : '';
      // Refuse anything that is not plausibly a token: a placeholder or an empty
      // string written over a real credential would silently break every later run.
      if (value.length < 16 || value.startsWith('${')) {
        return json({ error: 'value does not look like a credential' }, 400);
      }
      const before = await store.getRunnerCredential(name);
      // Stored encrypted whenever a master key exists: the value is the account, and
      // "the API does not return it" is not the same property as "the database does
      // not contain it".
      const stored = masterKey ? await encryptSecret(value, masterKey) : value;
      if (!masterKey) {
        console.warn('CREDENTIAL_MASTER_KEY is not set; storing the credential unencrypted');
      }
      const result = await store.putRunnerCredential({ name, value: stored, nowMs: Date.now() });
      // Durable evidence of the rotation, without the value: who changed it, and
      // what it replaced, is enough to audit this.
      if (result.changed) {
        await store.logEvents([
          {
            ts: Date.now(),
            event: 'runner_credential_rotated',
            detail: JSON.stringify({
              name,
              rotations: result.rotations,
              previousUpdatedAt: before?.updatedAt ?? null,
            }),
          },
        ]);
      }
      return json({ ok: true, name, stored: true, changed: result.changed, rotations: result.rotations });
    }

    if (request.method === 'DELETE') {
      const removed = await store.deleteRunnerCredential(name);
      if (!removed) return json({ error: 'no credential stored' }, 404);
      await store.logEvents([
        { ts: Date.now(), event: 'runner_credential_removed', detail: JSON.stringify({ name }) },
      ]);
      return json({ ok: true, name, removed: true });
    }

    return json({ error: 'method not allowed' }, 405);
  }

  // Reading the secret is deliberately its own POST: a GET could be cached, logged
  // by an intermediary, or captured in a URL, and this value is the whole account.
  const credentialRead = /^\/control\/credentials\/([^/]+)\/read$/.exec(url.pathname);
  if (credentialRead) {
    if (!authorized(request, callbackSecret)) return json({ error: 'unauthorized' }, 401);
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const name = decodeURIComponent(credentialRead[1] ?? '');
    const secret = await store.readRunnerCredentialSecret(name);
    if (!secret) return json({ error: 'no credential stored' }, 404);
    let value: string;
    try {
      value = masterKey ? await decryptSecret(secret.value, masterKey) : secret.value;
    } catch (error) {
      // Never hand back a value that cannot authenticate: that would surface as a
      // confusing Pixiv auth failure instead of a configuration error.
      return json(
        { error: `stored credential cannot be decrypted: ${error instanceof Error ? error.message : String(error)}` },
        500
      );
    }
    return json({ ok: true, name, value, updatedAt: secret.updatedAt, rotations: secret.rotations });
  }

  // Durable duplicate history for a runner that starts with an empty local
  // database: the list of works this bot has already handled.
  if (url.pathname === '/control/processed-works') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    if (!authorized(request, callbackSecret)) return json({ error: 'unauthorized' }, 401);
    const botId = url.searchParams.get('bot_id') ?? '';
    if (!botId) return json({ error: 'bot_id is required' }, 400);
    const requested = Number(url.searchParams.get('limit') ?? '500');
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 2000) : 500;
    const works = await store.listProcessedWorks(botId, limit);
    // Grouped by work type: the runner excludes per type, exactly like the local
    // dedupe it replaces.
    const grouped: Record<string, string[]> = {};
    for (const work of works) {
      (grouped[work.workType] ??= []).push(work.pixivId);
    }
    return json({ ok: true, botId, limit, count: works.length, works: grouped });
  }

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
        ...(typeof body.retry_after_ms === 'number' && Number.isFinite(body.retry_after_ms)
          ? { retryAfterMs: body.retry_after_ms }
          : {}),
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
  // Works that this run actually handled become durable duplicate history: the
  // next (disposable) runner must not reselect them from an empty local database.
  const handled: Array<{ workType: string; pixivId: string; targetId: string }> = [];
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
        // The attempt decides whether this may supersede a terminal item.
        attempt: existing.attempt,
        ...(typeof item.work_type === 'string' ? { workType: item.work_type } : {}),
        ...(typeof item.work_id === 'string' ? { workId: item.work_id } : {}),
        ...(typeof item.error === 'string' ? { error: item.error } : {}),
        ...(typeof item.error_class === 'string' ? { errorClass: item.error_class } : {}),
      },
      nowMs,
    });
    // `submitted` is the only status that proves the work went somewhere; a
    // `duplicate` is already in history by definition.
    if (status === 'submitted' && typeof item.work_id === 'string' && item.work_id.length > 0) {
      handled.push({
        workType: typeof item.work_type === 'string' ? item.work_type : 'unknown',
        pixivId: item.work_id,
        targetId,
      });
    }
    results.push({ targetId, outcome });
  }

  if (handled.length > 0) {
    const recorded = await store.recordProcessedWorks({
      botId: slot?.botId ?? 'unknown',
      slotId: existing.slotId,
      works: handled,
      nowMs,
    });
    return json({ ok: true, executionId, items: results, processedWorksRecorded: recorded });
  }
  return json({ ok: true, executionId, items: results });
}
