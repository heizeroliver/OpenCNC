import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { bulkConvertAndVerify, type BulkConversionReport } from "../../converter/src/index.js";
import { validateDocument } from "../../core/src/index.js";
import { parseCix } from "../../parser-cix/src/index.js";
import type { MachineProfile } from "../../profiles/src/index.js";
import { generateQaJobSheet } from "../../qa/src/index.js";
import {
  createWorkspaceManifest,
  parseWorkspaceManifest,
  planWorkspaceWrite,
  quickWorkspaceFingerprint,
  sha256Hex,
  type WorkspaceManifestEntry,
  type WorkspaceWriteDecision
} from "../../workspace/src/index.js";

export interface NodeWorkspaceConversionOptions {
  outputFolder?: string;
  includeQa?: boolean;
  machineProfile?: MachineProfile;
}

export interface NodeWorkspaceOptions extends NodeWorkspaceConversionOptions {
  rootDirectory: string;
  projectFilter?: string;
}

export interface NodeWorkspaceProject {
  name: string;
  directory: string;
  files: Array<{ name: string; path: string; size: number; lastModified: number }>;
  fingerprint: string;
}

export interface NodeWorkspaceProjectResult {
  projectName: string;
  status: "converted" | "unchanged" | "blocked" | "conflict";
  sourceCount: number;
  written: number;
  updated: number;
  unchanged: number;
  conflicts: string[];
  orphanedOutputs: string[];
  outputDirectory: string;
  report?: BulkConversionReport;
  sourceNames?: string[];
  outputNames?: string[];
  inputChecksums?: Record<string, string>;
  outputChecksums?: Record<string, string>;
  verified?: boolean;
  reverseVerified?: boolean;
  message: string;
}

export interface NodeWorkspaceOutputStatus {
  outputDirectory: string;
  bppCount: number;
  managed: boolean;
  outputChecksums: Record<string, string>;
}

export interface NodeWorkspaceResult {
  rootDirectory: string;
  projects: NodeWorkspaceProjectResult[];
  summary: { total: number; converted: number; unchanged: number; blocked: number; conflicts: number };
}

export const NODE_WORKSPACE_MANIFEST_FILE = "opencnc-sync-manifest.json";
export const NODE_WORKSPACE_REPORT_FILE = "opencnc-conversion-report.json";
export const NODE_WORKSPACE_LOCK_DIRECTORY = ".opencnc-conversion.lock";
const NODE_WORKSPACE_LOCK_STALE_MS = 10 * 60_000;
const NODE_WORKSPACE_LOCK_UPDATE_MS = 30_000;

const exists = async (path: string): Promise<boolean> => {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

const readOptional = async (path: string): Promise<string | undefined> => {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};

export const validateOutputFolderName = (value: string): string => {
  const name = value.trim();
  const reservedDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name);
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[.]$/.test(name) || reservedDevice) throw new Error("The output folder must be one Windows-safe plain folder name");
  return name;
};

export const resolveOutputFolderPattern = (pattern: string, projectName: string): string => {
  const trimmed = pattern.trim();
  const resolved = trimmed.replaceAll("{projectName}", projectName);
  if (/[{}]/.test(resolved)) throw new Error("The output folder pattern contains an unsupported placeholder");
  return validateOutputFolderName(resolved);
};

export async function inspectNodeWorkspaceOutput(
  projectDirectory: string,
  projectName: string,
  outputFolderPattern: string
): Promise<NodeWorkspaceOutputStatus> {
  const outputDirectory = join(projectDirectory, resolveOutputFolderPattern(outputFolderPattern, projectName));
  try {
    const entries = await readdir(outputDirectory, { withFileTypes: true });
    const bppEntries = entries.filter(entry => entry.isFile() && /\.bpp$/i.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name));
    const outputChecksums = Object.fromEntries(await Promise.all(bppEntries.map(async entry => [entry.name, await sha256Hex(await readFile(join(outputDirectory, entry.name)))] as const)));
    return {
      outputDirectory,
      bppCount: bppEntries.length,
      managed: entries.some(entry => entry.isFile() && entry.name === NODE_WORKSPACE_MANIFEST_FILE),
      outputChecksums
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { outputDirectory, bppCount: 0, managed: false, outputChecksums: {} };
    throw error;
  }
}

export interface CaseInsensitiveCollision {
  normalizedName: string;
  names: string[];
}

export const caseInsensitiveNameCollisions = (names: string[]): CaseInsensitiveCollision[] => {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const key = name.normalize("NFC").toLocaleLowerCase();
    const values = groups.get(key) ?? [];
    values.push(name);
    groups.set(key, values);
  }
  return [...groups.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([normalizedName, values]) => ({ normalizedName, names: values.sort((left, right) => left.localeCompare(right)) }))
    .sort((left, right) => left.normalizedName.localeCompare(right.normalizedName));
};

export interface StableSourceReadDependencies {
  read(path: string): Promise<string>;
  inspect(path: string): Promise<{ size: number; mtimeMs: number }>;
}

export async function readStableWorkspaceSource(
  file: NodeWorkspaceProject["files"][number],
  dependencies: StableSourceReadDependencies = { read: path => readFile(path, "utf8"), inspect: path => stat(path) }
): Promise<string> {
  const sourceText = await dependencies.read(file.path);
  const after = await dependencies.inspect(file.path);
  if (after.size !== file.size || after.mtimeMs !== file.lastModified) {
    throw Object.assign(new Error(`${file.name} changed while OpenCNC was reading it; waiting for a stable export`), { code: "WORKSPACE_SOURCE_CHANGED" });
  }
  return sourceText;
}

const sourceFiles = async (directory: string): Promise<NodeWorkspaceProject["files"]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter(entry => entry.isFile() && /\.cix$/i.test(entry.name)).map(async entry => {
    const path = join(directory, entry.name);
    const file = await stat(path);
    return { name: entry.name, path, size: file.size, lastModified: file.mtimeMs };
  }));
  return files.sort((left, right) => left.name.localeCompare(right.name));
};

const workspaceSourceChangedError = (projectName: string, detail: string): Error & { code: string } => Object.assign(
  new Error(`${projectName} changed during guarded conversion (${detail}); waiting for a stable export`),
  { code: "WORKSPACE_SOURCE_CHANGED" }
);

export async function assertWorkspaceSourcesUnchanged(project: NodeWorkspaceProject, expectedChecksums: Record<string, string>): Promise<void> {
  const currentFiles = await sourceFiles(project.directory);
  const expectedNames = project.files.map(file => file.name.normalize("NFC")).sort((left, right) => left.localeCompare(right));
  const currentNames = currentFiles.map(file => file.name.normalize("NFC")).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(currentNames) !== JSON.stringify(expectedNames)) throw workspaceSourceChangedError(project.name, "the top-level CIX file set changed");
  for (const file of currentFiles) {
    const expectedFile = project.files.find(candidate => candidate.name === file.name);
    if (!expectedFile || file.size !== expectedFile.size || file.lastModified !== expectedFile.lastModified) throw workspaceSourceChangedError(project.name, `${file.name} metadata changed`);
    const sourceText = await readStableWorkspaceSource(file);
    if (await sha256Hex(sourceText) !== expectedChecksums[file.name]) throw workspaceSourceChangedError(project.name, `${file.name} contents changed`);
  }
}

export async function discoverNodeWorkspaceProjects(rootDirectory: string, projectFilter?: string): Promise<NodeWorkspaceProject[]> {
  const root = resolve(rootDirectory);
  const candidates: Array<{ name: string; directory: string }> = [{ name: basename(root), directory: root }];
  const rootFiles = await sourceFiles(root);
  for (const directory of await listNodeWorkspaceProjectDirectories(root)) candidates.push({ name: basename(directory), directory });
  const projects: NodeWorkspaceProject[] = [];
  for (const candidate of candidates) {
    if (projectFilter && candidate.name.toLocaleLowerCase() !== projectFilter.toLocaleLowerCase()) continue;
    const files = candidate.directory === root ? rootFiles : await sourceFiles(candidate.directory);
    if (!files.length) continue;
    projects.push({ ...candidate, files, fingerprint: quickWorkspaceFingerprint(files) });
  }
  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

/** Recursively lists project directories without following links or modifying their contents. */
export async function listNodeWorkspaceProjectDirectories(rootDirectory: string): Promise<string[]> {
  const root = resolve(rootDirectory);
  const directories: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    if (directory !== root && entries.some(entry => entry.isFile() && entry.name === NODE_WORKSPACE_MANIFEST_FILE)) return;
    if (directory !== root) directories.push(directory);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === NODE_WORKSPACE_LOCK_DIRECTORY) continue;
      await visit(join(directory, entry.name));
    }
  };
  await visit(root);
  return directories.sort((left, right) => left.localeCompare(right));
}

const removeIfPresent = async (path: string): Promise<void> => {
  try { await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
};

const writeDurableTemporary = async (path: string, contents: string | Uint8Array): Promise<void> => {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export interface AtomicWorkspaceBatchItem {
  path: string;
  contents?: string | Uint8Array;
}

export const atomicWorkspaceBatchWrite = async (
  items: AtomicWorkspaceBatchItem[],
  beforeCommit: (item: AtomicWorkspaceBatchItem, index: number) => void | Promise<void> = () => undefined
): Promise<void> => {
  const batchId = `${process.pid}-${randomUUID()}`;
  const staged = items.map((item, index) => ({
    ...item,
    temporary: join(dirname(item.path), `.opencnc-${basename(item.path)}-${batchId}-${index}.tmp`),
    backup: join(dirname(item.path), `.opencnc-${basename(item.path)}-${batchId}-${index}.backup.tmp`),
    hadExisting: false,
    committed: false
  }));
  try {
    for (const item of staged) if (item.contents !== undefined) await writeDurableTemporary(item.temporary, item.contents);
    for (let index = 0; index < staged.length; index += 1) {
      const item = staged[index]!;
      await beforeCommit(item, index);
      if (item.contents === undefined) continue;
      if (await exists(item.path)) {
        await rename(item.path, item.backup);
        item.hadExisting = true;
      }
      try {
        await rename(item.temporary, item.path);
        item.committed = true;
      } catch (error) {
        if (item.hadExisting) await rename(item.backup, item.path);
        item.hadExisting = false;
        throw error;
      }
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const item of [...staged].reverse()) {
      try {
        if (item.committed) await removeIfPresent(item.path);
        if (item.hadExisting) await rename(item.backup, item.path);
        await removeIfPresent(item.temporary);
        await removeIfPresent(item.backup);
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "BPP batch failed and could not be rolled back completely");
    throw error;
  }
  for (const item of staged) {
    await removeIfPresent(item.temporary);
    await removeIfPresent(item.backup);
  }
};

export const atomicWorkspaceWrite = async (path: string, contents: string | Uint8Array): Promise<void> => {
  await atomicWorkspaceBatchWrite([{ path, contents }]);
};

const bppFiles = async (directory: string): Promise<string[]> => {
  try { return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /\.bpp$/i.test(entry.name)).map(entry => entry.name).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
};

async function convertLockedNodeWorkspaceProject(
  project: NodeWorkspaceProject,
  options: NodeWorkspaceConversionOptions,
  assertLock: () => void
): Promise<NodeWorkspaceProjectResult> {
  assertLock();
  const outputFolder = validateOutputFolderName(options.outputFolder ?? "BPP");
  const outputDirectory = join(project.directory, outputFolder);
  const sourceCollisions = caseInsensitiveNameCollisions(project.files.map(file => file.name));
  if (sourceCollisions.length) return {
    projectName: project.name, status: "conflict", sourceCount: project.files.length, written: 0, updated: 0, unchanged: 0,
    conflicts: sourceCollisions.flatMap(collision => collision.names), orphanedOutputs: [], outputDirectory,
    sourceNames: project.files.map(file => file.name), outputNames: [], inputChecksums: {}, outputChecksums: {}, verified: false, reverseVerified: false,
    message: `Windows case-insensitive source collision: ${sourceCollisions.map(collision => collision.names.join(" / ")).join("; ")}`
  };
  const sources = await Promise.all(project.files.map(async file => ({ ...file, sourceText: await readStableWorkspaceSource(file) })));
  const inputChecksums = Object.fromEntries(await Promise.all(sources.map(async source => [source.name, await sha256Hex(source.sourceText)] as const)));
  const inputs = sources.map(source => {
    const document = parseCix(source.sourceText, source.name);
    document.diagnostics.push(...validateDocument(document));
    return { name: source.name, document };
  });
  const conversion = bulkConvertAndVerify(inputs, options.machineProfile ? { machineProfile: options.machineProfile } : {});
  const blocked = conversion.outputs.filter(item => item.status !== "converted" || item.contents === undefined || !item.verified || !item.reverseVerified || !item.supportedSemanticRoundTrip || !item.expandedGeometryRoundTrip);
  if (blocked.length) return {
    projectName: project.name, status: "blocked", sourceCount: sources.length, written: 0, updated: 0, unchanged: 0, conflicts: [], orphanedOutputs: [], outputDirectory,
    report: conversion.report, sourceNames: sources.map(source => source.name), outputNames: conversion.outputs.map(item => item.outputName), inputChecksums, outputChecksums: {}, verified: false, reverseVerified: false,
    message: `${blocked.length}/${conversion.outputs.length} conversion job(s) failed guarded conversion; nothing was written`
  };
  const outputCollisions = caseInsensitiveNameCollisions(conversion.outputs.map(item => item.outputName));
  if (outputCollisions.length) return {
    projectName: project.name, status: "conflict", sourceCount: sources.length, written: 0, updated: 0, unchanged: 0,
    conflicts: outputCollisions.flatMap(collision => collision.names), orphanedOutputs: [], outputDirectory, report: conversion.report,
    sourceNames: sources.map(source => source.name), outputNames: conversion.outputs.map(item => item.outputName), inputChecksums, outputChecksums: {}, verified: false, reverseVerified: false,
    message: `Windows case-insensitive BPP output collision: ${outputCollisions.map(collision => collision.names.join(" / ")).join("; ")}`
  };

  const previousManifest = parseWorkspaceManifest(await readOptional(join(outputDirectory, NODE_WORKSPACE_MANIFEST_FILE)));
  const previousBySource = new Map(previousManifest?.entries.map(entry => [entry.name.toLocaleLowerCase(), entry]) ?? []);
  const sourceByName = new Map(sources.map(source => [source.name.toLocaleLowerCase(), source]));
  const plans: Array<{ sources: (typeof sources); item: (typeof conversion.outputs)[number]; targetChecksum: string; existingChecksum?: string; decision: WorkspaceWriteDecision }> = [];
  const conflicts: string[] = [];
  for (const item of conversion.outputs) {
    const itemSources = item.sourceNames.map(name => sourceByName.get(name.toLocaleLowerCase())).filter((source): source is (typeof sources)[number] => Boolean(source));
    if (itemSources.length !== item.sourceNames.length) throw new Error(`Missing workspace source data for ${item.sourceNames.join(", ")}`);
    const outputPath = join(outputDirectory, item.outputName);
    const existingChecksum = await exists(outputPath) ? await sha256Hex(new Uint8Array(await readFile(outputPath))) : undefined;
    const previousEntries = itemSources.map(source => previousBySource.get(source.name.toLocaleLowerCase())).filter((entry): entry is WorkspaceManifestEntry => Boolean(entry));
    const previousEntry = previousEntries.find(entry => entry.outputName === item.outputName && entry.targetChecksum === existingChecksum) ?? previousEntries[0];
    const targetChecksum = await sha256Hex(item.contents!);
    const decision = planWorkspaceWrite({ outputName: item.outputName, targetChecksum, ...(existingChecksum ? { existingChecksum } : {}), ...(previousEntry ? { previousEntry } : {}) });
    if (decision === "conflict") conflicts.push(item.outputName);
    plans.push({ sources: itemSources, item, targetChecksum, ...(existingChecksum ? { existingChecksum } : {}), decision });
  }
  if (conflicts.length) return {
    projectName: project.name, status: "conflict", sourceCount: sources.length, written: 0, updated: 0, unchanged: plans.filter(plan => plan.decision === "unchanged").length,
    conflicts, orphanedOutputs: [], outputDirectory, report: conversion.report, sourceNames: sources.map(source => source.name), outputNames: plans.map(plan => plan.item.outputName), inputChecksums, outputChecksums: {}, verified: false, reverseVerified: false,
    message: `${conflicts.length} BPP output(s) were edited or not created by OpenCNC; nothing was written`
  };

  await mkdir(outputDirectory, { recursive: true });
  const now = new Date().toISOString();
  const manifestEntries: WorkspaceManifestEntry[] = [];
  for (const plan of plans) {
    for (const source of plan.sources) manifestEntries.push({
      name: source.name, size: source.size, lastModified: source.lastModified, sourceChecksum: inputChecksums[source.name]!, outputName: plan.item.outputName,
      targetChecksum: plan.targetChecksum, convertedAt: now, verified: true, reverseVerified: true, semanticRoundTrip: true, geometryRoundTrip: true
    });
  }
  const outputChanged = (name: string): Error & { code: string } => Object.assign(
    new Error(`${name} changed after OpenCNC planned the guarded write; the entire BPP batch was rolled back`),
    { code: "WORKSPACE_OUTPUT_CHANGED" }
  );
  try {
    await atomicWorkspaceBatchWrite(plans.map(plan => ({
      path: join(outputDirectory, plan.item.outputName),
      ...(plan.decision === "unchanged" ? {} : { contents: plan.item.contents! })
    })), async (_item, index) => {
      assertLock();
      await assertWorkspaceSourcesUnchanged(project, inputChecksums);
      const plan = plans[index]!;
      const currentChecksum = await exists(join(outputDirectory, plan.item.outputName))
        ? await sha256Hex(new Uint8Array(await readFile(join(outputDirectory, plan.item.outputName))))
        : undefined;
      if (currentChecksum !== plan.existingChecksum) throw outputChanged(plan.item.outputName);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "WORKSPACE_OUTPUT_CHANGED") throw error;
    return {
      projectName: project.name, status: "conflict", sourceCount: sources.length, written: 0, updated: 0, unchanged: 0,
      conflicts: plans.map(plan => plan.item.outputName), orphanedOutputs: [], outputDirectory, report: conversion.report,
      sourceNames: sources.map(source => source.name), outputNames: plans.map(plan => plan.item.outputName), inputChecksums, outputChecksums: {}, verified: false, reverseVerified: false,
      message: (error as Error).message
    };
  }
  const qaArtifacts = options.includeQa ? await (async () => {
    const qaDirectory = join(outputDirectory, "QA");
    await mkdir(qaDirectory, { recursive: true });
    return Promise.all(conversion.outputs.map(async item => {
      const itemSources = item.sourceNames.map(name => sourceByName.get(name.toLocaleLowerCase()))!;
      const qa = await generateQaJobSheet({ item, sourceDocument: item.sourceDocument, sourceText: itemSources.map(source => source!.sourceText).join("\r\n; OPENCNC TWO-SIDED SOURCE BOUNDARY\r\n") });
      assertLock();
      await assertWorkspaceSourcesUnchanged(project, inputChecksums);
      await atomicWorkspaceWrite(join(qaDirectory, qa.filename), qa.bytes);
      return { sourceNames: item.sourceNames, outputName: item.outputName, pdfName: `QA/${qa.filename}`, reportId: qa.reportId, fidelityGrade: qa.fidelityGrade, sourceChecksum: qa.sourceChecksum, targetChecksum: qa.targetChecksum };
    }));
  })() : [];
  const currentOutputs = new Set(manifestEntries.map(entry => entry.outputName.toLocaleLowerCase()));
  const orphanedOutputs = (await bppFiles(outputDirectory)).filter(name => !currentOutputs.has(name.toLocaleLowerCase()));
  const report = {
    ...conversion.report,
    generatedAt: now,
    workspace: { projectName: project.name, sourceDirectory: project.directory, outputDirectory, orphanedOutputs, safety: "existing outputs are overwritten only when their checksum matches the previous OpenCNC manifest" },
    qaArtifacts
  };
  assertLock();
  await assertWorkspaceSourcesUnchanged(project, inputChecksums);
  await atomicWorkspaceWrite(join(outputDirectory, NODE_WORKSPACE_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
  assertLock();
  await assertWorkspaceSourcesUnchanged(project, inputChecksums);
  await atomicWorkspaceWrite(join(outputDirectory, NODE_WORKSPACE_MANIFEST_FILE), `${JSON.stringify(createWorkspaceManifest(project.name, manifestEntries, now), null, 2)}\n`);
  const written = plans.filter(plan => plan.decision === "create").length;
  const updated = plans.filter(plan => plan.decision === "update").length;
  const unchanged = plans.filter(plan => plan.decision === "unchanged").length;
  return {
    projectName: project.name, status: written || updated ? "converted" : "unchanged", sourceCount: sources.length, written, updated, unchanged, conflicts: [], orphanedOutputs, outputDirectory, report,
    sourceNames: sources.map(source => source.name), outputNames: plans.map(plan => plan.item.outputName), inputChecksums,
    outputChecksums: Object.fromEntries(plans.map(plan => [plan.item.outputName, plan.targetChecksum])), verified: true, reverseVerified: true,
    message: written || updated ? `${written} new, ${updated} updated, ${unchanged} unchanged` : `${unchanged} output(s) already current`
  };
}

export async function convertNodeWorkspaceProject(project: NodeWorkspaceProject, options: NodeWorkspaceConversionOptions = {}): Promise<NodeWorkspaceProjectResult> {
  const lockfilePath = join(project.directory, NODE_WORKSPACE_LOCK_DIRECTORY);
  let compromised: Error | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(project.directory, {
      realpath: false,
      lockfilePath,
      stale: NODE_WORKSPACE_LOCK_STALE_MS,
      update: NODE_WORKSPACE_LOCK_UPDATE_MS,
      retries: 0,
      onCompromised: error => { compromised = error; }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw Object.assign(new Error(`${project.name} is already being converted by another OpenCNC process`), { code: "WORKSPACE_PROJECT_BUSY", cause: error });
    }
    throw error;
  }
  const assertLock = (): void => {
    if (compromised) throw Object.assign(new Error(`${project.name} conversion lock was lost; production writes were stopped`), { code: "WORKSPACE_PROJECT_LOCK_COMPROMISED", cause: compromised });
  };
  try {
    return await convertLockedNodeWorkspaceProject(project, options, assertLock);
  } finally {
    await release();
  }
}

export async function runNodeWorkspaceOnce(options: NodeWorkspaceOptions): Promise<NodeWorkspaceResult> {
  const projects = await discoverNodeWorkspaceProjects(options.rootDirectory, options.projectFilter);
  const results: NodeWorkspaceProjectResult[] = [];
  for (const project of projects) results.push(await convertNodeWorkspaceProject(project, options));
  return {
    rootDirectory: resolve(options.rootDirectory),
    projects: results,
    summary: {
      total: results.length,
      converted: results.filter(result => result.status === "converted").length,
      unchanged: results.filter(result => result.status === "unchanged").length,
      blocked: results.filter(result => result.status === "blocked").length,
      conflicts: results.filter(result => result.status === "conflict").length
    }
  };
}
