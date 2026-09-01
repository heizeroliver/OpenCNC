import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AgentAttemptController,
  AgentAutomationCore,
  exponentialRetryDelay,
  normalizeAgentConfiguration,
  validateAgentConfiguration,
  type AgentConfiguration,
  type AgentConfigurationStore,
  type AgentCoreEvent,
  type AgentHistoryStore,
  type AgentJobHistoryRecord,
  type AgentRuntimeStore
} from "../../../packages/agent-core/src/index.js";
import {
  convertNodeWorkspaceProject,
  discoverNodeWorkspaceProjects,
  type NodeWorkspaceProject,
  type NodeWorkspaceProjectResult
} from "../../../packages/agent-core/src/node-workspace.js";
import { validateMachineProfile, type MachineProfile } from "../../../packages/profiles/src/index.js";

export type LocalAgentMode = "setup" | "running" | "paused" | "processing" | "warning" | "error" | "stopped";

export interface LocalAgentState {
  mode: LocalAgentMode;
  message: string;
  projectCount: number;
  rootFailureCount: number;
  lastCycleAt?: string;
  nextScanAt?: string;
}

export interface LocalAgentNotification {
  level: "info" | "warning" | "error";
  title: string;
  body: string;
}

export interface LocalAgentSnapshot {
  configuration: AgentConfiguration;
  state: LocalAgentState;
  recentJobs: AgentJobHistoryRecord[];
}

type LocalAgentStore = AgentConfigurationStore & AgentRuntimeStore & AgentHistoryStore;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface LocalAgentServiceDependencies {
  discover(configuration: AgentConfiguration): Promise<NodeWorkspaceProject[]>;
  convert(project: NodeWorkspaceProject, configuration: AgentConfiguration): Promise<NodeWorkspaceProjectResult>;
  now(): number;
  createId(): string;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  onState(state: LocalAgentState): void;
  onNotification(notification: LocalAgentNotification): void;
  onJob(record: AgentJobHistoryRecord, previousStatus: AgentJobHistoryRecord["status"] | undefined): void;
}

const terminalJobStatuses = new Set<AgentJobHistoryRecord["status"]>(["completed", "blocked", "conflicted", "failed"]);

const readMachineProfile = async (path: string | undefined): Promise<MachineProfile | undefined> => {
  if (!path) return undefined;
  const profile = JSON.parse(await readFile(path, "utf8")) as MachineProfile;
  const issues = validateMachineProfile(profile);
  if (issues.length) throw new Error(`Invalid machine profile: ${issues.join("; ")}`);
  return profile;
};

const defaultDependencies = (): LocalAgentServiceDependencies => ({
  discover: configuration => discoverNodeWorkspaceProjects(configuration.parentProjectsFolder),
  convert: async (project, configuration) => {
    const machineProfile = await readMachineProfile(configuration.machineProfilePath);
    return convertNodeWorkspaceProject(project, {
      outputFolder: configuration.outputFolder,
      includeQa: configuration.qaEnabled,
      ...(machineProfile ? { machineProfile } : {})
    });
  },
  now: () => Date.now(),
  createId: () => randomUUID(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: handle => clearTimeout(handle),
  onState: () => undefined,
  onNotification: () => undefined,
  onJob: () => undefined
});

export class LocalAgentService {
  private configuration = normalizeAgentConfiguration(undefined);
  private state: LocalAgentState = { mode: "stopped", message: "OpenCNC Local Agent is stopped", projectCount: 0, rootFailureCount: 0 };
  private core: AgentAutomationCore<NodeWorkspaceProject, NodeWorkspaceProjectResult> | undefined;
  private activeJobs = new Map<string, AgentJobHistoryRecord>();
  private timer: TimerHandle | undefined;
  private cyclePromise: Promise<void> | undefined;
  private started = false;
  private rootFailureCount = 0;
  private cycleSeverity: "none" | "warning" | "error" = "none";
  private readonly dependencies: LocalAgentServiceDependencies;

  constructor(private readonly store: LocalAgentStore, dependencies: Partial<LocalAgentServiceDependencies> = {}) {
    this.dependencies = { ...defaultDependencies(), ...dependencies };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.configuration = normalizeAgentConfiguration(await this.store.loadConfiguration());
    const issues = validateAgentConfiguration(this.configuration);
    if (issues.length) throw new Error(`Invalid saved agent configuration: ${issues.join("; ")}`);
    await this.store.saveConfiguration(this.configuration);
    await this.restoreJobs();
    await this.rebuildCore();
    this.started = true;
    if (!this.configuration.parentProjectsFolder) {
      this.publishState("setup", "Choose the parent projects folder to begin monitoring");
      return;
    }
    if (!this.configuration.automationEnabled) {
      this.publishState("paused", "Automation is paused");
      return;
    }
    await this.runCycle();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.cancelTimer();
    await this.cyclePromise;
    this.publishState("stopped", "OpenCNC Local Agent is stopped");
  }

  async updateConfiguration(value: Partial<AgentConfiguration>): Promise<AgentConfiguration> {
    if (this.cyclePromise) await this.cyclePromise;
    const next = normalizeAgentConfiguration({ ...this.configuration, ...value });
    const issues = validateAgentConfiguration(next);
    if (issues.length) throw new Error(issues.join("; "));
    this.configuration = next;
    await this.store.saveConfiguration(next);
    await this.rebuildCore();
    this.cancelTimer();
    if (!this.started) return structuredClone(next);
    if (!next.parentProjectsFolder) this.publishState("setup", "Choose the parent projects folder to begin monitoring");
    else if (!next.automationEnabled) this.publishState("paused", "Automation is paused");
    else this.schedule(0);
    return structuredClone(next);
  }

  async setAutomationEnabled(enabled: boolean): Promise<void> {
    await this.updateConfiguration({ automationEnabled: enabled });
  }

  async runCycle(): Promise<void> {
    if (this.cyclePromise) return this.cyclePromise;
    if (!this.started || !this.configuration.automationEnabled || !this.configuration.parentProjectsFolder || !this.core) return;
    this.cancelTimer();
    const cycle = this.executeCycle();
    this.cyclePromise = cycle;
    try { await cycle; }
    finally { this.cyclePromise = undefined; }
  }

  async snapshot(jobLimit = 50): Promise<LocalAgentSnapshot> {
    return {
      configuration: structuredClone(this.configuration),
      state: structuredClone(this.state),
      recentJobs: await this.store.recentJobs(jobLimit)
    };
  }

  private async executeCycle(): Promise<void> {
    this.cycleSeverity = "none";
    this.publishState("processing", "Scanning projects and processing eligible exports");
    let nextDelay = this.configuration.scanIntervalSeconds * 1_000;
    try {
      const result = await this.core!.runCycle(this.dependencies.now());
      await this.finishMissingJobs(result.discovered);
      const recoveredFailures = this.rootFailureCount;
      this.rootFailureCount = 0;
      if (recoveredFailures) this.dependencies.onNotification({ level: "info", title: "OpenCNC folder recovered", body: `The monitored folder is reachable again after ${recoveredFailures} failed scan(s).` });
      const severity = this.currentCycleSeverity();
      if (severity === "error") this.publishState("error", "One or more projects will retry after a temporary failure", result.discovered.length);
      else if (severity === "warning") this.publishState("warning", "One or more projects require attention", result.discovered.length);
      else this.publishState("running", `${result.discovered.length} project(s) monitored`, result.discovered.length);
    } catch (error) {
      this.rootFailureCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      nextDelay = exponentialRetryDelay(this.rootFailureCount, this.configuration.retryInitialSeconds * 1_000, this.configuration.retryMaximumSeconds * 1_000);
      this.publishState("error", `Monitored folder unavailable: ${message}. Retrying in ${Math.ceil(nextDelay / 1_000)} seconds`);
      if (this.rootFailureCount === 1 || this.rootFailureCount === 3) {
        this.dependencies.onNotification({
          level: "error",
          title: this.rootFailureCount === 1 ? "OpenCNC cannot scan the monitored folder" : "OpenCNC folder failure persists",
          body: `${message} Retrying automatically in ${Math.ceil(nextDelay / 1_000)} seconds.`
        });
      }
    } finally {
      if (this.started && this.configuration.automationEnabled && this.configuration.parentProjectsFolder) this.schedule(nextDelay);
    }
  }

  private async rebuildCore(): Promise<void> {
    const attempts = await this.store.loadAttempts();
    const controller = new AgentAttemptController({
      stabilityScans: this.configuration.stabilityScans,
      initialDelayMs: this.configuration.retryInitialSeconds * 1_000,
      maximumDelayMs: this.configuration.retryMaximumSeconds * 1_000
    }, attempts);
    this.core = new AgentAutomationCore(controller, {
      discover: () => this.dependencies.discover(this.configuration),
      projectKey: project => project.directory,
      process: project => this.dependencies.convert(project, this.configuration),
      onEvent: event => this.recordEvent(event),
      persistAttempts: state => this.store.saveAttempts(state)
    });
  }

  private async restoreJobs(): Promise<void> {
    for (const record of await this.store.unfinishedJobs()) {
      const key = this.jobKey(record.projectKey, record.fingerprint);
      if (!this.activeJobs.has(key)) this.activeJobs.set(key, record);
      if (record.status === "converting") {
        const recovered: AgentJobHistoryRecord = {
          ...record,
          status: "retrying",
          message: "The application stopped during processing; the guarded conversion will be reevaluated after restart"
        };
        this.activeJobs.set(key, recovered);
        await this.store.saveJob(recovered);
        this.dependencies.onJob(structuredClone(recovered), record.status);
      }
    }
  }

  private async finishMissingJobs(discovered: NodeWorkspaceProject[]): Promise<void> {
    const activeKeys = new Set(discovered.map(project => project.directory));
    for (const [key, record] of this.activeJobs) {
      if (activeKeys.has(record.projectKey) || terminalJobStatuses.has(record.status)) continue;
      const completed: AgentJobHistoryRecord = {
        ...record,
        status: "failed",
        completedAt: this.timestamp(),
        message: "Project was deleted or renamed before processing completed"
      };
      await this.store.saveJob(completed);
      this.dependencies.onJob(structuredClone(completed), record.status);
      this.activeJobs.delete(key);
    }
  }

  private async recordEvent(event: AgentCoreEvent<NodeWorkspaceProject, NodeWorkspaceProjectResult>): Promise<void> {
    if (event.type === "waiting" && event.attemptStatus === "completed") return;
    if (event.type === "waiting" && (event.attemptStatus === "blocked" || event.attemptStatus === "conflicted")) {
      if (this.cycleSeverity !== "error") this.cycleSeverity = "warning";
      return;
    }
    if (event.type === "waiting" && event.attemptStatus === "retrying") this.cycleSeverity = "error";
    const projectKey = event.project.directory;
    const key = this.jobKey(projectKey, event.project.fingerprint);
    const existing = this.activeJobs.get(key);
    const base: AgentJobHistoryRecord = existing ?? {
      id: this.dependencies.createId(),
      projectKey,
      projectName: event.project.name,
      fingerprint: event.project.fingerprint,
      sourceNames: event.project.files.map(file => file.name),
      outputNames: [],
      detectedAt: this.timestamp(),
      status: "detected",
      retryCount: 0,
      inputChecksums: {},
      outputChecksums: {},
      qaEnabled: this.configuration.qaEnabled
    };
    const status: AgentJobHistoryRecord["status"] = event.type === "waiting"
      ? event.nextAttemptAt !== undefined ? "retrying" : "waiting_for_stability"
      : event.type === "processing" ? "converting"
      : event.type === "completed" ? "completed"
      : event.type === "blocked" ? "blocked"
      : event.type === "conflicted" ? "conflicted"
      : "retrying";
    const terminal = terminalJobStatuses.has(status);
    const result = event.result;
    if (event.type === "waiting" && existing?.status === status && existing.retryCount === event.retryCount) return;
    const next: AgentJobHistoryRecord = {
      ...base,
      status,
      retryCount: event.retryCount,
      sourceNames: result?.sourceNames ?? base.sourceNames,
      outputNames: result?.outputNames ?? base.outputNames,
      inputChecksums: result?.inputChecksums ?? base.inputChecksums,
      outputChecksums: result?.outputChecksums ?? base.outputChecksums,
      qaEnabled: this.configuration.qaEnabled,
      ...(event.type === "processing" && !base.startedAt ? { startedAt: this.timestamp() } : {}),
      ...(terminal ? { completedAt: this.timestamp() } : {}),
      ...(result?.verified !== undefined ? { verified: result.verified } : {}),
      ...(result?.reverseVerified !== undefined ? { reverseVerified: result.reverseVerified } : {}),
      ...(event.message ? { message: event.message } : {})
    };
    this.activeJobs.set(key, next);
    await this.store.saveJob(next);
    this.dependencies.onJob(structuredClone(next), existing?.status);
    if (terminal) this.activeJobs.delete(key);

    if (event.type === "retrying") {
      this.cycleSeverity = "error";
      if (event.retryCount === 1 || event.retryCount === 3) this.dependencies.onNotification({
        level: "error",
        title: event.retryCount === 1 ? `OpenCNC will retry ${event.project.name}` : `Repeated conversion failure: ${event.project.name}`,
        body: event.message ?? "A temporary conversion error occurred."
      });
    } else if (event.type === "conflicted" || event.type === "blocked") {
      if (this.cycleSeverity !== "error") this.cycleSeverity = "warning";
      this.dependencies.onNotification({
        level: "warning",
        title: event.type === "conflicted" ? `Conflict in ${event.project.name}` : `Conversion blocked for ${event.project.name}`,
        body: event.message ?? "Open OpenCNC Local Agent for details."
      });
    } else if (event.type === "completed") {
      if (event.retryCount > 0) this.dependencies.onNotification({ level: "info", title: `OpenCNC recovered ${event.project.name}`, body: `Conversion succeeded after ${event.retryCount} retry attempt(s).` });
      else if (this.configuration.notifyOnSuccess && result?.status === "converted") this.dependencies.onNotification({ level: "info", title: `Converted ${event.project.name}`, body: result.message });
    }
  }

  private publishState(mode: LocalAgentMode, message: string, projectCount = this.state.projectCount): void {
    const now = this.timestamp();
    this.state = {
      mode,
      message,
      projectCount,
      rootFailureCount: this.rootFailureCount,
      ...(mode !== "setup" && mode !== "paused" && mode !== "stopped" ? { lastCycleAt: now } : {}),
      ...(this.timer ? { nextScanAt: this.state.nextScanAt } : {})
    };
    this.dependencies.onState(structuredClone(this.state));
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    const due = this.dependencies.now() + Math.max(0, delayMs);
    this.timer = this.dependencies.setTimer(() => { this.timer = undefined; void this.runCycle(); }, Math.max(0, delayMs));
    this.state = { ...this.state, nextScanAt: new Date(due).toISOString() };
    this.dependencies.onState(structuredClone(this.state));
  }

  private cancelTimer(): void {
    if (this.timer) this.dependencies.clearTimer(this.timer);
    this.timer = undefined;
    if (this.state.nextScanAt) {
      const { nextScanAt: _nextScanAt, ...state } = this.state;
      this.state = state;
    }
  }

  private timestamp(): string {
    return new Date(this.dependencies.now()).toISOString();
  }

  private currentCycleSeverity(): "none" | "warning" | "error" {
    return this.cycleSeverity;
  }

  private jobKey(projectKey: string, fingerprint: string): string {
    return `${projectKey}\u0000${fingerprint}`;
  }
}
