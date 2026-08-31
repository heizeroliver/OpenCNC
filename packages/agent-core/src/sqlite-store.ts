import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentAttemptSnapshot,
  AgentConfiguration,
  AgentConfigurationStore,
  AgentHistoryStore,
  AgentJobHistoryRecord,
  AgentRuntimeStore
} from "./index.js";

interface JsonRow { json: string }

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

export class SqliteAgentStore implements AgentConfigurationStore, AgentRuntimeStore, AgentHistoryStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS configuration (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS attempts (
        project_key TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        project_name TEXT NOT NULL,
        status TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        completed_at TEXT,
        json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_recent ON jobs(detected_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, detected_at DESC);
    `);
  }

  async loadConfiguration(): Promise<AgentConfiguration | undefined> {
    const row = this.database.prepare("SELECT json FROM configuration WHERE id = 1").get() as JsonRow | undefined;
    return row ? parseJson<AgentConfiguration>(row.json) : undefined;
  }

  async saveConfiguration(configuration: AgentConfiguration): Promise<void> {
    this.database.prepare(`
      INSERT INTO configuration (id, json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `).run(JSON.stringify(configuration), new Date().toISOString());
  }

  async loadAttempts(): Promise<Record<string, AgentAttemptSnapshot>> {
    const rows = this.database.prepare("SELECT project_key, json FROM attempts").all() as Array<{ project_key: string; json: string }>;
    return Object.fromEntries(rows.map(row => [row.project_key, parseJson<AgentAttemptSnapshot>(row.json)]));
  }

  async saveAttempts(attempts: Record<string, AgentAttemptSnapshot>): Promise<void> {
    const statement = this.database.prepare("INSERT INTO attempts (project_key, json, updated_at) VALUES (?, ?, ?)");
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DELETE FROM attempts");
      for (const [projectKey, state] of Object.entries(attempts)) statement.run(projectKey, JSON.stringify(state), now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async saveJob(record: AgentJobHistoryRecord): Promise<void> {
    this.database.prepare(`
      INSERT INTO jobs (id, project_key, project_name, status, detected_at, completed_at, json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_key = excluded.project_key,
        project_name = excluded.project_name,
        status = excluded.status,
        detected_at = excluded.detected_at,
        completed_at = excluded.completed_at,
        json = excluded.json
    `).run(record.id, record.projectKey, record.projectName, record.status, record.detectedAt, record.completedAt ?? null, JSON.stringify(record));
  }

  async recentJobs(limit: number): Promise<AgentJobHistoryRecord[]> {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = this.database.prepare("SELECT json FROM jobs ORDER BY detected_at DESC LIMIT ?").all(safeLimit) as unknown as JsonRow[];
    return rows.map(row => parseJson<AgentJobHistoryRecord>(row.json));
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
