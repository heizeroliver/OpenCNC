import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfiguration, AgentJobHistoryRecord } from "./index.js";
import { SqliteAgentStore } from "./sqlite-store.js";

const configuration: AgentConfiguration = {
  schemaVersion: "0.1",
  language: "hu",
  automationEnabled: true,
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

  it("versions an existing-compatible schema for explicit future migrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc sqlite schema "));
    const path = join(root, "agent.sqlite");
    try {
      const store = new SqliteAgentStore(path);
      store.close();
      const database = new DatabaseSync(path);
      const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
      database.close();
      expect(row.user_version).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("surfaces a corrupt database without deleting or replacing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc sqlite corrupt "));
    const path = join(root, "agent.sqlite");
    try {
      await writeFile(path, "not a sqlite database", "utf8");
      expect(() => new SqliteAgentStore(path)).toThrow();
      expect(await readFile(path, "utf8")).toBe("not a sqlite database");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("bounds terminal history while retaining every unfinished recovery record", async () => {
    const store = new SqliteAgentStore(":memory:", 2);
    const record = (id: string, status: AgentJobHistoryRecord["status"], detectedAt: string): AgentJobHistoryRecord => ({
      id, projectKey: id, projectName: id, fingerprint: id, sourceNames: [`${id}.cix`], outputNames: [], detectedAt, status, retryCount: 0,
      inputChecksums: {}, outputChecksums: {}, qaEnabled: false,
      ...(["completed", "blocked", "conflicted", "failed"].includes(status) ? { completedAt: detectedAt } : {})
    });
    await store.saveJob(record("interrupted", "converting", "2026-01-01T00:00:00.000Z"));
    await store.saveJob(record("old", "completed", "2026-01-02T00:00:00.000Z"));
    await store.saveJob(record("newer", "completed", "2026-01-03T00:00:00.000Z"));
    await store.saveJob(record("newest", "completed", "2026-01-04T00:00:00.000Z"));
    expect((await store.recentJobs(10)).map(value => value.id)).toEqual(["newest", "newer", "interrupted"]);
    expect(await store.unfinishedJobs()).toEqual([expect.objectContaining({ id: "interrupted", status: "converting" })]);
    store.close();
  });

  it("refuses an unknown newer schema without modifying its version", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc sqlite newer "));
    const path = join(root, "agent.sqlite");
    try {
      const database = new DatabaseSync(path);
      database.exec("PRAGMA user_version = 99");
      database.close();
      expect(() => new SqliteAgentStore(path)).toThrow(/newer than supported/);
      const reopened = new DatabaseSync(path);
      expect((reopened.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(99);
      reopened.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("migrates the feature-complete version-zero schema without losing settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc sqlite legacy "));
    const path = join(root, "agent.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec("CREATE TABLE configuration (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT");
      legacy.prepare("INSERT INTO configuration (id, json, updated_at) VALUES (1, ?, ?)").run(JSON.stringify(configuration), "2026-01-01T00:00:00.000Z");
      legacy.close();
      const store = new SqliteAgentStore(path);
      expect(await store.loadConfiguration()).toEqual(configuration);
      store.close();
      const migrated = new DatabaseSync(path);
      expect((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
      migrated.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
