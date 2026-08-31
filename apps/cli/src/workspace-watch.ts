import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { bulkConvertAndVerify, type BulkConversionReport } from "../../../packages/converter/src/index.js";
import { validateDocument } from "../../../packages/core/src/index.js";
import { parseCix } from "../../../packages/parser-cix/src/index.js";
import type { MachineProfile } from "../../../packages/profiles/src/index.js";
import { generateQaJobSheet } from "../../../packages/qa/src/index.js";
import {
  createWorkspaceManifest,
  parseWorkspaceManifest,
  planWorkspaceWrite,
  quickWorkspaceFingerprint,
  sha256Hex,
  type WorkspaceManifestEntry,
  type WorkspaceWriteDecision
} from "../../../packages/workspace/src/index.js";

export interface WatchWorkspaceOptions {
  rootDirectory: string;
  outputFolder?: string;
  includeQa?: boolean;
  machineProfile?: MachineProfile;
  projectFilter?: string;
}

export interface WatchProject {
  name: string;
  directory: string;
  files: Array<{ name: string; path: string; size: number; lastModified: number }>;
  fingerprint: string;
}

export interface WatchProjectResult {
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
  message: string;
}

export interface WatchWorkspaceResult {
  rootDirectory: string;
  projects: WatchProjectResult[];
  summary: { total: number; converted: number; unchanged: number; blocked: number; conflicts: number };
}

const MANIFEST_FILE = "opencnc-sync-manifest.json";
const REPORT_FILE = "opencnc-conversion-report.json";

const exists = async (path: string): Promise<boolean> => {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

const readOptional = async (path: string): Promise<string | undefined> => {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};

const validateOutputFolderName = (value: string): string => {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/:\u0000]/.test(name)) throw new Error("The output folder must be one plain folder name");
  return name;
};

const sourceFiles = async (directory: string): Promise<WatchProject["files"]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter(entry => entry.isFile() && /\.cix$/i.test(entry.name)).map(async entry => {
    const path = join(directory, entry.name);
    const file = await import("node:fs/promises").then(module => module.stat(path));
    return { name: entry.name, path, size: file.size, lastModified: file.mtimeMs };
  }));
  return files.sort((left, right) => left.name.localeCompare(right.name));
};

export async function discoverWatchProjects(rootDirectory: string, projectFilter?: string): Promise<WatchProject[]> {
  const root = resolve(rootDirectory);
  const candidates: Array<{ name: string; directory: string }> = [];
  const rootFiles = await sourceFiles(root);
  if (rootFiles.length) candidates.push({ name: basename(root), directory: root });
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.toLocaleLowerCase() === "bpp") continue;
    candidates.push({ name: entry.name, directory: join(root, entry.name) });
  }
  const projects: WatchProject[] = [];
  for (const candidate of candidates) {
    if (projectFilter && candidate.name.toLocaleLowerCase() !== projectFilter.toLocaleLowerCase()) continue;
    const files = candidate.directory === root && rootFiles.length ? rootFiles : await sourceFiles(candidate.directory);
    if (!files.length) continue;
    projects.push({ ...candidate, files, fingerprint: quickWorkspaceFingerprint(files) });
  }
  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

const atomicWrite = async (path: string, contents: string | Uint8Array): Promise<void> => {
  const temporary = join(dirname(path), `.opencnc-${basename(path)}-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temporary, contents);
  await rename(temporary, path);
};

const bppFiles = async (directory: string): Promise<string[]> => {
  try { return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /\.bpp$/i.test(entry.name)).map(entry => entry.name).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
};

export async function convertWatchProject(project: WatchProject, options: Omit<WatchWorkspaceOptions, "rootDirectory" | "projectFilter"> = {}): Promise<WatchProjectResult> {
  const outputFolder = validateOutputFolderName(options.outputFolder ?? "BPP");
  const outputDirectory = join(project.directory, outputFolder);
  const sources = await Promise.all(project.files.map(async file => ({ ...file, sourceText: await readFile(file.path, "utf8") })));
  const inputs = sources.map(source => {
    const document = parseCix(source.sourceText, source.name);
    document.diagnostics.push(...validateDocument(document));
    return { name: source.name, document };
  });
  const conversion = bulkConvertAndVerify(inputs, options.machineProfile ? { machineProfile: options.machineProfile } : {});
  const blocked = conversion.outputs.filter(item => item.status !== "converted" || item.contents === undefined || !item.verified || !item.reverseVerified || !item.supportedSemanticRoundTrip || !item.expandedGeometryRoundTrip);
  if (blocked.length) return {
    projectName: project.name, status: "blocked", sourceCount: sources.length, written: 0, updated: 0, unchanged: 0, conflicts: [], orphanedOutputs: [], outputDirectory,
    report: conversion.report, message: `${blocked.length}/${conversion.outputs.length} conversion job(s) failed guarded conversion; nothing was written`
  };

  const previousManifest = parseWorkspaceManifest(await readOptional(join(outputDirectory, MANIFEST_FILE)));
  const previousBySource = new Map(previousManifest?.entries.map(entry => [entry.name.toLocaleLowerCase(), entry]) ?? []);
  const sourceByName = new Map(sources.map(source => [source.name.toLocaleLowerCase(), source]));
  const plans: Array<{ sources: (typeof sources); item: (typeof conversion.outputs)[number]; targetChecksum: string; decision: WorkspaceWriteDecision }> = [];
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
    plans.push({ sources: itemSources, item, targetChecksum, decision });
  }
  if (conflicts.length) return {
    projectName: project.name, status: "conflict", sourceCount: sources.length, written: 0, updated: 0, unchanged: plans.filter(plan => plan.decision === "unchanged").length,
    conflicts, orphanedOutputs: [], outputDirectory, report: conversion.report, message: `${conflicts.length} BPP output(s) were edited or not created by OpenCNC; nothing was written`
  };

  await mkdir(outputDirectory, { recursive: true });
  const now = new Date().toISOString();
  const manifestEntries: WorkspaceManifestEntry[] = [];
  for (const plan of plans) {
    if (plan.decision !== "unchanged") await atomicWrite(join(outputDirectory, plan.item.outputName), plan.item.contents!);
    for (const source of plan.sources) manifestEntries.push({
      name: source.name, size: source.size, lastModified: source.lastModified, sourceChecksum: await sha256Hex(source.sourceText), outputName: plan.item.outputName,
      targetChecksum: plan.targetChecksum, convertedAt: now, verified: true, reverseVerified: true, semanticRoundTrip: true, geometryRoundTrip: true
    });
  }
  const qaArtifacts = options.includeQa ? await (async () => {
    const qaDirectory = join(outputDirectory, "QA");
    await mkdir(qaDirectory, { recursive: true });
    return Promise.all(conversion.outputs.map(async item => {
      const itemSources = item.sourceNames.map(name => sourceByName.get(name.toLocaleLowerCase()))!;
      const qa = await generateQaJobSheet({ item, sourceDocument: item.sourceDocument, sourceText: itemSources.map(source => source!.sourceText).join("\r\n; OPENCNC TWO-SIDED SOURCE BOUNDARY\r\n") });
      await atomicWrite(join(qaDirectory, qa.filename), qa.bytes);
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
  await atomicWrite(join(outputDirectory, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
  await atomicWrite(join(outputDirectory, MANIFEST_FILE), `${JSON.stringify(createWorkspaceManifest(project.name, manifestEntries, now), null, 2)}\n`);
  const written = plans.filter(plan => plan.decision === "create").length;
  const updated = plans.filter(plan => plan.decision === "update").length;
  const unchanged = plans.filter(plan => plan.decision === "unchanged").length;
  return {
    projectName: project.name, status: written || updated ? "converted" : "unchanged", sourceCount: sources.length, written, updated, unchanged, conflicts: [], orphanedOutputs, outputDirectory, report,
    message: written || updated ? `${written} new, ${updated} updated, ${unchanged} unchanged` : `${unchanged} output(s) already current`
  };
}

export async function runWorkspaceOnce(options: WatchWorkspaceOptions): Promise<WatchWorkspaceResult> {
  const projects = await discoverWatchProjects(options.rootDirectory, options.projectFilter);
  const results: WatchProjectResult[] = [];
  for (const project of projects) results.push(await convertWatchProject(project, options));
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

export async function watchWorkspace(options: WatchWorkspaceOptions & { intervalSeconds: number; onEvent: (message: string, tone: "info" | "success" | "warning" | "error") => void }): Promise<never> {
  const observed = new Map<string, string>();
  const attempted = new Map<string, string>();
  options.onEvent(`Watching ${resolve(options.rootDirectory)} every ${options.intervalSeconds}s; waiting for exports to settle`, "info");
  for (;;) {
    try {
      const projects = await discoverWatchProjects(options.rootDirectory, options.projectFilter);
      for (const project of projects) {
        const previous = observed.get(project.directory);
        observed.set(project.directory, project.fingerprint);
        if (previous !== project.fingerprint || attempted.get(project.directory) === project.fingerprint) continue;
        attempted.set(project.directory, project.fingerprint);
        const result = await convertWatchProject(project, options);
        options.onEvent(`${project.name}: ${result.message}`, result.status === "converted" || result.status === "unchanged" ? "success" : result.status === "conflict" ? "warning" : "error");
      }
    } catch (error) {
      options.onEvent(error instanceof Error ? error.message : String(error), "error");
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, options.intervalSeconds * 1000));
  }
}
