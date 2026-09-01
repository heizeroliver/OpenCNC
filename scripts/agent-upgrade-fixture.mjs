import { DatabaseSync } from "node:sqlite";

const [mode, databasePath] = process.argv.slice(2);
if (!mode || !databasePath || !["prepare", "verify"].includes(mode)) {
  throw new Error("Usage: node scripts/agent-upgrade-fixture.mjs <prepare|verify> <database-path>");
}

const projectKey = "C:\\OpenCNC Upgrade Fixture\\Interrupted Project";
const jobId = "upgrade-fixture-interrupted-job";
const database = new DatabaseSync(databasePath);

try {
  if (mode === "prepare") {
    const originalVersion = Number((database.prepare("PRAGMA user_version").get()).user_version);
    if (originalVersion !== 0) throw new Error(`Expected feature-complete schema version 0, received ${originalVersion}`);
    const row = database.prepare("SELECT json FROM configuration WHERE id = 1").get();
    if (!row || typeof row.json !== "string") throw new Error("Feature-complete configuration was not initialized");
    const configuration = JSON.parse(row.json);
    configuration.parentProjectsFolder = "C:\\OpenCNC Upgrade Fixture";
    configuration.automationEnabled = false;
    configuration.notifyOnSuccess = true;
    const now = new Date().toISOString();
    const attempt = { fingerprint: "upgrade-fixture-fingerprint", stableScans: 2, status: "retrying", retryCount: 2, nextAttemptAt: Date.now() + 86_400_000, lastError: "upgrade fixture retry" };
    const job = {
      id: jobId,
      projectKey,
      projectName: "Interrupted Project",
      fingerprint: attempt.fingerprint,
      sourceNames: ["upgrade-fixture.cix"],
      outputNames: [],
      detectedAt: now,
      status: "retrying",
      retryCount: attempt.retryCount,
      inputChecksums: {},
      outputChecksums: {},
      qaEnabled: false,
      message: attempt.lastError
    };
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("UPDATE configuration SET json = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(configuration), now);
      database.prepare("INSERT OR REPLACE INTO attempts (project_key, json, updated_at) VALUES (?, ?, ?)").run(projectKey, JSON.stringify(attempt), now);
      database.prepare("INSERT OR REPLACE INTO jobs (id, project_key, project_name, status, detected_at, completed_at, json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(jobId, projectKey, job.projectName, job.status, job.detectedAt, null, JSON.stringify(job));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } else {
    const migratedVersion = Number((database.prepare("PRAGMA user_version").get()).user_version);
    if (migratedVersion !== 1) throw new Error(`Expected migrated schema version 1, received ${migratedVersion}`);
    const configurationRow = database.prepare("SELECT json FROM configuration WHERE id = 1").get();
    const configuration = JSON.parse(String(configurationRow?.json));
    if (configuration.parentProjectsFolder !== "C:\\OpenCNC Upgrade Fixture" || configuration.automationEnabled !== false || configuration.notifyOnSuccess !== true) {
      throw new Error("Persisted configuration did not survive the upgrade");
    }
    const attemptRow = database.prepare("SELECT json FROM attempts WHERE project_key = ?").get(projectKey);
    const attempt = JSON.parse(String(attemptRow?.json));
    if (attempt.status !== "retrying" || attempt.retryCount !== 2 || attempt.fingerprint !== "upgrade-fixture-fingerprint") throw new Error("Retry state did not survive the upgrade");
    const jobRow = database.prepare("SELECT status, json FROM jobs WHERE id = ?").get(jobId);
    const job = JSON.parse(String(jobRow?.json));
    if (jobRow?.status !== "retrying" || job.status !== "retrying" || job.retryCount !== 2) throw new Error("Interrupted job history did not survive the upgrade");
    const quickCheck = database.prepare("PRAGMA quick_check").get();
    if (quickCheck?.quick_check !== "ok") throw new Error(`Upgraded database quick_check failed: ${String(quickCheck?.quick_check)}`);
  }
} finally {
  database.close();
}
