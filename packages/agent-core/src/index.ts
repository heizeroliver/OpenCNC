export type AgentAttemptStatus = "waiting_for_stability" | "ready" | "retrying" | "completed" | "blocked" | "conflicted";

export type AgentJobStatus = "detected" | "waiting_for_stability" | "queued" | "converting" | "completed" | "retrying" | "blocked" | "conflicted" | "failed";

export interface AgentAttemptSnapshot {
  fingerprint: string;
  stableScans: number;
  status: AgentAttemptStatus;
  retryCount: number;
  nextAttemptAt?: number;
  lastError?: string;
}

export interface AgentAttemptDecision {
  attempt: boolean;
  status: AgentAttemptStatus;
  retryCount: number;
  nextAttemptAt?: number;
}

export interface AgentRetryPolicy {
  stabilityScans: number;
  initialDelayMs: number;
  maximumDelayMs: number;
}

export interface AgentConfiguration {
  schemaVersion: "0.1";
  parentProjectsFolder: string;
  outputFolder: string;
  scanIntervalSeconds: number;
  stabilityScans: number;
  qaEnabled: boolean;
  machineProfilePath?: string;
  autoStart: boolean;
  retryInitialSeconds: number;
  retryMaximumSeconds: number;
  notifyOnSuccess: boolean;
}

export interface AgentJobHistoryRecord {
  id: string;
  projectKey: string;
  projectName: string;
  fingerprint: string;
  sourceNames: string[];
  outputNames: string[];
  detectedAt: string;
  startedAt?: string;
  completedAt?: string;
  status: AgentJobStatus;
  retryCount: number;
  inputChecksums: Record<string, string>;
  outputChecksums: Record<string, string>;
  verified?: boolean;
  reverseVerified?: boolean;
  qaEnabled: boolean;
  message?: string;
}

export interface AgentConfigurationStore {
  loadConfiguration(): Promise<AgentConfiguration | undefined>;
  saveConfiguration(configuration: AgentConfiguration): Promise<void>;
}

export interface AgentRuntimeStore {
  loadAttempts(): Promise<Record<string, AgentAttemptSnapshot>>;
  saveAttempts(attempts: Record<string, AgentAttemptSnapshot>): Promise<void>;
}

export interface AgentHistoryStore {
  saveJob(record: AgentJobHistoryRecord): Promise<void>;
  recentJobs(limit: number): Promise<AgentJobHistoryRecord[]>;
}

const DEFAULT_RETRY_POLICY: AgentRetryPolicy = { stabilityScans: 2, initialDelayMs: 5_000, maximumDelayMs: 5 * 60_000 };

export const exponentialRetryDelay = (retryCount: number, initialDelayMs: number, maximumDelayMs: number): number => {
  const safeRetryCount = Math.max(1, Math.floor(retryCount));
  const safeInitial = Math.max(1, Math.floor(initialDelayMs));
  const safeMaximum = Math.max(safeInitial, Math.floor(maximumDelayMs));
  return Math.min(safeMaximum, safeInitial * 2 ** Math.min(30, safeRetryCount - 1));
};

export class AgentAttemptController {
  private readonly states = new Map<string, AgentAttemptSnapshot>();
  readonly policy: AgentRetryPolicy;

  constructor(policy: Partial<AgentRetryPolicy> = {}, initialState: Record<string, AgentAttemptSnapshot> = {}) {
    this.policy = {
      stabilityScans: Math.max(1, Math.floor(policy.stabilityScans ?? DEFAULT_RETRY_POLICY.stabilityScans)),
      initialDelayMs: Math.max(1, Math.floor(policy.initialDelayMs ?? DEFAULT_RETRY_POLICY.initialDelayMs)),
      maximumDelayMs: Math.max(1, Math.floor(policy.maximumDelayMs ?? DEFAULT_RETRY_POLICY.maximumDelayMs))
    };
    if (this.policy.maximumDelayMs < this.policy.initialDelayMs) this.policy.maximumDelayMs = this.policy.initialDelayMs;
    for (const [key, state] of Object.entries(initialState)) this.states.set(key, structuredClone(state));
  }

  observe(projectKey: string, fingerprint: string, now = Date.now()): AgentAttemptDecision {
    const previous = this.states.get(projectKey);
    const state: AgentAttemptSnapshot = !previous || previous.fingerprint !== fingerprint
      ? { fingerprint, stableScans: 1, status: "waiting_for_stability", retryCount: 0 }
      : { ...previous, stableScans: Math.min(this.policy.stabilityScans, previous.stableScans + 1) };
    if (state.stableScans < this.policy.stabilityScans) state.status = "waiting_for_stability";
    else if (state.status === "waiting_for_stability") state.status = "ready";
    this.states.set(projectKey, state);

    const retryDue = state.status === "retrying" && (state.nextAttemptAt ?? 0) <= now;
    return {
      attempt: state.status === "ready" || retryDue,
      status: state.status,
      retryCount: state.retryCount,
      ...(state.nextAttemptAt !== undefined ? { nextAttemptAt: state.nextAttemptAt } : {})
    };
  }

  recordSuccess(projectKey: string): void {
    const state = this.required(projectKey);
    this.states.set(projectKey, { fingerprint: state.fingerprint, stableScans: state.stableScans, status: "completed", retryCount: 0 });
  }

  recordPermanent(projectKey: string, status: "blocked" | "conflicted", message?: string): void {
    const state = this.required(projectKey);
    this.states.set(projectKey, { fingerprint: state.fingerprint, stableScans: state.stableScans, status, retryCount: state.retryCount, ...(message ? { lastError: message } : {}) });
  }

  recordTransientFailure(projectKey: string, error: unknown, now = Date.now()): AgentAttemptSnapshot {
    const state = this.required(projectKey);
    const retryCount = state.retryCount + 1;
    const delay = exponentialRetryDelay(retryCount, this.policy.initialDelayMs, this.policy.maximumDelayMs);
    const next: AgentAttemptSnapshot = {
      fingerprint: state.fingerprint,
      stableScans: state.stableScans,
      status: "retrying",
      retryCount,
      nextAttemptAt: now + delay,
      lastError: error instanceof Error ? error.message : String(error)
    };
    this.states.set(projectKey, next);
    return structuredClone(next);
  }

  snapshot(projectKey: string): AgentAttemptSnapshot | undefined {
    const state = this.states.get(projectKey);
    return state ? structuredClone(state) : undefined;
  }

  exportState(): Record<string, AgentAttemptSnapshot> {
    return Object.fromEntries([...this.states.entries()].map(([key, state]) => [key, structuredClone(state)]));
  }

  prune(activeProjectKeys: Iterable<string>): void {
    const active = new Set(activeProjectKeys);
    for (const key of this.states.keys()) if (!active.has(key)) this.states.delete(key);
  }

  private required(projectKey: string): AgentAttemptSnapshot {
    const state = this.states.get(projectKey);
    if (!state) throw new Error(`No agent state exists for ${projectKey}`);
    return state;
  }
}

export interface AgentCoreProject {
  name: string;
  fingerprint: string;
}

export interface AgentCoreProcessResult {
  status: "converted" | "unchanged" | "blocked" | "conflict";
  message: string;
}

export interface AgentCoreEvent<Project, Result> {
  type: "waiting" | "processing" | "completed" | "blocked" | "conflicted" | "retrying";
  project: Project;
  retryCount: number;
  result?: Result;
  message?: string;
  nextAttemptAt?: number;
}

export interface AgentCoreAdapter<Project extends AgentCoreProject, Result extends AgentCoreProcessResult> {
  discover(): Promise<Project[]>;
  projectKey(project: Project): string;
  process(project: Project): Promise<Result>;
  onEvent?(event: AgentCoreEvent<Project, Result>): void | Promise<void>;
  persistAttempts?(attempts: Record<string, AgentAttemptSnapshot>): Promise<void>;
}

export interface AgentCycleResult<Project, Result> {
  discovered: Project[];
  processed: Array<{ project: Project; result?: Result; error?: string }>;
}

export class AgentAutomationCore<Project extends AgentCoreProject, Result extends AgentCoreProcessResult> {
  constructor(readonly controller: AgentAttemptController, private readonly adapter: AgentCoreAdapter<Project, Result>) {}

  async runCycle(now = Date.now()): Promise<AgentCycleResult<Project, Result>> {
    const discovered = await this.adapter.discover();
    const keys = discovered.map(project => this.adapter.projectKey(project));
    this.controller.prune(keys);
    const processed: AgentCycleResult<Project, Result>["processed"] = [];
    for (const project of discovered) {
      const key = this.adapter.projectKey(project);
      const decision = this.controller.observe(key, project.fingerprint, now);
      if (!decision.attempt) {
        await this.adapter.onEvent?.({ type: "waiting", project, retryCount: decision.retryCount, ...(decision.nextAttemptAt !== undefined ? { nextAttemptAt: decision.nextAttemptAt } : {}) });
        continue;
      }
      await this.adapter.onEvent?.({ type: "processing", project, retryCount: decision.retryCount });
      try {
        const result = await this.adapter.process(project);
        if (result.status === "conflict") {
          this.controller.recordPermanent(key, "conflicted", result.message);
          await this.adapter.onEvent?.({ type: "conflicted", project, result, retryCount: decision.retryCount, message: result.message });
        } else if (result.status === "blocked") {
          this.controller.recordPermanent(key, "blocked", result.message);
          await this.adapter.onEvent?.({ type: "blocked", project, result, retryCount: decision.retryCount, message: result.message });
        } else {
          this.controller.recordSuccess(key);
          await this.adapter.onEvent?.({ type: "completed", project, result, retryCount: 0, message: result.message });
        }
        processed.push({ project, result });
      } catch (error) {
        const state = this.controller.recordTransientFailure(key, error, now);
        const message = state.lastError ?? "Transient automation failure";
        await this.adapter.onEvent?.({ type: "retrying", project, retryCount: state.retryCount, message, ...(state.nextAttemptAt !== undefined ? { nextAttemptAt: state.nextAttemptAt } : {}) });
        processed.push({ project, error: message });
      }
    }
    await this.adapter.persistAttempts?.(this.controller.exportState());
    return { discovered, processed };
  }
}
