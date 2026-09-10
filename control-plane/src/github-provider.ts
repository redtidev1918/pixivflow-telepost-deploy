/**
 * GitHub Actions execution provider.
 *
 * `workflow_dispatch` only — never a GitHub `schedule`. A GitHub cron that fires
 * hours late (or not at all) must not be able to decide whether the day's work
 * happens; the control plane decides, and GitHub is told what to run.
 *
 * The token is passed in by the Worker (a secret binding) and never logged: no
 * URL, error message or thrown object in this file contains it.
 */

import type {
  DispatchRequest,
  DispatchResult,
  ExecutionProvider,
  ProviderConclusion,
  ProviderRun,
  ProviderRunState,
} from './provider';

export interface GitHubProviderConfig {
  /** `owner/repo` that hosts the batch workflow. */
  repo: string;
  /** Workflow file name or id, e.g. `pixivflow-batch.yml`. */
  workflowFile: string;
  token: string;
  /** Git ref the workflow is dispatched on. */
  ref: string;
  apiBase?: string;
}

interface GitHubRunPayload {
  id?: number;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  created_at?: string;
}

const DEFAULT_API_BASE = 'https://api.github.com';

/**
 * Wrapper rather than a bare reference: `fetch` must be called with the global
 * object as its receiver. Storing it as a property and calling `this.fetch(...)`
 * is rejected at runtime by Cloudflare Workers ("Illegal invocation: function
 * called with incorrect `this` reference") — a bug that only shows up against the
 * real runtime, which is why the dispatch path is exercised in shadow.
 */
const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

function stateFromStatus(status: string | undefined): ProviderRunState {
  switch (status) {
    case 'queued':
    case 'requested':
    case 'waiting':
    case 'pending':
      return 'queued';
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    default:
      return 'unknown';
  }
}

function conclusionFromPayload(conclusion: string | null | undefined): ProviderConclusion {
  switch (conclusion) {
    case 'success':
    case 'failure':
    case 'cancelled':
    case 'timed_out':
    case 'startup_failure':
    case 'action_required':
    case 'skipped':
    case 'neutral':
      return conclusion;
    default:
      return null;
  }
}

function toRun(payload: GitHubRunPayload): ProviderRun {
  const createdAt = payload.created_at ? Date.parse(payload.created_at) : undefined;
  return {
    runId: String(payload.id ?? ''),
    state: stateFromStatus(payload.status),
    conclusion: conclusionFromPayload(payload.conclusion),
    ...(payload.html_url ? { url: payload.html_url } : {}),
    ...(createdAt !== undefined && Number.isFinite(createdAt) ? { createdAt } : {}),
  };
}

export class GitHubActionsExecutionProvider implements ExecutionProvider {
  readonly name = 'github-actions';
  readonly ready = true;

  constructor(
    private readonly config: GitHubProviderConfig,
    /** Injectable for tests; defaults to a this-safe wrapper around global fetch. */
    private readonly fetchImpl: typeof fetch = defaultFetch
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'pixivflow-control-plane',
      'x-github-api-version': '2022-11-28',
    };
  }

  private url(path: string): string {
    return `${this.config.apiBase ?? DEFAULT_API_BASE}${path}`;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const response = await this.fetchImpl(
      this.url(`/repos/${this.config.repo}/actions/workflows/${this.config.workflowFile}/dispatches`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          ref: this.config.ref,
          inputs: {
            slot_id: request.slotId,
            schedule_id: request.scheduleId,
            bot_id: request.botId,
            occurrence_at: String(request.occurrenceAt),
            attempt: String(request.attempt),
            targets: request.targets.join(','),
            callback_url: request.callbackUrl,
            mode: request.mode,
            pixivflow_ref: request.pixivflowRef,
          },
        }),
      }
    );

    if (response.status === 204) return { accepted: true };
    // A non-2xx here is a real dispatch failure and is reported as such; the
    // caller decides whether another attempt is allowed.
    const detail = await safeText(response);
    return { accepted: false, detail: `github dispatch failed: ${response.status} ${detail}`.trim() };
  }

  async getRun(runId: string): Promise<ProviderRun> {
    const response = await this.fetchImpl(this.url(`/repos/${this.config.repo}/actions/runs/${runId}`), {
      method: 'GET',
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`github getRun failed: ${response.status}`);
    }
    return toRun((await response.json()) as GitHubRunPayload);
  }

  async cancel(runId: string): Promise<void> {
    await this.fetchImpl(this.url(`/repos/${this.config.repo}/actions/runs/${runId}/cancel`), {
      method: 'POST',
      headers: this.headers(),
    });
  }

  async listRecentRuns(sinceMs: number): Promise<ProviderRun[]> {
    const response = await this.fetchImpl(
      this.url(
        `/repos/${this.config.repo}/actions/workflows/${this.config.workflowFile}/runs?event=workflow_dispatch&per_page=50`
      ),
      { method: 'GET', headers: this.headers() }
    );
    if (!response.ok) {
      throw new Error(`github listRecentRuns failed: ${response.status}`);
    }
    const payload = (await response.json()) as { workflow_runs?: GitHubRunPayload[] };
    return (payload.workflow_runs ?? [])
      .map(toRun)
      .filter((run) => run.createdAt === undefined || run.createdAt >= sinceMs);
  }
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
