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
  inspectNodeWorkspaceOutput,
  listNodeWorkspaceProjectDirectories,
  resolveOutputFolderPattern,
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
  projectFolders: LocalAgentProjectFolder[];
}

export type LocalAgentProjectFolderStatus = "converted" | "ready" | "waiting" | "attention" | "ignored_existing" | "no_cix";

export interface LocalAgentProjectFolder {
  name: string;
  directory: string;
  relativePath: string;
  depth: number;
  outputDirectory: string;
  cixCount: number;
  bppCount: number;
  managed: boolean;
  outputHealth: "untracked" | "healthy" | "drifted";
  enrolled: boolean;
  status: LocalAgentProjectFolderStatus;
  latestJobId?: string;
}

type LocalAgentStore = AgentConfigurationStore & AgentRuntimeStore & AgentHistoryStore;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface LocalAgentServiceDependencies {
  listProjectDirectories(configuration: AgentConfiguration): Promise<string[]>;
  inspectOutput(projectDirectory: string, projectName: string, configuration: AgentConfiguration): Promise<{ outputDirectory: string; bppCount: number; managed: boolean; outputChecksums: Record<string, string> }>;
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
  listProjectDirectories: configuration => listNodeWorkspaceProjectDirectories(configuration.parentProjectsFolder),
  inspectOutput: (projectDirectory, projectName, configuration) => inspectNodeWorkspaceOutput(projectDirectory, projectName, configuration.outputFolder),
  discover: configuration => discoverNodeWorkspaceProjects(configuration.parentProjectsFolder),
  convert: async (project, configuration) => {
    const machineProfile = await readMachineProfile(configuration.machineProfilePath);
    return convertNodeWorkspaceProject(project, {
      outputFolder: resolveOutputFolderPattern(configuration.outputFolder, project.name),
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
  private baselineCapturedCount: number | undefined;
  private folderInventory: Array<Omit<LocalAgentProjectFolder, "status" | "latestJobId"> & { outputStateKey: string }> = [];
  private folderJobHistory: AgentJobHistoryRecord[] = [];
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
      this.publishState("setup", this.localized("Choose the parent projects folder to begin monitoring", "A figyelés megkezdéséhez válassza ki a projektek szülőmappáját"));
      return;
    }
    if (!this.configuration.automationEnabled) {
      try { await this.discoverEligibleProjects(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.publishState("paused", this.localized(`Automation is paused; folder inventory is unavailable: ${message}`, `Az automatizálás szünetel; a mappalista nem érhető el: ${message}`));
        return;
      }
      this.publishState("paused", this.localized("Automation is paused", "Az automatizálás szünetel"));
      return;
    }
    await this.runCycle();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.cancelTimer();
    await this.cyclePromise;
    this.publishState("stopped", this.localized("OpenCNC Local Agent is stopped", "Az OpenCNC helyi ügynök leállítva"));
  }

  async updateConfiguration(value: Partial<AgentConfiguration>): Promise<AgentConfiguration> {
    if (this.cyclePromise) await this.cyclePromise;
    const parentChanged = value.parentProjectsFolder !== undefined
      && value.parentProjectsFolder.trim() !== this.configuration.parentProjectsFolder;
    const outputFolderChanged = value.outputFolder !== undefined
      && value.outputFolder.trim() !== this.configuration.outputFolder;
    const merged: Partial<AgentConfiguration> = { ...this.configuration, ...value };
    if (parentChanged) delete merged.projectEnrollment;
    const next = normalizeAgentConfiguration(merged);
    const issues = validateAgentConfiguration(next);
    if (issues.length) throw new Error(issues.join("; "));
    this.configuration = next;
    await this.store.saveConfiguration(next);
    if (outputFolderChanged) await this.store.saveAttempts({});
    await this.rebuildCore();
    this.cancelTimer();
    if (!this.started) return structuredClone(next);
    if (!next.parentProjectsFolder) this.publishState("setup", this.localized("Choose the parent projects folder to begin monitoring", "A figyelés megkezdéséhez válassza ki a projektek szülőmappáját"));
    else if (!next.automationEnabled) {
      try { await this.discoverEligibleProjects(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.publishState("paused", this.localized(`Automation is paused; folder inventory is unavailable: ${message}`, `Az automatizálás szünetel; a mappalista nem érhető el: ${message}`));
        return structuredClone(next);
      }
      this.publishState("paused", this.localized("Automation is paused", "Az automatizálás szünetel"));
    }
    else this.schedule(0);
    return structuredClone(next);
  }

  async setAutomationEnabled(enabled: boolean): Promise<void> {
    await this.updateConfiguration({ automationEnabled: enabled });
  }

  async runCycle(force = false): Promise<void> {
    if (this.cyclePromise) return this.cyclePromise;
    if (!this.started || (!force && !this.configuration.automationEnabled) || !this.configuration.parentProjectsFolder || !this.core) return;
    this.cancelTimer();
    const cycle = this.executeCycle();
    this.cyclePromise = cycle;
    try { await cycle; }
    finally {
      this.cyclePromise = undefined;
      if (force && !this.configuration.automationEnabled && this.state.mode === "running") {
        this.publishState("paused", this.localized("Manual conversion finished; automation is paused", "A kézi konvertálás befejeződött; az automatizálás szünetel"));
      }
    }
  }

  async snapshot(jobLimit = 50): Promise<LocalAgentSnapshot> {
    const recentJobs = await this.store.recentJobs(jobLimit);
    const folderJobs = [...recentJobs, ...this.folderJobHistory.filter(job => !recentJobs.some(recent => recent.id === job.id))];
    return {
      configuration: structuredClone(this.configuration),
      state: structuredClone(this.state),
      recentJobs,
      projectFolders: this.projectFolderSnapshots(folderJobs)
    };
  }

  private async executeCycle(): Promise<void> {
    this.cycleSeverity = "none";
    this.publishState("processing", this.localized("Scanning projects and processing eligible exports", "Projektek ellenőrzése és a megfelelő exportok feldolgozása"));
    let nextDelay = this.configuration.scanIntervalSeconds * 1_000;
    try {
      const result = await this.core!.runCycle(this.dependencies.now());
      if (this.baselineCapturedCount !== undefined) await this.finishBaselineExcludedJobs();
      else await this.finishMissingJobs(result.discovered);
      const recoveredFailures = this.rootFailureCount;
      this.rootFailureCount = 0;
      if (recoveredFailures) this.dependencies.onNotification({
        level: "info",
        title: this.localized("OpenCNC folder recovered", "Az OpenCNC mappája ismét elérhető"),
        body: this.localized(`The monitored folder is reachable again after ${recoveredFailures} failed scan(s).`, `A figyelt mappa ${recoveredFailures} sikertelen ellenőrzés után ismét elérhető.`)
      });
      const severity = this.currentCycleSeverity();
      if (this.baselineCapturedCount !== undefined) {
        const count = this.baselineCapturedCount;
        this.baselineCapturedCount = undefined;
        this.publishState("running", this.localized(
          `Baseline saved: ${count} existing project folder(s) ignored. Only new folders will be converted.`,
          `Kiindulási állapot mentve: ${count} meglévő projektmappa figyelmen kívül marad. Csak az új mappák lesznek konvertálva.`
        ), 0);
      } else if (severity === "error") this.publishState("error", this.localized("One or more projects will retry after a temporary failure", "Egy vagy több projekt átmeneti hiba után újra lesz próbálva"), result.discovered.length);
      else if (severity === "warning") this.publishState("warning", this.localized("One or more projects require attention", "Egy vagy több projekt figyelmet igényel"), result.discovered.length);
      else this.publishState("running", this.localized(`${result.discovered.length} project(s) monitored`, `${result.discovered.length} projekt figyelve`), result.discovered.length);
    } catch (error) {
      this.rootFailureCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      nextDelay = exponentialRetryDelay(this.rootFailureCount, this.configuration.retryInitialSeconds * 1_000, this.configuration.retryMaximumSeconds * 1_000);
      this.publishState("error", this.localized(
        `Monitored folder unavailable: ${message}. Retrying in ${Math.ceil(nextDelay / 1_000)} seconds`,
        `A figyelt mappa nem érhető el: ${message}. Újrapróbálkozás ${Math.ceil(nextDelay / 1_000)} másodperc múlva`
      ));
      if (this.rootFailureCount === 1 || this.rootFailureCount === 3) {
        this.dependencies.onNotification({
          level: "error",
          title: this.rootFailureCount === 1
            ? this.localized("OpenCNC cannot scan the monitored folder", "Az OpenCNC nem tudja ellenőrizni a figyelt mappát")
            : this.localized("OpenCNC folder failure persists", "Az OpenCNC mappahibája továbbra is fennáll"),
          body: this.localized(`${message} Retrying automatically in ${Math.ceil(nextDelay / 1_000)} seconds.`, `${message} Automatikus újrapróbálkozás ${Math.ceil(nextDelay / 1_000)} másodperc múlva.`)
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
      discover: () => this.discoverEligibleProjects(),
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
          message: this.localized(
            "The application stopped during processing; the guarded conversion will be reevaluated after restart",
            "Az alkalmazás feldolgozás közben leállt; a védett konverzió újraindítás után ismét ellenőrizve lesz"
          )
        };
        this.activeJobs.set(key, recovered);
        await this.store.saveJob(recovered);
        this.cacheFolderJob(recovered);
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
        message: this.localized("Project was deleted or renamed before processing completed", "A projektet a feldolgozás befejezése előtt törölték vagy átnevezték")
      };
      await this.store.saveJob(completed);
      this.cacheFolderJob(completed);
      this.dependencies.onJob(structuredClone(completed), record.status);
      this.activeJobs.delete(key);
    }
  }

  private async finishBaselineExcludedJobs(): Promise<void> {
    for (const [key, record] of this.activeJobs) {
      if (terminalJobStatuses.has(record.status)) continue;
      const completed: AgentJobHistoryRecord = {
        ...record,
        status: "failed",
        completedAt: this.timestamp(),
        message: this.localized(
          "Project excluded when OpenCNC captured the new-project baseline",
          "A projekt kimaradt, amikor az OpenCNC rögzítette az új projektek kiindulási állapotát"
        )
      };
      await this.store.saveJob(completed);
      this.cacheFolderJob(completed);
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
      ...(result?.outputDirectory ? { outputDirectory: result.outputDirectory } : {}),
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
    this.cacheFolderJob(next);
    if (status === "completed" && result?.verified === true && result.reverseVerified === true && result.outputDirectory) {
      this.folderInventory = this.folderInventory.map(folder => this.pathKey(folder.directory) === this.pathKey(projectKey)
        ? { ...folder, outputDirectory: result.outputDirectory, bppCount: result.outputNames?.length ?? folder.bppCount, managed: true, outputHealth: "healthy", outputStateKey: "" }
        : folder);
    }
    this.dependencies.onJob(structuredClone(next), existing?.status);
    if (terminal) this.activeJobs.delete(key);

    if (event.type === "retrying") {
      this.cycleSeverity = "error";
      if (event.retryCount === 1 || event.retryCount === 3) this.dependencies.onNotification({
        level: "error",
        title: event.retryCount === 1
          ? this.localized(`OpenCNC will retry ${event.project.name}`, `Az OpenCNC újrapróbálja: ${event.project.name}`)
          : this.localized(`Repeated conversion failure: ${event.project.name}`, `Ismétlődő konverziós hiba: ${event.project.name}`),
        body: event.message ?? this.localized("A temporary conversion error occurred.", "Átmeneti konverziós hiba történt.")
      });
    } else if (event.type === "conflicted" || event.type === "blocked") {
      if (this.cycleSeverity !== "error") this.cycleSeverity = "warning";
      this.dependencies.onNotification({
        level: "warning",
        title: event.type === "conflicted"
          ? this.localized(`Conflict in ${event.project.name}`, `Ütközés a projektben: ${event.project.name}`)
          : this.localized(`Conversion blocked for ${event.project.name}`, `A konverzió blokkolva: ${event.project.name}`),
        body: event.message ?? this.localized("Open OpenCNC Local Agent for details.", "A részletekért nyissa meg az OpenCNC helyi ügynököt.")
      });
    } else if (event.type === "completed") {
      if (event.retryCount > 0) this.dependencies.onNotification({
        level: "info",
        title: this.localized(`OpenCNC recovered ${event.project.name}`, `Az OpenCNC helyreállította: ${event.project.name}`),
        body: this.localized(`Conversion succeeded after ${event.retryCount} retry attempt(s).`, `A konverzió ${event.retryCount} újrapróbálkozás után sikerült.`)
      });
      else if (this.configuration.notifyOnSuccess && result?.status === "converted") this.dependencies.onNotification({ level: "info", title: this.localized(`Converted ${event.project.name}`, `Konvertálva: ${event.project.name}`), body: result.message });
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

  private async discoverEligibleProjects(): Promise<NodeWorkspaceProject[]> {
    const parent = this.configuration.parentProjectsFolder;
    const directories = await this.dependencies.listProjectDirectories(this.configuration);
    const enrollment = this.configuration.projectEnrollment;
    const projects = await this.dependencies.discover(this.configuration);
    const projectsByDirectory = new Map(projects.map(project => [this.pathKey(project.directory), project]));
    this.folderJobHistory = await this.store.recentJobs(10_000);
    const completedJobs = this.folderJobHistory.filter(job => job.status === "completed" && job.verified === true && job.reverseVerified === true);
    const outputs = await Promise.all(directories.map(async directory => {
      const project = projectsByDirectory.get(this.pathKey(directory));
      const name = project?.name ?? this.folderName(directory);
      const inspected = await this.dependencies.inspectOutput(directory, name, this.configuration);
      const completedJob = completedJobs.find(job => this.pathKey(job.projectKey) === this.pathKey(directory)
        && job.outputDirectory && this.pathKey(job.outputDirectory) === this.pathKey(inspected.outputDirectory));
      const actual = Object.entries(inspected.outputChecksums).sort(([left], [right]) => left.localeCompare(right));
      const expected = completedJob?.outputNames.map(outputName => [outputName, completedJob.outputChecksums[outputName]] as const).sort(([left], [right]) => left.localeCompare(right));
      const healthy = expected !== undefined && expected.length === actual.length && expected.every(([expectedName, expectedChecksum], index) => {
        const [actualName, actualChecksum] = actual[index] ?? [];
        return expectedName.normalize("NFC").toLocaleLowerCase() === actualName?.normalize("NFC").toLocaleLowerCase() && expectedChecksum?.toLocaleLowerCase() === actualChecksum?.toLocaleLowerCase();
      });
      const outputHealth = completedJob ? healthy ? "healthy" as const : "drifted" as const : "untracked" as const;
      return {
        directory, name, relativePath: this.relativePath(directory, parent), depth: this.relativePath(directory, parent).split(/[\\/]/).length - 1, cixCount: project?.files.length ?? 0,
        outputDirectory: inspected.outputDirectory, bppCount: inspected.bppCount, managed: inspected.managed,
        outputHealth,
        outputStateKey: outputHealth === "healthy" || outputHealth === "untracked" && actual.length === 0
          ? ""
          : `${outputHealth}:${actual.map(([entryName, checksum]) => `${entryName.normalize("NFC").toLocaleLowerCase()}=${checksum}`).join("|")}`
      };
    }));
    const outputByDirectory = new Map(outputs.map(output => [this.pathKey(output.directory), output]));
    const monitoredProjects = projects.map(project => {
      const output = outputByDirectory.get(this.pathKey(project.directory));
      return output?.outputStateKey ? { ...project, fingerprint: `${project.fingerprint}\u0000${output.outputStateKey}` } : project;
    });
    if (!enrollment || this.pathKey(enrollment.parentProjectsFolder) !== this.pathKey(parent)) {
      this.configuration = normalizeAgentConfiguration({
        ...this.configuration,
        projectEnrollment: {
          parentProjectsFolder: parent,
          ignoredProjectDirectories: directories,
          initializedAt: this.timestamp()
        }
      });
      await this.store.saveConfiguration(this.configuration);
      this.folderInventory = outputs.map(output => ({ ...output, enrolled: false }));
      this.baselineCapturedCount = directories.length;
      return [];
    }

    const currentKeys = new Set(directories.map(directory => this.pathKey(directory)));
    const retainedIgnored = enrollment.ignoredProjectDirectories.filter(directory => currentKeys.has(this.pathKey(directory)));
    if (retainedIgnored.length !== enrollment.ignoredProjectDirectories.length) {
      this.configuration = normalizeAgentConfiguration({
        ...this.configuration,
        projectEnrollment: { ...enrollment, ignoredProjectDirectories: retainedIgnored }
      });
      await this.store.saveConfiguration(this.configuration);
    }
    const ignored = new Set(retainedIgnored.map(directory => this.pathKey(directory)));
    this.folderInventory = outputs.map(output => ({ ...output, enrolled: !ignored.has(this.pathKey(output.directory)) }));
    return monitoredProjects.filter(project => this.pathKey(project.directory) !== this.pathKey(parent) && !ignored.has(this.pathKey(project.directory)));
  }

  private projectFolderSnapshots(jobs: AgentJobHistoryRecord[]): LocalAgentProjectFolder[] {
    return this.folderInventory.map(folder => {
      const latestJob = jobs.find(job => this.pathKey(job.projectKey) === this.pathKey(folder.directory));
      const completedJob = jobs.find(job => this.pathKey(job.projectKey) === this.pathKey(folder.directory)
        && job.status === "completed" && job.verified === true && job.reverseVerified === true && job.outputNames.length > 0
        && job.outputDirectory && this.pathKey(job.outputDirectory) === this.pathKey(folder.outputDirectory));
      const bppCount = folder.bppCount;
      const status: LocalAgentProjectFolderStatus = folder.outputHealth === "drifted" || latestJob && ["blocked", "conflicted", "failed", "retrying"].includes(latestJob.status)
        ? "attention"
        : bppCount > 0
          ? "converted"
          : folder.cixCount === 0
            ? "no_cix"
            : !folder.enrolled
              ? "ignored_existing"
              : latestJob
                ? "waiting"
                : "ready";
      const { outputStateKey: _outputStateKey, ...visibleFolder } = folder;
      return {
        ...visibleFolder,
        bppCount,
        status,
        ...(completedJob ? { latestJobId: completedJob.id } : {})
      };
    });
  }

  private folderName(directory: string): string {
    return directory.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? directory;
  }

  private cacheFolderJob(job: AgentJobHistoryRecord): void {
    this.folderJobHistory = [structuredClone(job), ...this.folderJobHistory.filter(existing => existing.id !== job.id)].slice(0, 10_000);
  }

  private relativePath(directory: string, parent: string): string {
    const cleanDirectory = directory.replace(/[\\/]+$/, "");
    const cleanParent = parent.replace(/[\\/]+$/, "");
    if (this.pathKey(cleanDirectory).startsWith(`${this.pathKey(cleanParent)}\\`) || this.pathKey(cleanDirectory).startsWith(`${this.pathKey(cleanParent)}/`)) {
      return cleanDirectory.slice(cleanParent.length).replace(/^[\\/]+/, "");
    }
    return this.folderName(cleanDirectory);
  }

  private pathKey(value: string): string {
    return value.normalize("NFC").replace(/[\\/]+$/, "").toLocaleLowerCase();
  }

  private localized(english: string, hungarian: string): string {
    return this.configuration.language === "hu" ? hungarian : english;
  }

  private currentCycleSeverity(): "none" | "warning" | "error" {
    return this.cycleSeverity;
  }

  private jobKey(projectKey: string, fingerprint: string): string {
    return `${projectKey}\u0000${fingerprint}`;
  }
}
