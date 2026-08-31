import { validateDocument, type Diagnostic, type OpenCncDocument, type Operation, type SourceFormat } from "../../core/src/index.js";
import { bulkConvertAndVerify, compareDocuments, type BulkConversionItem } from "../../converter/src/index.js";
import { parseBpp } from "../../parser-bpp/src/index.js";
import { parseCix } from "../../parser-cix/src/index.js";
import { renderSvg } from "../../svg/src/index.js";

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
};

export interface CorpusInput {
  name: string;
  sourceText: string;
  document: OpenCncDocument;
}

export interface RobustnessCheck {
  variant: "utf8-bom" | "crlf" | "trailing-whitespace";
  passed: boolean;
  diagnosticCodes: string[];
}

export interface CorpusFileResult {
  anonymousName: string;
  sourceFormat: SourceFormat;
  sourceChecksum: string;
  sanitizedChecksum: string;
  operationCount: number;
  expandedPointCount: number;
  privacyRedactionCount: number;
  sanitizedMachiningPreserved: boolean;
  parserPassed: boolean;
  rendererPassed: boolean;
  conversionStatus: "verified" | "blocked" | "failed";
  reverseVerified: boolean;
  semanticRoundTrip: boolean;
  geometryRoundTrip: boolean;
  novelSignatures: string[];
  robustness: RobustnessCheck[];
  diagnosticCodes: string[];
  sanitizedSourceText: string;
  reducedFailureFixture?: string;
}

export interface CorpusLabReport {
  schemaVersion: "0.1";
  engineVersion: "0.2.0";
  runId: string;
  generatedAt: string;
  summary: {
    files: number;
    parserPassed: number;
    rendererPassed: number;
    conversionsVerified: number;
    conversionsBlocked: number;
    conversionsFailed: number;
    reverseVerified: number;
    semanticRoundTrips: number;
    geometryRoundTrips: number;
    robustnessPassed: number;
    robustnessTotal: number;
    privacyRedactions: number;
    sanitizedMachiningPreserved: number;
    novelSignatureCount: number;
    reducedFailureFixtures: number;
  };
  files: CorpusFileResult[];
}

export interface CorpusReportComparison {
  comparableFiles: number;
  addedFiles: number;
  removedFiles: number;
  improvedFiles: number;
  regressedFiles: number;
  unchangedFiles: number;
  newNovelSignatures: string[];
  resolvedNovelSignatures: string[];
}

const parse = (format: SourceFormat, sourceText: string, name: string): OpenCncDocument => {
  const document = format === "bpp" ? parseBpp(sourceText, name) : parseCix(sourceText, name);
  document.diagnostics.push(...validateDocument(document));
  return document;
};

const errorCodes = (diagnostics: Diagnostic[]): string[] => [...new Set(diagnostics.filter(value => value.severity === "error").map(value => value.code))].sort();
const operationPointCount = (operation: Operation): number => operation.repeat ? operation.repeat.count : operation.path?.length ?? (operation.position ? 1 : 0);

const operationSignature = (operation: Operation): string => {
  const parameterKeys = operation.raw.params && !Array.isArray(operation.raw.params)
    ? Object.keys(operation.raw.params).sort().join("+")
    : `positional-${Array.isArray(operation.raw.params) ? operation.raw.params.length : 0}`;
  return [
    operation.kind,
    operation.sourceType,
    `face:${operation.face ?? "none"}`,
    `repeat:${operation.repeat ? "yes" : "no"}`,
    `segments:${operation.segments?.map(segment => segment.kind).join("+") || "none"}`,
    `params:${parameterKeys}`
  ].join("|");
};

const replacementFactory = (): ((value: string, prefix?: string) => string) => {
  const replacements = new Map<string, string>();
  return (value: string, prefix = "redacted") => {
    const key = `${prefix}:${value}`;
    let replacement = replacements.get(key);
    if (!replacement) {
      replacement = `${prefix}-${replacements.size + 1}`;
      replacements.set(key, replacement);
    }
    return replacement;
  };
};

export function anonymizeCncSource(format: SourceFormat, sourceText: string): { sourceText: string; redactionCount: number } {
  let redactionCount = 0;
  const replace = replacementFactory();
  const privacyKeys = new Set(["AUTHOR", "CUSTOMER", "CLIENT", "PROJECT", "JOB", "ORDER", "DESCRIPTION", "DESC", "COMMENT", "LABEL", "LAY", "ID", "GID"]);
  const lines = sourceText.replace(/^\uFEFF/, "").split(/\r?\n/);
  let inScript = false;
  const sanitized = lines.map(line => {
    const trimmed = line.trim();
    if (/^\[(VBSCRIPT|SCRIPT)\]$/i.test(trimmed)) { inScript = true; return line; }
    if (inScript && /^\[[^\]]+\]$/.test(trimmed)) inScript = false;
    if (inScript) {
      if (!trimmed || /^;\s*redacted$/i.test(trimmed)) return line;
      redactionCount += 1;
      return `${line.match(/^\s*/)?.[0] ?? ""}; redacted script line`;
    }
    if (/^\s*[;#]/.test(line)) {
      redactionCount += 1;
      return `${line.match(/^\s*/)?.[0] ?? ""}; redacted comment`;
    }
    if (format === "cix") {
      const parameter = line.match(/^(\s*PARAM\s*,\s*NAME\s*=\s*([^,]+)\s*,\s*VALUE\s*=\s*)(.*?)(\s*)$/i);
      if (parameter && privacyKeys.has(parameter[2]!.trim().toUpperCase())) {
        const raw = parameter[3]!.trim();
        const unquoted = raw.replace(/^"|"$/g, "");
        const key = parameter[2]!.trim().toUpperCase();
        redactionCount += 1;
        return `${parameter[1]}"${replace(unquoted, key === "ID" || key === "GID" ? "identifier" : key.toLowerCase())}"${parameter[4]}`;
      }
      const assignment = line.match(/^(\s*([A-Z][A-Z0-9_]*)\s*=\s*)(.*?)(\s*)$/i);
      if (assignment && privacyKeys.has(assignment[2]!.toUpperCase())) {
        const raw = assignment[3]!.trim().replace(/^"|"$/g, "");
        redactionCount += 1;
        return `${assignment[1]}"${replace(raw, assignment[2]!.toLowerCase())}"${assignment[4]}`;
      }
    } else {
      const header = line.match(/^(\s*([A-Z][A-Z0-9_]*)\s*=\s*)(.*?)(\s*)$/i);
      if (header && privacyKeys.has(header[2]!.toUpperCase())) {
        redactionCount += 1;
        return `${header[1]}${replace(header[3]!.trim(), header[2]!.toLowerCase())}${header[4]}`;
      }
      const recordLabel = line.match(/^(\s*@\s+.*?,\s*)"([^"]*[A-Za-z][^"]*)"(\s*)$/);
      if (recordLabel) {
        redactionCount += 1;
        return `${recordLabel[1]}"${replace(recordLabel[2]!, "label")}"${recordLabel[3]}`;
      }
    }
    return line;
  });
  return { sourceText: sanitized.join("\n"), redactionCount };
}

const robustnessChecks = (input: CorpusInput): RobustnessCheck[] => {
  const variants: Array<[RobustnessCheck["variant"], string]> = [
    ["utf8-bom", `\uFEFF${input.sourceText.replace(/^\uFEFF/, "")}`],
    ["crlf", input.sourceText.replace(/\r?\n/g, "\r\n")],
    ["trailing-whitespace", `${input.sourceText.split(/\r?\n/).map(line => line ? `${line}  ` : line).join("\n")}\n\n`]
  ];
  return variants.map(([variant, sourceText]) => {
    try {
      const reparsed = parse(input.document.source.format, sourceText, `robustness-${variant}.${input.document.source.format}`);
      const diagnostics = errorCodes(reparsed.diagnostics);
      const comparison = compareDocuments(input.document, reparsed);
      return { variant, passed: diagnostics.length === 0 && comparison.semanticMatch && comparison.geometryMatch, diagnosticCodes: diagnostics };
    } catch {
      return { variant, passed: false, diagnosticCodes: ["CORPUS_VARIANT_EXCEPTION"] };
    }
  });
};

const reducedFixture = (input: CorpusInput, conversion: BulkConversionItem, robustness: RobustnessCheck[], rendererPassed: boolean, sanitizedMachiningPreserved: boolean): string | undefined => {
  const failingOperations = new Set(conversion.diagnostics.flatMap(value => value.location?.record ? [value.location.record] : []));
  const operations = input.document.operations.filter(operation => failingOperations.has(operation.id) || operation.kind === "unknown");
  const failures = [
    ...conversion.diagnostics.filter(value => value.severity === "error").map(value => value.code),
    ...robustness.filter(value => !value.passed).flatMap(value => value.diagnosticCodes.length ? value.diagnosticCodes : [`CORPUS_${value.variant.toUpperCase().replace(/-/g, "_")}_FAILED`]),
    ...(!rendererPassed ? ["CORPUS_RENDER_FAILED"] : []),
    ...(!sanitizedMachiningPreserved ? ["CORPUS_ANONYMIZATION_GEOMETRY_CHANGED"] : [])
  ];
  if (!failures.length) return undefined;
  return `${JSON.stringify({
    schemaVersion: "0.1",
    sourceFormat: input.document.source.format,
    panel: input.document.panel,
    diagnosticCodes: [...new Set(failures)].sort(),
    operations: (operations.length ? operations : input.document.operations.slice(0, 3)).map(operation => ({
      id: operation.id,
      kind: operation.kind,
      sourceType: operation.sourceType,
      face: operation.face,
      position: operation.position,
      path: operation.path,
      segments: operation.segments,
      diameter: operation.diameter,
      depth: operation.depth,
      repeat: operation.repeat,
      rawParameterKeys: operation.raw.params && !Array.isArray(operation.raw.params) ? Object.keys(operation.raw.params).sort() : []
    }))
  }, null, 2)}\n`;
};

const conversionStatus = (item: BulkConversionItem): CorpusFileResult["conversionStatus"] => {
  if (item.status === "converted" && item.verified && item.reverseVerified) return "verified";
  const errors = item.diagnostics.filter(value => value.severity === "error");
  const expectedSafetyGate = (code: string): boolean => code.includes("UNSUPPORTED")
    || code === "CONVERSION_SOURCE_UNRESOLVED"
    || code === "CONVERSION_OPERATION_PROFILE_UNVERIFIED";
  return errors.length && errors.every(value => expectedSafetyGate(value.code)) ? "blocked" : "failed";
};

export async function runCorpusLab(inputs: CorpusInput[], generatedAt = new Date().toISOString()): Promise<CorpusLabReport> {
  const signatureFrequency = new Map<string, number>();
  for (const input of inputs) for (const operation of input.document.operations) {
    const signature = operationSignature(operation);
    signatureFrequency.set(signature, (signatureFrequency.get(signature) ?? 0) + 1);
  }
  const conversions = bulkConvertAndVerify(inputs.map(input => ({ name: input.name, document: input.document })), { mergeTwoSided: false });
  const files: CorpusFileResult[] = [];
  for (const [index, input] of inputs.entries()) {
    const conversion = conversions.outputs[index]!;
    const anonymousName = `fixture-${String(index + 1).padStart(4, "0")}.${input.document.source.format}`;
    const anonymized = anonymizeCncSource(input.document.source.format, input.sourceText);
    let rendererPassed = false;
    try { rendererPassed = renderSvg(input.document).includes("<svg"); } catch { rendererPassed = false; }
    let sanitizedMachiningPreserved = false;
    try {
      const sanitizedDocument = parse(input.document.source.format, anonymized.sourceText, anonymousName);
      const comparison = compareDocuments(input.document, sanitizedDocument);
      sanitizedMachiningPreserved = comparison.dimensionsMatch && comparison.geometryMatch;
    } catch { sanitizedMachiningPreserved = false; }
    const robustness = robustnessChecks(input);
    const result: CorpusFileResult = {
      anonymousName,
      sourceFormat: input.document.source.format,
      sourceChecksum: await sha256Hex(input.sourceText),
      sanitizedChecksum: await sha256Hex(anonymized.sourceText),
      operationCount: input.document.operations.length,
      expandedPointCount: input.document.operations.reduce((total, operation) => total + operationPointCount(operation), 0),
      privacyRedactionCount: anonymized.redactionCount,
      sanitizedMachiningPreserved,
      parserPassed: !input.document.diagnostics.some(value => value.severity === "error"),
      rendererPassed,
      conversionStatus: conversionStatus(conversion),
      reverseVerified: conversion.reverseVerified,
      semanticRoundTrip: conversion.supportedSemanticRoundTrip,
      geometryRoundTrip: conversion.expandedGeometryRoundTrip,
      novelSignatures: input.document.operations.map(operationSignature).filter(signature => signatureFrequency.get(signature) === 1),
      robustness,
      diagnosticCodes: [...new Set([...input.document.diagnostics, ...conversion.diagnostics].map(value => value.code))].sort(),
      sanitizedSourceText: anonymized.sourceText
    };
    const reducedFailureFixture = reducedFixture(input, conversion, robustness, rendererPassed, sanitizedMachiningPreserved);
    if (reducedFailureFixture) result.reducedFailureFixture = reducedFailureFixture;
    files.push(result);
  }
  const signatureSet = new Set(files.flatMap(file => file.novelSignatures));
  const seed = files.map(file => file.sourceChecksum).sort().join(":");
  const runHash = await sha256Hex(`${seed}:${generatedAt}`);
  const robustness = files.flatMap(file => file.robustness);
  return {
    schemaVersion: "0.1",
    engineVersion: "0.2.0",
    runId: `CORPUS-${runHash.slice(0, 12).toUpperCase()}`,
    generatedAt,
    summary: {
      files: files.length,
      parserPassed: files.filter(file => file.parserPassed).length,
      rendererPassed: files.filter(file => file.rendererPassed).length,
      conversionsVerified: files.filter(file => file.conversionStatus === "verified").length,
      conversionsBlocked: files.filter(file => file.conversionStatus === "blocked").length,
      conversionsFailed: files.filter(file => file.conversionStatus === "failed").length,
      reverseVerified: files.filter(file => file.reverseVerified).length,
      semanticRoundTrips: files.filter(file => file.semanticRoundTrip).length,
      geometryRoundTrips: files.filter(file => file.geometryRoundTrip).length,
      robustnessPassed: robustness.filter(value => value.passed).length,
      robustnessTotal: robustness.length,
      privacyRedactions: files.reduce((total, file) => total + file.privacyRedactionCount, 0),
      sanitizedMachiningPreserved: files.filter(file => file.sanitizedMachiningPreserved).length,
      novelSignatureCount: signatureSet.size,
      reducedFailureFixtures: files.filter(file => file.reducedFailureFixture !== undefined).length
    },
    files
  };
}

export function publicCorpusReport(report: CorpusLabReport): CorpusLabReport {
  return { ...report, files: report.files.map(({ sanitizedSourceText: _source, reducedFailureFixture: _fixture, ...file }) => ({ ...file, sanitizedSourceText: "" })) };
}

const quality = (file: CorpusFileResult): number => [file.parserPassed, file.rendererPassed, file.sanitizedMachiningPreserved, file.reverseVerified, file.semanticRoundTrip, file.geometryRoundTrip, ...file.robustness.map(value => value.passed)].filter(Boolean).length;

export function compareCorpusReports(current: CorpusLabReport, previous: CorpusLabReport): CorpusReportComparison {
  const previousByChecksum = new Map(previous.files.map(file => [file.sourceChecksum, file]));
  const currentByChecksum = new Map(current.files.map(file => [file.sourceChecksum, file]));
  let improvedFiles = 0;
  let regressedFiles = 0;
  let unchangedFiles = 0;
  for (const file of current.files) {
    const older = previousByChecksum.get(file.sourceChecksum);
    if (!older) continue;
    const delta = quality(file) - quality(older);
    if (delta > 0) improvedFiles += 1;
    else if (delta < 0) regressedFiles += 1;
    else unchangedFiles += 1;
  }
  const currentSignatures = new Set(current.files.flatMap(file => file.novelSignatures));
  const previousSignatures = new Set(previous.files.flatMap(file => file.novelSignatures));
  return {
    comparableFiles: current.files.filter(file => previousByChecksum.has(file.sourceChecksum)).length,
    addedFiles: current.files.filter(file => !previousByChecksum.has(file.sourceChecksum)).length,
    removedFiles: previous.files.filter(file => !currentByChecksum.has(file.sourceChecksum)).length,
    improvedFiles,
    regressedFiles,
    unchangedFiles,
    newNovelSignatures: [...currentSignatures].filter(value => !previousSignatures.has(value)).sort(),
    resolvedNovelSignatures: [...previousSignatures].filter(value => !currentSignatures.has(value)).sort()
  };
}
