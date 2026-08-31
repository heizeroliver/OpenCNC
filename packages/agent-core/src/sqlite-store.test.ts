import { describe, expect, it } from "vitest";
import type { AgentConfiguration, AgentJobHistoryRecord } from "./index.js";
import { SqliteAgentStore } from "./sqlite-store.js";

const configuration: AgentConfiguration = {
  schemaVersion: "0.1",
  parentProjectsFolder: "C:\\CNC Projects",
  outputFolder: "BPP",
  scanIntervalSeconds: 10,
  stabilityScans: 2,
  qaEnabled: true,
  autoStart: true,
  retryInitialSeconds: 5,
  retryMaximumSeconds: 300,
  notifyOnSuccess: false
};

describe("SQLite agent persistence", () => {
  it("persists configuration, retry state, and job history", async () => {
    const store = new SqliteAgentStore(":memory:");
    await store.saveConfiguration(configuration);
    expect(await store.loadConfiguration()).toEqual(configuration);
    await store.saveAttempts({ project: { fingerprint: "abc", stableScans: 2, status: "retrying", retryCount: 3, nextAttemptAt: 500, lastError: "locked" } });
    expect(await store.loadAttempts()).toEqual({ project: { fingerprint: "abc", stableScans: 2, status: "retrying", retryCount: 3, nextAttemptAt: 500, lastError: "locked" } });
    const job: AgentJobHistoryRecord = {
      id: "job-1", projectKey: "project", projectName: "Kitchen", fingerprint: "abc", sourceNames: ["part.cix"], outputNames: ["part.bpp"],
      detectedAt: "2026-08-31T12:00:00.000Z", completedAt: "2026-08-31T12:00:01.000Z", status: "completed", retryCount: 0,
      inputChecksums: { "part.cix": "in" }, outputChecksums: { "part.bpp": "out" }, verified: true, reverseVerified: true, qaEnabled: true
    };
    await store.saveJob(job);
    expect(await store.recentJobs(10)).toEqual([job]);
    store.close();
  });
});
