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
const CURRENT_SCHEMA_VERSION = 1;
const TERMINAL_JOB_STATUSES = ["completed", "blocked", "conflicted", "failed"] as const;
export const DEFAULT_MAXIMUM_TERMINAL_JOBS = 10_000;

const SCHEMA_SQL = `
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
`;

export class SqliteAgentStore implements AgentConfigurationStore, AgentRuntimeStore, AgentHistoryStore {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly maximumTerminalJobs = DEFAULT_MAXIMUM_TERMINAL_JOBS) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    if (!Number.isInteger(maximumTerminalJobs) || maximumTerminalJobs < 1) throw new Error("maximumTerminalJobs must be a positive integer");
    const database = new DatabaseSync(path, { timeout: 5_000 });
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      const version = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > CURRENT_SCHEMA_VERSION) throw new Error(`OpenCNC agent database schema ${version} is newer than supported schema ${CURRENT_SCHEMA_VERSION}; the database was not modified`);
      if (version < CURRENT_SCHEMA_VERSION) {
        database.exec("BEGIN IMMEDIATE");
        try {
          database.exec(SCHEMA_SQL);
          database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      const integrity = database.prepare("PRAGMA quick_check").all() as Array<Record<string, string>>;
      if (integrity.some(row => !Object.values(row).includes("ok"))) throw new Error(`OpenCNC agent database integrity check failed: ${JSON.stringify(integrity)}`);
      this.database = database;
    } catch (error) {
      if (database.isOpen) database.close();
      throw error;
    }
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
    const save = this.database.prepare(`
      INSERT INTO jobs (id, project_key, project_name, status, detected_at, completed_at, json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_key = excluded.project_key,
        project_name = excluded.project_name,
        status = excluded.status,
        detected_at = excluded.detected_at,
        completed_at = excluded.completed_at,
        json = excluded.json
    `);
    const prune = this.database.prepare(`
      DELETE FROM jobs WHERE id IN (
        SELECT id FROM jobs
        WHERE status IN (?, ?, ?, ?)
        ORDER BY detected_at DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      save.run(record.id, record.projectKey, record.projectName, record.status, record.detectedAt, record.completedAt ?? null, JSON.stringify(record));
      prune.run(...TERMINAL_JOB_STATUSES, this.maximumTerminalJobs);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async recentJobs(limit: number): Promise<AgentJobHistoryRecord[]> {
    const safeLimit = Math.max(1, Math.min(this.maximumTerminalJobs + 1_000, Math.floor(limit)));
    const rows = this.database.prepare("SELECT json FROM jobs ORDER BY detected_at DESC LIMIT ?").all(safeLimit) as unknown as JsonRow[];
    return rows.map(row => parseJson<AgentJobHistoryRecord>(row.json));
  }

  async unfinishedJobs(): Promise<AgentJobHistoryRecord[]> {
    const rows = this.database.prepare(`
      SELECT json FROM jobs
      WHERE status NOT IN (?, ?, ?, ?)
      ORDER BY detected_at ASC, id ASC
    `).all(...TERMINAL_JOB_STATUSES) as unknown as JsonRow[];
    return rows.map(row => parseJson<AgentJobHistoryRecord>(row.json));
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
