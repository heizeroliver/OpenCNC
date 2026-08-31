#!/usr/bin/env node
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { operationPoints, validateDocument, type OpenCncDocument } from "../../../packages/core/src/index.js";
import { bulkConvertAndVerify } from "../../../packages/converter/src/index.js";
import { publicCorpusReport, runCorpusLab } from "../../../packages/corpus/src/index.js";
import { parseBpp } from "../../../packages/parser-bpp/src/index.js";
import { parseCix } from "../../../packages/parser-cix/src/index.js";
import { renderSvg } from "../../../packages/svg/src/index.js";
import { checkDocumentAgainstMachine, detectDialect, validateMachineProfile, type MachineProfile } from "../../../packages/profiles/src/index.js";
import { generateQaJobSheet } from "../../../packages/qa/src/index.js";
import { runWorkspaceOnce, watchWorkspace } from "./workspace-watch.js";

const [command, inputPath, ...args] = process.argv.slice(2);
const commands = ["bulk-convert", "convert", "corpus-lab", "inspect", "summary", "svg", "validate", "watch"];

const usage = (): never => {
  console.error("Usage:\n  opencnc <convert|inspect|summary|validate|svg> <file.bpp|file.cix> [--to bpp|cix] [--out output] [--qa-pdf job-sheet.pdf] [--machine-profile profile.json]\n  opencnc bulk-convert <input-directory> --out-dir <new-output-directory> [--machine-profile profile.json]\n  opencnc corpus-lab <input-directory> --out corpus-report.json [--export-dir anonymized-corpus]\n  opencnc watch <parent-directory> [--interval 10] [--project folder-name] [--output-folder BPP] [--qa] [--once]");
  process.exit(1);
};

if (!command || !inputPath || !commands.includes(command)) usage();
const selectedCommand = command!;
const selectedInputPath = inputPath!;

const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name: string): boolean => args.includes(name);

const readParsedFile = async (file: string): Promise<{ sourceText: string; document: OpenCncDocument }> => {
  const extension = extname(file).toLowerCase();
  if (extension !== ".bpp" && extension !== ".cix") throw new Error("Only .bpp and .cix inputs are accepted");
  const sourceText = await readFile(file, "utf8");
  const document = extension === ".bpp" ? parseBpp(sourceText, basename(file)) : parseCix(sourceText, basename(file));
  document.diagnostics.push(...validateDocument(document));
  return { sourceText, document };
};

const parseFile = async (file: string): Promise<OpenCncDocument> => (await readParsedFile(file)).document;

const readMachineProfile = async (): Promise<MachineProfile | undefined> => {
  const path = option("--machine-profile");
  if (!path) return undefined;
  const profile = JSON.parse(await readFile(path, "utf8")) as MachineProfile;
  const issues = validateMachineProfile(profile);
  if (issues.length) throw new Error(`Invalid machine profile: ${issues.join("; ")}`);
  return profile;
};

const ensureAbsent = async (file: string): Promise<void> => {
  try {
    await access(file);
    throw new Error(`Refusing to overwrite existing output: ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const bulkConvert = async (): Promise<void> => {
  const outputDirectory = option("--out-dir");
  if (!outputDirectory) throw new Error("bulk-convert requires --out-dir <new-output-directory>");
  const sourceDirectory = resolve(selectedInputPath);
  const targetDirectory = resolve(outputDirectory);
  if (sourceDirectory === targetDirectory) throw new Error("The bulk output directory must differ from the input directory");
  const entries = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(bpp|cix)$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!entries.length) throw new Error("No .bpp or .cix files were found in the input directory");

  const inputs: Array<{ name: string; document: OpenCncDocument }> = [];
  const sourceTextByName = new Map<string, string>();
  for (const entry of entries) {
    const parsed = await readParsedFile(join(sourceDirectory, entry.name));
    inputs.push({ name: entry.name, document: parsed.document });
    sourceTextByName.set(entry.name, parsed.sourceText);
  }
  const machineProfile = await readMachineProfile();
  const result = bulkConvertAndVerify(inputs, machineProfile ? { machineProfile } : {});
  const successful = result.outputs.filter(item => item.status === "converted" && item.contents !== undefined);
  const reportPath = join(targetDirectory, "opencnc-conversion-report.json");
  const qaDirectory = join(targetDirectory, "qa");
  const qaArtifacts = await Promise.all(successful.map(async item => {
    const sourceTexts = item.sourceNames.map(name => sourceTextByName.get(name));
    if (sourceTexts.some(sourceText => sourceText === undefined)) throw new Error(`Missing source data for ${item.sourceNames.join(", ")}`);
    return generateQaJobSheet({ item, sourceDocument: item.sourceDocument, sourceText: sourceTexts.join("\r\n; OPENCNC TWO-SIDED SOURCE BOUNDARY\r\n") });
  }));
  const report = {
    ...result.report,
    generatedAt: new Date().toISOString(),
    qaArtifacts: qaArtifacts.map((qa, index) => ({ sourceNames: successful[index]!.sourceNames, outputName: successful[index]!.outputName, pdfName: `qa/${qa.filename}`, reportId: qa.reportId, fidelityGrade: qa.fidelityGrade, sourceChecksum: qa.sourceChecksum, targetChecksum: qa.targetChecksum }))
  };

  await mkdir(targetDirectory, { recursive: true });
  await mkdir(qaDirectory, { recursive: true });
  await Promise.all([...successful.map(item => ensureAbsent(join(targetDirectory, item.outputName))), ...qaArtifacts.map(qa => ensureAbsent(join(qaDirectory, qa.filename))), ensureAbsent(reportPath)]);
  for (const item of successful) await writeFile(join(targetDirectory, item.outputName), item.contents!, { encoding: "utf8", flag: "wx" });
  for (const qa of qaArtifacts) await writeFile(join(qaDirectory, qa.filename), qa.bytes, { flag: "wx" });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  const summary = result.report.summary;
  console.log(`Converted ${summary.converted}/${summary.total} files to ${targetDirectory}`);
  console.log(`Reverse verification: ${summary.reverseVerified}/${summary.total}; supported semantics: ${summary.supportedSemanticRoundTrips}/${summary.total}; expanded geometry: ${summary.expandedGeometryRoundTrips}/${summary.total}`);
  if (summary.preservedInertOperations) console.warn(`${summary.preservedInertOperations} operation(s) were preserved only as non-executing metadata.`);
  if (summary.machineWarnings) console.warn(`${summary.machineWarnings} advisory machine-profile warning(s) were reported.`);
  console.log(`Wrote fidelity report to ${reportPath}`);
  console.log(`Wrote ${qaArtifacts.length} production QA job sheet(s) to ${qaDirectory}`);
  console.log("Source text is normalized, not byte-identical. Open and simulate every output in the vendor software before considering machine use.");
  if (summary.failed) process.exitCode = 2;
};

const corpusLab = async (): Promise<void> => {
  const output = option("--out");
  if (!output) throw new Error("corpus-lab requires --out <corpus-report.json>");
  const sourceDirectory = resolve(selectedInputPath);
  const entries = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(bpp|cix)$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!entries.length) throw new Error("No .bpp or .cix files were found in the corpus directory");
  const inputs = [];
  for (const entry of entries) {
    const parsed = await readParsedFile(join(sourceDirectory, entry.name));
    inputs.push({ name: entry.name, sourceText: parsed.sourceText, document: parsed.document });
  }
  const report = await runCorpusLab(inputs);
  const reportPath = resolve(output);
  await ensureAbsent(reportPath);
  await writeFile(reportPath, `${JSON.stringify(publicCorpusReport(report), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const exportDirectoryOption = option("--export-dir");
  if (exportDirectoryOption) {
    const exportDirectory = resolve(exportDirectoryOption);
    if (exportDirectory === sourceDirectory) throw new Error("The anonymized export directory must differ from the source corpus directory");
    const sanitizedDirectory = join(exportDirectory, "sanitized");
    const reducedDirectory = join(exportDirectory, "reduced");
    await mkdir(sanitizedDirectory, { recursive: true });
    await mkdir(reducedDirectory, { recursive: true });
    await Promise.all(report.files.flatMap(file => [
      ensureAbsent(join(sanitizedDirectory, file.anonymousName)),
      ...(file.reducedFailureFixture ? [ensureAbsent(join(reducedDirectory, `${file.anonymousName}.failure.json`))] : [])
    ]));
    for (const file of report.files) {
      await writeFile(join(sanitizedDirectory, file.anonymousName), file.sanitizedSourceText, { encoding: "utf8", flag: "wx" });
      if (file.reducedFailureFixture) await writeFile(join(reducedDirectory, `${file.anonymousName}.failure.json`), file.reducedFailureFixture, { encoding: "utf8", flag: "wx" });
    }
    console.log(`Exported ${report.files.length} anonymized fixture(s) to ${exportDirectory}`);
  }
  console.log(`Corpus ${report.runId}: parser ${report.summary.parserPassed}/${report.summary.files}, renderer ${report.summary.rendererPassed}/${report.summary.files}, conversions ${report.summary.conversionsVerified}/${report.summary.files}`);
  console.log(`Robustness ${report.summary.robustnessPassed}/${report.summary.robustnessTotal}; privacy redactions ${report.summary.privacyRedactions}; reduced failures ${report.summary.reducedFailureFixtures}`);
  console.log(`Wrote privacy-safe report to ${reportPath}`);
  if (report.summary.parserPassed !== report.summary.files || report.summary.rendererPassed !== report.summary.files || report.summary.conversionsFailed || report.summary.robustnessPassed !== report.summary.robustnessTotal || report.summary.sanitizedMachiningPreserved !== report.summary.files) process.exitCode = 2;
};

const watchCommand = async (): Promise<void> => {
  const intervalSeconds = Number(option("--interval") ?? "10");
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 2 || intervalSeconds > 3600) throw new Error("watch --interval must be between 2 and 3600 seconds");
  const machineProfile = await readMachineProfile();
  const options = {
    rootDirectory: selectedInputPath,
    ...(option("--output-folder") ? { outputFolder: option("--output-folder")! } : {}),
    ...(option("--project") ? { projectFilter: option("--project")! } : {}),
    ...(machineProfile ? { machineProfile } : {}),
    includeQa: flag("--qa")
  };
  if (flag("--once")) {
    const result = await runWorkspaceOnce(options);
    for (const project of result.projects) console.log(`${project.projectName}: ${project.status} — ${project.message} → ${project.outputDirectory}`);
    console.log(`Workspace pass: ${result.summary.converted} converted, ${result.summary.unchanged} current, ${result.summary.blocked} blocked, ${result.summary.conflicts} conflict(s)`);
    if (!result.summary.total || result.summary.blocked || result.summary.conflicts) process.exitCode = 2;
    return;
  }
  await watchWorkspace({
    ...options,
    intervalSeconds,
    onEvent(message, tone) {
      const line = `[${new Date().toLocaleTimeString()}] ${message}`;
      if (tone === "error") console.error(line);
      else if (tone === "warning") console.warn(line);
      else console.log(line);
    }
  });
};

const singleFileCommand = async (): Promise<void> => {
  const parsed = await readParsedFile(selectedInputPath);
  const document = parsed.document;
  const machineProfile = await readMachineProfile();
  const extension = extname(selectedInputPath).toLowerCase();
  if (selectedCommand === "convert") {
    const requestedTarget = option("--to")?.toLowerCase() ?? (extension === ".bpp" ? "cix" : "bpp");
    if (requestedTarget !== "bpp" && requestedTarget !== "cix") throw new Error("convert --to must be bpp or cix");
    const output = option("--out");
    if (!output) throw new Error("convert requires --out <output.bpp|output.cix>");
    const conversion = bulkConvertAndVerify([{ name: basename(selectedInputPath), document }], machineProfile ? { machineProfile } : {}).outputs[0]!;
    if (conversion.targetFormat !== requestedTarget || conversion.status !== "converted" || !conversion.verified || conversion.contents === undefined) {
      console.error(JSON.stringify(conversion.diagnostics, null, 2));
      process.exitCode = 2;
    } else {
      await writeFile(output, conversion.contents, "utf8");
      console.log(`Wrote verified ${requestedTarget === "bpp" ? "BPP v150 Windows-layout" : "CIX text-macro"} output to ${output}`);
      for (const item of conversion.diagnostics.filter(diagnostic => diagnostic.severity === "warning")) console.warn(`${item.code}: ${item.message}`);
      const qaPath = option("--qa-pdf");
      if (qaPath) {
        await ensureAbsent(qaPath);
        const qa = await generateQaJobSheet({ item: conversion, sourceDocument: document, sourceText: parsed.sourceText, outputName: basename(output) });
        await writeFile(qaPath, qa.bytes, { flag: "wx" });
        console.log(`Wrote QA job sheet ${qa.reportId} to ${qaPath}`);
      }
      console.log("Open and simulate the result in the vendor software before considering machine use.");
    }
  }
  if (selectedCommand === "inspect") console.log(JSON.stringify(document, null, 2));
  if (selectedCommand === "summary") {
    const byKind = Object.fromEntries(["drill", "route", "geometry", "pocket", "saw", "groove", "tool-change", "transform", "cut", "unknown"].map(kind => [kind, document.operations.filter(operation => operation.kind === kind).length]));
    const diagnostics = Object.fromEntries(["error", "warning", "info"].map(severity => [severity, document.diagnostics.filter(diagnostic => diagnostic.severity === severity).length]));
    console.log(JSON.stringify({ source: document.source, dialectProfile: detectDialect(document), panel: document.panel, operationCount: document.operations.length, expandedGeometryCount: document.operations.reduce((count, operation) => count + operationPoints(operation).length, 0), byKind, diagnostics, ...(machineProfile ? { machineProfile: machineProfile.name, machineChecks: checkDocumentAgainstMachine(document, machineProfile) } : {}) }, null, 2));
  }
  if (selectedCommand === "validate") {
    console.log(JSON.stringify({ diagnostics: document.diagnostics, dialectProfile: detectDialect(document), ...(machineProfile ? { machineChecks: checkDocumentAgainstMachine(document, machineProfile) } : {}) }, null, 2));
    if (document.diagnostics.some(diagnostic => diagnostic.severity === "error")) process.exitCode = 2;
  }
  if (selectedCommand === "svg") {
    const output = option("--out");
    if (!output) throw new Error("svg requires --out <preview.svg>");
    await writeFile(output, renderSvg(document), "utf8");
    console.log(`Wrote ${output}`);
  }
};

if (selectedCommand === "bulk-convert") await bulkConvert();
else if (selectedCommand === "corpus-lab") await corpusLab();
else if (selectedCommand === "watch") await watchCommand();
else await singleFileCommand();
