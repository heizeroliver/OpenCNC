import { describe, expect, it } from "vitest";
import type {
  AgentAttemptSnapshot,
  AgentConfiguration,
  AgentJobHistoryRecord
} from "../../../packages/agent-core/src/index.js";
import type { NodeWorkspaceProject, NodeWorkspaceProjectResult } from "../../../packages/agent-core/src/node-workspace.js";
import { LocalAgentService, type LocalAgentNotification, type LocalAgentServiceDependencies } from "./service.js";

const configuration: AgentConfiguration = {
  schemaVersion: "0.1",
  automationEnabled: true,
  parentProjectsFolder: "C:\\CNC Projects",
  outputFolder: "BPP",
  scanIntervalSeconds: 10,
  stabilityScans: 1,
  qaEnabled: true,
  autoStart: false,
  retryInitialSeconds: 1,
  retryMaximumSeconds: 4,
  notifyOnSuccess: false
};

class MemoryStore {
  configuration: AgentConfiguration | undefined = structuredClone(configuration);
  attempts: Record<string, AgentAttemptSnapshot> = {};
  jobs = new Map<string, AgentJobHistoryRecord>();
  async loadConfiguration(): Promise<AgentConfiguration | undefined> { return this.configuration ? structuredClone(this.configuration) : undefined; }
  async saveConfiguration(value: AgentConfiguration): Promise<void> { this.configuration = structuredClone(value); }
  async loadAttempts(): Promise<Record<string, AgentAttemptSnapshot>> { return structuredClone(this.attempts); }
  async saveAttempts(value: Record<string, AgentAttemptSnapshot>): Promise<void> { this.attempts = structuredClone(value); }
  async saveJob(value: AgentJobHistoryRecord): Promise<void> { this.jobs.set(value.id, structuredClone(value)); }
  async recentJobs(limit: number): Promise<AgentJobHistoryRecord[]> { return [...this.jobs.values()].sort((left, right) => right.detectedAt.localeCompare(left.detectedAt)).slice(0, limit).map(value => structuredClone(value)); }
}

const project = (name = "Kitchen", fingerprint = "fingerprint"): NodeWorkspaceProject => ({
  name,
  directory: `C:\\CNC Projects\\${name}`,
  fingerprint,
  files: [{ name: "part.cix", path: `C:\\CNC Projects\\${name}\\part.cix`, size: 10, lastModified: 1 }]
});

const converted = (value: NodeWorkspaceProject): NodeWorkspaceProjectResult => ({
  projectName: value.name,
  status: "converted",
  sourceCount: 1,
  written: 1,
  updated: 0,
  unchanged: 0,
  conflicts: [],
  orphanedOutputs: [],
  outputDirectory: `${value.directory}\\BPP`,
  sourceNames: ["part.cix"],
  outputNames: ["part.bpp"],
  inputChecksums: { "part.cix": "input-sha256" },
  outputChecksums: { "part.bpp": "output-sha256" },
  verified: true,
  reverseVerified: true,
  message: "1 new, 0 updated, 0 unchanged"
});

const dependencies = (overrides: Partial<LocalAgentServiceDependencies> = {}) => {
  let now = 0;
  const notifications: LocalAgentNotification[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const deps: Partial<LocalAgentServiceDependencies> = {
    now: () => now,
    createId: () => "job-1",
    setTimer: (callback, delay) => {
      const timer = setTimeout(callback, Math.max(delay, 60_000));
      timers.add(timer);
      return timer;
    },
    clearTimer: timer => { clearTimeout(timer); timers.delete(timer); },
    onNotification: notification => { notifications.push(notification); },
    ...overrides
  };
  return { deps, notifications, setNow: (value: number) => { now = value; }, clear: () => { for (const timer of timers) clearTimeout(timer); } };
};

describe("Windows local agent service", () => {
  it("persists an unchanged-input retry across restart and records recovery with checksums", async () => {
    const store = new MemoryStore();
    const item = project();
    let attempts = 0;
    const harness = dependencies({
      discover: async () => [item],
      convert: async value => {
        attempts += 1;
        if (attempts === 1) throw new Error("source temporarily locked");
        return converted(value);
      }
    });
    const first = new LocalAgentService(store, harness.deps);
    await first.start();
    expect(store.attempts[item.directory]).toMatchObject({ status: "retrying", retryCount: 1, fingerprint: item.fingerprint });
    await first.stop();

    harness.setNow(1_000);
    const restarted = new LocalAgentService(store, harness.deps);
    await restarted.start();
    const jobs = await store.recentJobs(10);
    expect(attempts).toBe(2);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "completed", retryCount: 1, inputChecksums: { "part.cix": "input-sha256" }, outputChecksums: { "part.bpp": "output-sha256" }, verified: true, reverseVerified: true });
    expect(harness.notifications.some(notification => notification.title.includes("recovered"))).toBe(true);
    await restarted.stop();
    harness.clear();
  });

  it("backs off an unavailable parent folder and reports network-style recovery", async () => {
    const store = new MemoryStore();
    const item = project();
    let unavailable = true;
    const harness = dependencies({
      discover: async () => {
        if (unavailable) throw Object.assign(new Error("network path unavailable"), { code: "ENOENT" });
        return [item];
      },
      convert: async value => converted(value)
    });
    const service = new LocalAgentService(store, harness.deps);
    await service.start();
    expect((await service.snapshot()).state).toMatchObject({ mode: "error", rootFailureCount: 1 });
    unavailable = false;
    harness.setNow(1_000);
    await service.runCycle();
    expect((await service.snapshot()).state).toMatchObject({ mode: "running", rootFailureCount: 0, projectCount: 1 });
    expect(harness.notifications.map(notification => notification.title)).toEqual(expect.arrayContaining(["OpenCNC cannot scan the monitored folder", "OpenCNC folder recovered"]));
    await service.stop();
    harness.clear();
  });

  it("processes all discovered projects and closes a deleted waiting job safely", async () => {
    const store = new MemoryStore();
    store.configuration = { ...configuration, stabilityScans: 2 };
    let projects = [project("One", "one"), project("Two", "two")];
    const processed: string[] = [];
    const harness = dependencies({
      discover: async () => projects,
      convert: async value => { processed.push(value.name); return converted(value); }
    });
    const service = new LocalAgentService(store, harness.deps);
    await service.start();
    expect((await store.recentJobs(10)).every(job => job.status === "waiting_for_stability")).toBe(true);
    projects = [projects[0]!];
    harness.setNow(10_000);
    await service.runCycle();
    const jobs = await store.recentJobs(10);
    expect(processed).toEqual(["One"]);
    expect(jobs.find(job => job.projectName === "Two")).toMatchObject({ status: "failed", message: "Project was deleted or renamed before processing completed" });
    await service.stop();
    harness.clear();
  });

  it("reevaluates a job that was interrupted while converting", async () => {
    const store = new MemoryStore();
    const item = project();
    store.attempts[item.directory] = { fingerprint: item.fingerprint, stableScans: 1, status: "ready", retryCount: 0 };
    store.jobs.set("job-1", {
      id: "job-1", projectKey: item.directory, projectName: item.name, fingerprint: item.fingerprint, sourceNames: ["part.cix"], outputNames: [],
      detectedAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString(), status: "converting", retryCount: 0,
      inputChecksums: {}, outputChecksums: {}, qaEnabled: true
    });
    const harness = dependencies({ discover: async () => [item], convert: async value => converted(value) });
    const service = new LocalAgentService(store, harness.deps);
    await service.start();
    expect((await store.recentJobs(10))[0]).toMatchObject({ id: "job-1", status: "completed", verified: true });
    await service.stop();
    harness.clear();
  });
});
