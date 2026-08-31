import type { BulkConversionReport } from "../../../packages/converter/src/index.js";
import type { CorpusLabReport } from "../../../packages/corpus/src/index.js";
import type { OpenCncDocument, SourceFormat } from "../../../packages/core/src/index.js";
import { compareDocuments } from "./workshop.js";

export type SimulationStatus = "not-reviewed" | "pending" | "approved" | "rejected";

export interface StoredProjectFile {
  name: string;
  size: number;
  sourceText: string;
  sourceFormat: SourceFormat;
}

export interface SessionComparisonSnapshot {
  comparedAt: string;
  comparableFiles: number;
  addedFiles: string[];
  removedFiles: string[];
  semanticMatches: number;
  geometryMatches: number;
  changedFiles: string[];
}

export interface ProjectSession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archiveName: string;
  operatorNotes: string;
  simulationStatus: SimulationStatus;
  selectedFileName: string;
  files: StoredProjectFile[];
  conversionReport?: BulkConversionReport;
  previousComparison?: SessionComparisonSnapshot;
}

export interface SessionSummary {
  id: string;
  name: string;
  updatedAt: string;
  archiveName: string;
  simulationStatus: SimulationStatus;
  fileCount: number;
  conversionCount: number;
  previousComparison?: SessionComparisonSnapshot;
}

export interface ProjectStore {
  saveSession(session: ProjectSession): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  loadSession(id: string): Promise<ProjectSession | undefined>;
  saveCorpusReport(report: CorpusLabReport): Promise<void>;
  latestCorpusReport(): Promise<CorpusLabReport | undefined>;
}

export function createProjectSession(input: Omit<ProjectSession, "id" | "createdAt" | "updatedAt">, options: { id?: string; now?: string } = {}): ProjectSession {
  const now = options.now ?? new Date().toISOString();
  return { ...input, id: options.id ?? crypto.randomUUID(), createdAt: now, updatedAt: now };
}

const summary = (session: ProjectSession): SessionSummary => ({
  id: session.id,
  name: session.name,
  updatedAt: session.updatedAt,
  archiveName: session.archiveName,
  simulationStatus: session.simulationStatus,
  fileCount: session.files.length,
  conversionCount: session.conversionReport?.summary.converted ?? 0,
  ...(session.previousComparison ? { previousComparison: session.previousComparison } : {})
});

export function compareProjectFiles(
  previous: Array<{ name: string; document: OpenCncDocument }>,
  current: Array<{ name: string; document: OpenCncDocument }>,
  comparedAt = new Date().toISOString()
): SessionComparisonSnapshot {
  const normalize = (name: string): string => name.toLocaleLowerCase();
  const previousByName = new Map(previous.map(file => [normalize(file.name), file]));
  const currentByName = new Map(current.map(file => [normalize(file.name), file]));
  const addedFiles = current.filter(file => !previousByName.has(normalize(file.name))).map(file => file.name).sort();
  const removedFiles = previous.filter(file => !currentByName.has(normalize(file.name))).map(file => file.name).sort();
  let semanticMatches = 0;
  let geometryMatches = 0;
  const changedFiles: string[] = [];
  for (const file of current) {
    const older = previousByName.get(normalize(file.name));
    if (!older) continue;
    const comparison = compareDocuments(older.document, file.document);
    if (comparison.semanticMatch) semanticMatches += 1;
    if (comparison.geometryMatch) geometryMatches += 1;
    if (!comparison.semanticMatch || !comparison.geometryMatch) changedFiles.push(file.name);
  }
  return { comparedAt, comparableFiles: current.filter(file => previousByName.has(normalize(file.name))).length, addedFiles, removedFiles, semanticMatches, geometryMatches, changedFiles };
}

export function createMemoryProjectStore(): ProjectStore {
  const sessions = new Map<string, ProjectSession>();
  const corpusReports: CorpusLabReport[] = [];
  return {
    async saveSession(session) { sessions.set(session.id, structuredClone(session)); },
    async listSessions() { return [...sessions.values()].map(summary).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)); },
    async loadSession(id) { const session = sessions.get(id); return session ? structuredClone(session) : undefined; },
    async saveCorpusReport(report) { corpusReports.push(structuredClone(report)); },
    async latestCorpusReport() { const report = corpusReports.at(-1); return report ? structuredClone(report) : undefined; }
  };
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.addEventListener("success", () => resolve(request.result));
  request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")));
});

const transactionComplete = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.addEventListener("complete", () => resolve());
  transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")));
  transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")));
});

export function createIndexedDbProjectStore(indexedDb: IDBFactory = indexedDB): ProjectStore {
  const opening = indexedDb.open("opencnc-local-projects", 1);
  const ready = new Promise<IDBDatabase>((resolve, reject) => {
    opening.addEventListener("upgradeneeded", () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains("sessions")) {
        const store = db.createObjectStore("sessions", { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains("corpusReports")) {
        const store = db.createObjectStore("corpusReports", { keyPath: "runId" });
        store.createIndex("generatedAt", "generatedAt");
      }
    });
    opening.addEventListener("success", () => { opening.result.addEventListener("versionchange", () => opening.result.close()); resolve(opening.result); });
    opening.addEventListener("error", () => reject(opening.error ?? new Error("Could not open local project history")));
  });

  return {
    async saveSession(session) {
      const db = await ready;
      const transaction = db.transaction("sessions", "readwrite");
      transaction.objectStore("sessions").put(session);
      await transactionComplete(transaction);
    },
    async listSessions() {
      const db = await ready;
      const transaction = db.transaction("sessions", "readonly");
      const sessions = await requestResult(transaction.objectStore("sessions").getAll()) as ProjectSession[];
      await transactionComplete(transaction);
      return sessions.map(summary).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async loadSession(id) {
      const db = await ready;
      const transaction = db.transaction("sessions", "readonly");
      const session = await requestResult(transaction.objectStore("sessions").get(id)) as ProjectSession | undefined;
      await transactionComplete(transaction);
      return session;
    },
    async saveCorpusReport(report) {
      const db = await ready;
      const transaction = db.transaction("corpusReports", "readwrite");
      transaction.objectStore("corpusReports").put(report);
      await transactionComplete(transaction);
    },
    async latestCorpusReport() {
      const db = await ready;
      const transaction = db.transaction("corpusReports", "readonly");
      const reports = await requestResult(transaction.objectStore("corpusReports").getAll()) as CorpusLabReport[];
      await transactionComplete(transaction);
      return reports.sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0];
    }
  };
}
