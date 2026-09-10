/**
 * Execution provider abstraction.
 *
 * The control plane owns *what* must happen and *when*; a provider owns *where*
 * a disposable runner runs. GitHub Actions is the current implementation, but the
 * state machine must not care: today's constraint is "public-repo GitHub-hosted
 * runners are free", and if that changes the provider is swapped without touching
 * the ledger, reconciliation or the review flow.
 */

export type ProviderRunState = 'queued' | 'in_progress' | 'completed' | 'unknown';

export type ProviderConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'startup_failure'
  | 'action_required'
  | 'skipped'
  | 'neutral'
  | null;

export interface ProviderRun {
  runId: string;
  state: ProviderRunState;
  conclusion: ProviderConclusion;
  url?: string;
  createdAt?: number;
}

export interface DispatchRequest {
  slotId: string;
  scheduleId: string;
  botId: string;
  occurrenceAt: number;
  attempt: number;
  /** Canonical target list; the runner must not re-derive "which occurrence". */
  targets: string[];
  /** Where the runner reports claim/result. Authenticated by a shared secret. */
  callbackUrl: string;
  /** `shadow`/`dry-run` runners must not publish to the real channel. */
  mode: 'live' | 'shadow' | 'dry-run';
}

export interface DispatchResult {
  accepted: boolean;
  detail?: string;
}

export interface ExecutionProvider {
  readonly name: string;
  /**
   * false when the provider cannot dispatch yet (missing configuration). Sweeps
   * then skip dispatch entirely instead of recording failed attempts: a
   * misconfigured deployment must not burn an occurrence's retry budget.
   */
  readonly ready?: boolean;
  /**
   * Start one execution attempt. Dispatch is at-most-once by policy: a lost HTTP
   * response is reconciled from provider state, never retried blindly.
   */
  dispatch(request: DispatchRequest): Promise<DispatchResult>;
  getRun(runId: string): Promise<ProviderRun>;
  cancel(runId: string): Promise<void>;
  /**
   * Recent runs of the batch workflow, so a dispatch whose HTTP response was lost
   * can be recognised instead of looking like "nothing was ever started".
   */
  listRecentRuns(sinceMs: number): Promise<ProviderRun[]>;
}
