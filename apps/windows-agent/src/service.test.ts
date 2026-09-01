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
  saveCalls = 0;
  async loadConfiguration(): Promise<AgentConfiguration | undefined> { return this.configuration ? structuredClone(this.configuration) : undefined; }
  async saveConfiguration(value: AgentConfiguration): Promise<void> { this.configuration = structuredClone(value); }
  async loadAttempts(): Promise<Record<string, AgentAttemptSnapshot>> { return structuredClone(this.attempts); }
  async saveAttempts(value: Record<string, AgentAttemptSnapshot>): Promise<void> { this.attempts = structuredClone(value); }
  async saveJob(value: AgentJobHistoryRecord): Promise<void> { this.saveCalls += 1; this.jobs.set(value.id, structuredClone(value)); }
  async recentJobs(limit: number): Promise<AgentJobHistoryRecord[]> { return [...this.jobs.values()].sort((left, right) => right.detectedAt.localeCompare(left.detectedAt)).slice(0, limit).map(value => structuredClone(value)); }
  async unfinishedJobs(): Promise<AgentJobHistoryRecord[]> { return [...this.jobs.values()].filter(value => !["completed", "blocked", "conflicted", "failed"].includes(value.status)).map(value => structuredClone(value)); }
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
  return {
    deps,
    notifications,
    setNow: (value: number) => { now = value; },
    timerCount: () => timers.size,
    clear: () => { for (const timer of timers) clearTimeout(timer); timers.clear(); }
  };
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

  it("does not create new history jobs for unchanged terminal fingerprints", async () => {
    const store = new MemoryStore();
    const item = project();
    let conversions = 0;
    let ids = 0;
    const harness = dependencies({
      createId: () => `job-${++ids}`,
      discover: async () => [item],
      convert: async value => { conversions += 1; return converted(value); }
    });
    const service = new LocalAgentService(store, harness.deps);
    await service.start();
    harness.setNow(10_000);
    await service.runCycle();
    harness.setNow(20_000);
    await service.runCycle();
    expect(conversions).toBe(1);
    expect(await store.recentJobs(10)).toEqual([expect.objectContaining({ id: "job-1", status: "completed" })]);
    await service.stop();
    harness.clear();
  });

  it("reports durable job transitions without repeating retry-wait diagnostics", async () => {
    const store = new MemoryStore();
    const item = project();
    const transitions: string[] = [];
    let attempts = 0;
    const harness = dependencies({
      discover: async () => [item],
      convert: async value => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporarily locked");
        return converted(value);
      },
      onJob: (job, previousStatus) => { transitions.push(`${previousStatus ?? "new"}->${job.status}`); }
    });
    const service = new LocalAgentService(store, harness.deps);
    await service.start();
    for (let now = 100; now < 1_000; now += 100) {
      harness.setNow(now);
      await service.runCycle();
    }
    harness.setNow(1_000);
    await service.runCycle();

    expect(transitions).toEqual([
      "new->converting",
      "converting->retrying",
      "retrying->converting",
      "converting->completed"
    ]);
    expect(store.saveCalls).toBe(4);
    await service.stop();
    harness.clear();
  });

  it("stays bounded through one thousand mixed polling cycles", async () => {
    const store = new MemoryStore();
    let ids = 0;
    let flakyAttempts = 0;
    let projects = [project("Stable", "stable-1"), project("Conflict", "conflict"), project("Flaky", "flaky")];
    const conversions = new Map<string, number>();
    const harness = dependencies({
      createId: () => `job-${++ids}`,
      discover: async () => projects,
      convert: async value => {
        conversions.set(value.name, (conversions.get(value.name) ?? 0) + 1);
        if (value.name === "Conflict") return { ...converted(value), status: "conflict", conflicts: ["part.bpp"], message: "manual output edit" };
        if (value.name === "Flaky" && ++flakyAttempts <= 3) throw new Error("temporary network failure");
        return converted(value);
      }
    });
    const service = new LocalAgentService(store, harness.deps);
    await service.start();

    for (let cycle = 1; cycle <= 1_000; cycle += 1) {
      if (cycle === 500) projects = [project("Stable", "stable-2"), project("Conflict", "conflict"), project("Flaky", "flaky")];
      if (cycle === 750) projects = projects.filter(value => value.name !== "Conflict");
      if (cycle === 800) projects = [...projects, project("New", "new")];
      harness.setNow(cycle * 100);
      await service.runCycle();
      expect(harness.timerCount()).toBe(1);
    }

    expect(Object.keys(store.attempts)).toHaveLength(3);
    expect(store.jobs.size).toBe(5);
    expect(store.saveCalls).toBeLessThan(40);
    expect(conversions).toEqual(new Map([["Stable", 2], ["Conflict", 1], ["Flaky", 4], ["New", 1]]));
    expect(harness.notifications.filter(value => value.title.includes("Conflict"))).toHaveLength(1);
    expect(harness.notifications.length).toBeLessThanOrEqual(4);
    await service.stop();
    expect(harness.timerCount()).toBe(0);
    harness.clear();
  });
});
