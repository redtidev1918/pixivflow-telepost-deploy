/**
 * Fly Machines execution provider.
 *
 * One admitted execution = one ephemeral Fly Machine: the control plane creates
 * the machine with the execution's identity in its metadata, the machine claims
 * the execution, runs exactly one slot, reports the result and exits — and
 * `auto_destroy` removes it. There is no scheduler, no webhook and no durable
 * business state on Fly: every one of those belongs to the control plane.
 *
 * The provider run id is the Fly machine id. The machine learns it itself
 * (Fly injects `FLY_MACHINE_ID`), so the claim callback can attach it to the D1
 * execution even though `dispatch()` is fire-and-forget — and a dispatch whose
 * HTTP response was lost is adopted from the machines list, exactly like the
 * GitHub provider adopts a run from the workflow-runs list.
 *
 * API: https://api.machines.dev/v1 (Bearer token, e.g. `fly tokens create`).
 * The token is passed in by the Worker (a secret binding) and never logged.
 */

import type {
  DispatchRequest,
  DispatchResult,
  ExecutionProvider,
  ProviderRun,
  ProviderRunState,
} from './provider';

export interface FlyProviderConfig {
  apiToken: string;
  /** Fly app that owns the ephemeral executor machines. */
  appName: string;
  /** Region the machines run in — the historical production baseline is `iad`. */
  region: string;
  /** Immutable executor image (built by CI; never an unqualified `latest`). */
  image: string;
  cpuKind?: string;
  cpus?: number;
  memoryMb?: number;
  apiBase?: string;
}

interface FlyMachinePayload {
  id?: string;
  name?: string;
  state?: string;
  created_at?: string;
  config?: { metadata?: Record<string, string> };
}

const DEFAULT_API_BASE = 'https://api.machines.dev/v1';
const MACHINE_TIMEOUT_MS = 30_000;

/**
 * Wrapper rather than a bare reference: `fetch` must be called with the global
 * object as its receiver (see github-provider.ts for the runtime failure this
 * avoids on Cloudflare Workers).
 */
const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

function stateFromFly(state: string | undefined): ProviderRunState {
  switch (state) {
    case 'created':
    case 'starting':
      return 'queued';
    case 'started':
    case 'stopping':
      // `stopping` still belongs to the run: the process may be finishing its
      // result report inside the grace window.
      return 'in_progress';
    case 'stopped':
    case 'destroyed':
    case 'suspended':
    case 'replacing':
      return 'completed';
    default:
      return 'unknown';
  }
}

export class FlyMachinesExecutionProvider implements ExecutionProvider {
  readonly name = 'fly';
  readonly ready = true;

  constructor(
    private readonly config: FlyProviderConfig,
    /** Injectable for tests; defaults to a this-safe wrapper around global fetch. */
    private readonly fetchImpl: typeof fetch = defaultFetch
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.apiToken}`,
      'content-type': 'application/json',
    };
  }

  private url(path: string): string {
    return `${this.config.apiBase ?? DEFAULT_API_BASE}/apps/${this.config.appName}${path}`;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const executionId = `${request.slotId}#${request.attempt}`;
    // Non-secret execution identity only: the machine pulls the Pixiv credential
    // from the control plane and its own runner secrets from the Fly app.
    const env: Record<string, string> = {
      EXECUTION_ID: executionId,
      SLOT_ID: request.slotId,
      SCHEDULE_ID: request.scheduleId,
      ATTEMPT: String(request.attempt),
      BOT_ID: request.botId,
      TARGETS: request.targets.join(','),
      OCCURRENCE_AT: String(request.occurrenceAt),
      MODE: request.mode,
      CREDENTIAL_KEY: request.credentialKey,
      CALLBACK_URL: request.callbackUrl,
      CONTROL_PLANE_URL: request.callbackUrl.replace(/\/control\/?$/, ''),
    };

    // Idempotent dispatch: one execution attempt ALWAYS maps to one machine
    // name, so a create whose HTTP response was lost is recovered by adopting
    // that machine — never by blind-creating a second one for the same work.
    const name = machineNameFor(executionId);
    const existing = await this.findMachine(executionId, name);
    if (existing?.id) {
      return {
        accepted: true,
        providerRunId: existing.id,
        detail: `adopted existing machine ${existing.id} for ${executionId}`,
      };
    }

    const body = {
      name,
      region: this.config.region,
      config: {
        image: this.config.image,
        env,
        // The adoption path (a dispatch whose response was lost) and every
        // reconciliation query key on this: execution identity is machine
        // identity for the lifetime of the run.
        metadata: {
          purpose: 'pixivflow-execution',
          execution_id: executionId,
          slot_id: request.slotId,
          attempt: String(request.attempt),
          schedule_id: request.scheduleId,
          mode: request.mode,
        },
        // Fire once, then disappear: the machine must never become a daemon.
        auto_destroy: true,
        restart: { policy: 'no' },
        guest: {
          cpu_kind: this.config.cpuKind ?? 'shared',
          cpus: this.config.cpus ?? 1,
          memory_mb: this.config.memoryMb ?? 512,
        },
        // No public service, no health check, no webhook surface: an outbound
        // job worker that is unreachable from the internet by construction.
        skip_service_registration: true,
      },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(this.url('/machines'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MACHINE_TIMEOUT_MS),
      });
    } catch (error) {
      // A timeout here is exactly the dispatch ambiguity the reconciler owns:
      // the machine may exist under our deterministic name. Never blindly
      // create a second one.
      return {
        accepted: false,
        detail: `fly dispatch did not answer (the reconciler will look for the machine): ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    if (response.ok) {
      const created = (await response.json().catch(() => null)) as FlyMachinePayload | null;
      return {
        accepted: true,
        ...(created?.id ? { providerRunId: created.id } : {}),
      };
    }
    if (response.status === 409 || response.status === 422) {
      // A machine with this deterministic name already exists (a concurrent or
      // retried create): reconciliation adopts it by name/metadata instead of
      // the control plane treating the execution as dispatch-failed.
      return {
        accepted: false,
        detail: `fly dispatch: a machine named ${name} already exists for ${executionId}; the reconciler will adopt it`,
      };
    }
    const detail = await safeText(response);
    return { accepted: false, detail: `fly dispatch failed: ${response.status} ${detail}`.trim() };
  }

  /**
   * Find an existing machine for one execution attempt, by deterministic name
   * or by execution metadata. A lookup failure returns null (the caller then
   * attempts a create whose deterministic name keeps the operation idempotent
   * at the platform level too).
   */
  private async findMachine(executionId: string, name: string): Promise<FlyMachinePayload | null> {
    try {
      const response = await this.fetchImpl(this.url('/machines'), {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(MACHINE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as FlyMachinePayload[];
      return (
        (Array.isArray(payload) ? payload : []).find(
          (m) => m.config?.metadata?.execution_id === executionId || m.name === name || m.id === name
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  async getRun(runId: string): Promise<ProviderRun> {
    const response = await this.fetchImpl(this.url(`/machines/${encodeURIComponent(runId)}`), {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(MACHINE_TIMEOUT_MS),
    });
    if (response.status === 404) {
      // A destroyed machine whose execution is still open: the callback was
      // lost and the work is gone. Reported as a failed provider run so the
      // occurrence retries instead of holding the credential forever.
      return { runId, state: 'completed', conclusion: 'failure' };
    }
    if (!response.ok) {
      throw new Error(`fly getRun failed: ${response.status}`);
    }
    return toRun((await response.json()) as FlyMachinePayload);
  }

  async cancel(runId: string): Promise<void> {
    // `stop` (not destroy): the process gets its grace period to finish the
    // result report and the rotated-credential persist before it goes away.
    await this.fetchImpl(this.url(`/machines/${encodeURIComponent(runId)}/stop`), {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(MACHINE_TIMEOUT_MS),
    });
  }

  async listRecentRuns(sinceMs: number): Promise<ProviderRun[]> {
    const response = await this.fetchImpl(this.url('/machines'), {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(MACHINE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`fly listRecentRuns failed: ${response.status}`);
    }
    const payload = (await response.json()) as FlyMachinePayload[];
    return (Array.isArray(payload) ? payload : [])
      .filter((machine) => machine.config?.metadata?.purpose === 'pixivflow-execution')
      .map(toRun)
      .filter((run) => run.createdAt === undefined || run.createdAt >= sinceMs)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }
}

/**
 * Deterministic, DNS-safe machine name for one execution attempt: the same
 * execution always maps to the same machine, which is what makes dispatch
 * idempotent (a lost create response is recovered by name, not by guessing).
 * `pf-` + readable suffix + 8 hex chars of FNV-1a, bounded to Fly's limits.
 */
export function machineNameFor(executionId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < executionId.length; i++) {
    hash ^= executionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  const readable = executionId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 32);
  return `pf-${readable}-${hex}`.slice(0, 60).replace(/-+$/, '');
}

function toRun(payload: FlyMachinePayload): ProviderRun {
  const createdAt = payload.created_at ? Date.parse(payload.created_at) : undefined;
  return {
    runId: String(payload.id ?? ''),
    state: stateFromFly(payload.state),
    // A machine's own lifecycle says nothing about the business outcome: a
    // stopped machine either already reported its result (the execution is then
    // terminal and this mapping is never consulted) or lost its callback (the
    // open execution must fail and retry). `null` keeps that decision with
    // `statusFromConclusion`'s default rather than inventing a success.
    conclusion: null,
    ...(createdAt !== undefined && Number.isFinite(createdAt) ? { createdAt } : {}),
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    // Response bodies never contain our token (headers do), but bound the length
    // so a provider error page cannot flood the event log.
    return text.slice(0, 300);
  } catch {
    return '';
  }
}
