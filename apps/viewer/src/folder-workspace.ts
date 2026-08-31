import { bulkConvertAndVerify, type BulkConversionReport } from "../../../packages/converter/src/index.js";
import { validateDocument } from "../../../packages/core/src/index.js";
import { parseCix } from "../../../packages/parser-cix/src/index.js";
import {
  createWorkspaceManifest,
  parseWorkspaceManifest,
  planWorkspaceWrite,
  quickWorkspaceFingerprint,
  sha256Hex,
  workspaceNeedsConversion,
  type WorkspaceManifest,
  type WorkspaceManifestEntry,
  type WorkspaceWriteDecision
} from "../../../packages/workspace/src/index.js";
import type { MachineProfile } from "../../../packages/profiles/src/index.js";

export const WORKSPACE_OUTPUT_FOLDER = "BPP";
export const WORKSPACE_MANIFEST_FILE = "opencnc-sync-manifest.json";
export const WORKSPACE_REPORT_FILE = "opencnc-conversion-report.json";

export interface WorkspaceSourceFile {
  name: string;
  size: number;
  lastModified: number;
  handle: FileSystemFileHandle;
}

export interface WorkspaceProject {
  name: string;
  handle: FileSystemDirectoryHandle;
  isRoot: boolean;
  cixFiles: WorkspaceSourceFile[];
  bppFiles: string[];
  fingerprint: string;
  needsConversion: boolean;
  manifest?: WorkspaceManifest;
}

export interface LoadedWorkspaceFile {
  name: string;
  size: number;
  lastModified: number;
  sourceText: string;
}

export interface WorkspaceConflict {
  sourceName: string;
  outputName: string;
  reason: "existing-file-not-created-by-opencnc" | "existing-file-was-edited";
}

export interface WorkspaceConversionResult {
  status: "converted" | "unchanged" | "blocked" | "conflict";
  projectName: string;
  sourceCount: number;
  written: number;
  updated: number;
  unchanged: number;
  conflicts: WorkspaceConflict[];
  orphanedOutputs: string[];
  report?: BulkConversionReport;
  message: string;
}

export interface SavedWorkspace {
  rootHandle: FileSystemDirectoryHandle;
  selectedProjectName?: string;
  autoConvert: boolean;
  includeQa: boolean;
}

const optionalFile = async (directory: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle | undefined> => {
  try { return await directory.getFileHandle(name); }
  catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return undefined; throw error; }
};

const optionalDirectory = async (directory: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | undefined> => {
  try { return await directory.getDirectoryHandle(name); }
  catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return undefined; throw error; }
};

const readOptionalText = async (directory: FileSystemDirectoryHandle, name: string): Promise<string | undefined> => {
  const handle = await optionalFile(directory, name);
  return handle ? (await handle.getFile()).text() : undefined;
};

const listBppFiles = async (directory: FileSystemDirectoryHandle | undefined): Promise<string[]> => {
  if (!directory) return [];
  const names: string[] = [];
  for await (const entry of directory.values()) if (entry.kind === "file" && /\.bpp$/i.test(entry.name)) names.push(entry.name);
  return names.sort((left, right) => left.localeCompare(right));
};

const scanProject = async (name: string, handle: FileSystemDirectoryHandle, isRoot: boolean): Promise<WorkspaceProject | undefined> => {
  const cixFiles: WorkspaceSourceFile[] = [];
  for await (const entry of handle.values()) {
    if (entry.kind !== "file" || !/\.cix$/i.test(entry.name)) continue;
    const file = await entry.getFile();
    cixFiles.push({ name: entry.name, size: file.size, lastModified: file.lastModified, handle: entry });
  }
  if (!cixFiles.length) return undefined;
  cixFiles.sort((left, right) => left.name.localeCompare(right.name));
  const outputDirectory = await optionalDirectory(handle, WORKSPACE_OUTPUT_FOLDER);
  const bppFiles = await listBppFiles(outputDirectory);
  const manifest = parseWorkspaceManifest(outputDirectory ? await readOptionalText(outputDirectory, WORKSPACE_MANIFEST_FILE) : undefined);
  return {
    name,
    handle,
    isRoot,
    cixFiles,
    bppFiles,
    fingerprint: quickWorkspaceFingerprint(cixFiles),
    needsConversion: workspaceNeedsConversion(cixFiles, bppFiles, manifest),
    ...(manifest ? { manifest } : {})
  };
};

export function folderWorkspaceSupported(): boolean {
  return typeof window.showDirectoryPicker === "function";
}

export async function chooseWorkspaceFolder(): Promise<FileSystemDirectoryHandle> {
  if (!folderWorkspaceSupported()) throw new Error("Direct folder access requires a Chromium-based browser such as Chrome or Edge");
  return window.showDirectoryPicker({ id: "opencnc-workspace", mode: "readwrite", startIn: "documents" });
}

export async function workspacePermission(handle: FileSystemDirectoryHandle, request = false): Promise<PermissionState> {
  const options: FileSystemHandlePermissionDescriptor = { mode: "readwrite" };
  const state = await handle.queryPermission(options);
  return state === "prompt" && request ? handle.requestPermission(options) : state;
}

export async function scanWorkspace(root: FileSystemDirectoryHandle): Promise<WorkspaceProject[]> {
  const projects: WorkspaceProject[] = [];
  const rootProject = await scanProject(root.name, root, true);
  if (rootProject) projects.push(rootProject);
  for await (const entry of root.values()) {
    if (entry.kind !== "directory" || entry.name === WORKSPACE_OUTPUT_FOLDER || entry.name.startsWith(".")) continue;
    const project = await scanProject(entry.name, entry, false);
    if (project) projects.push(project);
  }
  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadWorkspaceProject(project: WorkspaceProject): Promise<LoadedWorkspaceFile[]> {
  return Promise.all(project.cixFiles.map(async source => {
    const file = await source.handle.getFile();
    return { name: source.name, size: file.size, lastModified: file.lastModified, sourceText: await file.text() };
  }));
}

const writeFile = async (directory: FileSystemDirectoryHandle, name: string, contents: string | Uint8Array): Promise<void> => {
  const file = await directory.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  const payload = typeof contents === "string" ? contents : contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength) as ArrayBuffer;
  await writable.write(payload);
  await writable.close();
};

export async function convertWorkspaceProject(project: WorkspaceProject, options: { machineProfile?: MachineProfile; includeQa?: boolean } = {}): Promise<WorkspaceConversionResult> {
  const sources = await loadWorkspaceProject(project);
  const inputs = sources.map(source => {
    const document = parseCix(source.sourceText, source.name);
    document.diagnostics.push(...validateDocument(document));
    return { name: source.name, document };
  });
  const conversion = bulkConvertAndVerify(inputs, options.machineProfile ? { machineProfile: options.machineProfile } : {});
  const blocked = conversion.outputs.filter(item => item.status !== "converted" || item.contents === undefined || !item.verified || !item.reverseVerified || !item.supportedSemanticRoundTrip || !item.expandedGeometryRoundTrip);
  if (blocked.length) return {
    status: "blocked",
    projectName: project.name,
    sourceCount: sources.length,
    written: 0,
    updated: 0,
    unchanged: 0,
    conflicts: [],
    orphanedOutputs: [],
    report: conversion.report,
    message: `${blocked.length}/${conversion.outputs.length} conversion job(s) failed the guarded checks; no folder files were written`
  };

  const outputDirectory = await project.handle.getDirectoryHandle(WORKSPACE_OUTPUT_FOLDER, { create: true });
  const previousManifest = parseWorkspaceManifest(await readOptionalText(outputDirectory, WORKSPACE_MANIFEST_FILE));
  const previousBySource = new Map(previousManifest?.entries.map(entry => [entry.name.toLocaleLowerCase(), entry]) ?? []);
  const sourceByName = new Map(sources.map(source => [source.name.toLocaleLowerCase(), source]));
  const plans: Array<{ sources: LoadedWorkspaceFile[]; item: (typeof conversion.outputs)[number]; targetChecksum: string; decision: WorkspaceWriteDecision }> = [];
  const conflicts: WorkspaceConflict[] = [];
  for (const item of conversion.outputs) {
    const itemSources = item.sourceNames.map(name => sourceByName.get(name.toLocaleLowerCase())).filter((source): source is LoadedWorkspaceFile => Boolean(source));
    if (itemSources.length !== item.sourceNames.length) throw new Error(`Missing workspace source data for ${item.sourceNames.join(", ")}`);
    const targetChecksum = await sha256Hex(item.contents!);
    const existing = await optionalFile(outputDirectory, item.outputName);
    const existingChecksum = existing ? await sha256Hex(new Uint8Array(await (await existing.getFile()).arrayBuffer())) : undefined;
    const previousEntries = itemSources.map(source => previousBySource.get(source.name.toLocaleLowerCase())).filter((entry): entry is WorkspaceManifestEntry => Boolean(entry));
    const previousEntry = previousEntries.find(entry => entry.outputName === item.outputName && entry.targetChecksum === existingChecksum) ?? previousEntries[0];
    const decision = planWorkspaceWrite({ outputName: item.outputName, targetChecksum, ...(existingChecksum ? { existingChecksum } : {}), ...(previousEntry ? { previousEntry } : {}) });
    if (decision === "conflict") conflicts.push({
      sourceName: item.sourceNames.join(" + "),
      outputName: item.outputName,
      reason: previousEntry ? "existing-file-was-edited" : "existing-file-not-created-by-opencnc"
    });
    plans.push({ sources: itemSources, item, targetChecksum, decision });
  }
  if (conflicts.length) return {
    status: "conflict",
    projectName: project.name,
    sourceCount: sources.length,
    written: 0,
    updated: 0,
    unchanged: plans.filter(plan => plan.decision === "unchanged").length,
    conflicts,
    orphanedOutputs: [],
    report: conversion.report,
    message: `${conflicts.length} existing BPP file(s) are not safe to overwrite; no folder files were written`
  };

  const now = new Date().toISOString();
  const manifestEntries: WorkspaceManifestEntry[] = [];
  for (const plan of plans) {
    if (plan.decision !== "unchanged") await writeFile(outputDirectory, plan.item.outputName, plan.item.contents!);
    for (const source of plan.sources) manifestEntries.push({
      name: source.name,
      size: source.size,
      lastModified: source.lastModified,
      sourceChecksum: await sha256Hex(source.sourceText),
      outputName: plan.item.outputName,
      targetChecksum: plan.targetChecksum,
      convertedAt: now,
      verified: true,
      reverseVerified: true,
      semanticRoundTrip: true,
      geometryRoundTrip: true
    });
  }

  const qaArtifacts = options.includeQa ? await (async () => {
    const qaDirectory = await outputDirectory.getDirectoryHandle("QA", { create: true });
    const { generateQaJobSheet } = await import("../../../packages/qa/src/index.js");
    return Promise.all(conversion.outputs.map(async item => {
      const itemSources = item.sourceNames.map(name => sourceByName.get(name.toLocaleLowerCase()))!;
      const qa = await generateQaJobSheet({ item, sourceDocument: item.sourceDocument, sourceText: itemSources.map(source => source!.sourceText).join("\r\n; OPENCNC TWO-SIDED SOURCE BOUNDARY\r\n") });
      await writeFile(qaDirectory, qa.filename, qa.bytes);
      return { sourceNames: item.sourceNames, outputName: item.outputName, pdfName: `QA/${qa.filename}`, reportId: qa.reportId, fidelityGrade: qa.fidelityGrade, sourceChecksum: qa.sourceChecksum, targetChecksum: qa.targetChecksum };
    }));
  })() : [];
  const manifest = createWorkspaceManifest(project.name, manifestEntries, now);
  const currentOutputs = new Set(manifestEntries.map(entry => entry.outputName.toLocaleLowerCase()));
  const orphanedOutputs = project.bppFiles.filter(name => !currentOutputs.has(name.toLocaleLowerCase()));
  const report = {
    ...conversion.report,
    generatedAt: now,
    workspace: { projectName: project.name, outputFolder: WORKSPACE_OUTPUT_FOLDER, orphanedOutputs, safety: "existing outputs are overwritten only when their checksum matches the previous OpenCNC manifest" },
    qaArtifacts
  };
  await writeFile(outputDirectory, WORKSPACE_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(outputDirectory, WORKSPACE_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  const written = plans.filter(plan => plan.decision === "create").length;
  const updated = plans.filter(plan => plan.decision === "update").length;
  const unchanged = plans.filter(plan => plan.decision === "unchanged").length;
  return {
    status: written || updated ? "converted" : "unchanged",
    projectName: project.name,
    sourceCount: sources.length,
    written,
    updated,
    unchanged,
    conflicts: [],
    orphanedOutputs,
    report,
    message: written || updated ? `${written} new and ${updated} updated BPP file(s) written to ${project.name}/${WORKSPACE_OUTPUT_FOLDER}` : `All ${unchanged} BPP file(s) are already current`
  };
}

const openWorkspaceDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open("opencnc-folder-workspace", 1);
  request.addEventListener("upgradeneeded", () => { if (!request.result.objectStoreNames.contains("settings")) request.result.createObjectStore("settings"); });
  request.addEventListener("success", () => resolve(request.result));
  request.addEventListener("error", () => reject(request.error ?? new Error("Could not open folder workspace storage")));
});

export async function saveWorkspace(value: SavedWorkspace): Promise<void> {
  const database = await openWorkspaceDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("settings", "readwrite");
    transaction.objectStore("settings").put(value, "active");
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Could not save folder workspace")));
  });
  database.close();
}

export async function loadSavedWorkspace(): Promise<SavedWorkspace | undefined> {
  const database = await openWorkspaceDatabase();
  const result = await new Promise<SavedWorkspace | undefined>((resolve, reject) => {
    const request = database.transaction("settings", "readonly").objectStore("settings").get("active");
    request.addEventListener("success", () => resolve(request.result as SavedWorkspace | undefined));
    request.addEventListener("error", () => reject(request.error ?? new Error("Could not load folder workspace")));
  });
  database.close();
  return result;
}
