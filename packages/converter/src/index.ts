import { operationPoints, validateDocument, type Diagnostic, type OpenCncDocument, type Operation, type PathSegment, type Point, type SourceFormat } from "../../core/src/index.js";
import { parseBpp, splitBppCsv } from "../../parser-bpp/src/index.js";
import { parseCix } from "../../parser-cix/src/index.js";
import { checkDocumentAgainstMachine, detectDialect, dialectProfile, type DialectDetection, type DialectProfile, type DialectProfileId, type MachineCheck, type MachineProfile } from "../../profiles/src/index.js";

export interface ConversionOptions {
  sourceProfileId?: DialectProfileId;
  targetProfileId?: DialectProfileId;
}

export interface ConversionResult {
  targetFormat: SourceFormat;
  contents?: string;
  diagnostics: Diagnostic[];
  sourceProfile: DialectDetection;
  targetProfile: DialectProfile;
}

export interface VerifiedConversion extends ConversionResult {
  verified: boolean;
  reparsed?: OpenCncDocument;
}

export type ComparisonStatus = "exact" | "equivalent" | "changed" | "left-only" | "right-only";
export type FidelityStatus = "exact" | "equivalent" | "normalized" | "metadata" | "unsupported" | "machine-dependent" | "changed";

export interface ComparisonField {
  name: string;
  leftValue: unknown;
  rightValue: unknown;
  status: "exact" | "equivalent" | "changed";
  message?: string;
}

export interface OperationMatch {
  kind: Operation["kind"];
  status: ComparisonStatus;
  leftOperationIds: string[];
  rightOperationIds: string[];
  leftOccurrences: number;
  rightOccurrences: number;
  reversedPath: boolean;
  fields: ComparisonField[];
}

export interface DocumentComparison {
  tolerance: number;
  dimensionsMatch: boolean;
  geometryMatch: boolean;
  semanticMatch: boolean;
  exact: number;
  equivalent: number;
  changed: number;
  leftOnly: number;
  rightOnly: number;
  operationMatches: OperationMatch[];
}

export interface FidelityEntry {
  id: string;
  scope: "file" | "panel" | "operation";
  path: string;
  label: string;
  status: FidelityStatus;
  sourceValue?: unknown;
  targetValue?: unknown;
  reverseValue?: unknown;
  message?: string;
  sourceOperationIds?: string[];
  targetOperationIds?: string[];
  reverseOperationIds?: string[];
}

export interface ConversionDiff {
  verified: boolean;
  counts: Record<FidelityStatus, number>;
  entries: FidelityEntry[];
  targetComparison?: DocumentComparison;
  reverseComparison?: DocumentComparison;
}

export interface BulkConversionInput {
  name: string;
  document: OpenCncDocument;
}

export interface BulkConversionItem {
  name: string;
  sourceNames: string[];
  outputName: string;
  sourceFormat: SourceFormat;
  targetFormat: SourceFormat;
  status: "converted" | "failed";
  contents?: string;
  verified: boolean;
  reverseVerified: boolean;
  supportedSemanticRoundTrip: boolean;
  expandedGeometryRoundTrip: boolean;
  sourceTextPreserved: false;
  machineBehaviorVerified: false;
  sourceProfile: DialectDetection;
  targetProfile: DialectProfile;
  machineProfileId?: string;
  machineChecks: MachineCheck[];
  preservedInertOperationCount: number;
  diagnostics: Diagnostic[];
  diff: ConversionDiff;
  sourceDocument: OpenCncDocument;
  targetDocument?: OpenCncDocument;
  reverseDocument?: OpenCncDocument;
}

export interface BulkConversionReport {
  schemaVersion: "0.1";
  summary: {
    sourceFiles: number;
    total: number;
    twoSidedPairs: number;
    converted: number;
    failed: number;
    reverseVerified: number;
    supportedSemanticRoundTrips: number;
    expandedGeometryRoundTrips: number;
    preservedInertOperations: number;
    machineWarnings: number;
  };
  fidelity: {
    supportedSemantics: "verified-by-reparse-and-reverse-conversion";
    expandedGeometry: "verified-by-expanded-operation-comparison";
    sourceText: "normalized-not-byte-identical";
    machineBehavior: "not-verified-requires-vendor-simulation";
  };
  items: Array<Omit<BulkConversionItem, "contents" | "sourceDocument" | "targetDocument" | "reverseDocument">>;
}

export interface BulkConversionResult {
  outputs: BulkConversionItem[];
  report: BulkConversionReport;
}

export interface BulkConversionOptions extends ConversionOptions {
  machineProfile?: MachineProfile;
  mergeTwoSided?: boolean;
}

const number = (value: number | undefined): string => value === undefined ? "" : String(value);
const bppNumber = (value: number | undefined): string => {
  if (value === undefined) return "";
  const rounded = Math.round((value + Math.sign(value || 1) * Number.EPSILON) * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};
const bppRouteNumber = (value: number | undefined): string => {
  if (value === undefined) return "";
  const rounded = Math.round((value + Math.sign(value || 1) * Number.EPSILON) * 10_000_000) / 10_000_000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};
const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
const pointValue = (point: Point | undefined, key: keyof Point): string => number(point?.[key]);
const bppPointValue = (point: Point | undefined, key: keyof Point): string => bppNumber(point?.[key]);
const rawString = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
const rawBppParams = (operation: Operation): string[] => Array.isArray(operation.raw.params) && operation.raw.params.every(value => typeof value === "string") ? operation.raw.params : [];
const rawCixParams = (operation: Operation): Record<string, string> => {
  const params = operation.raw.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  return Object.fromEntries(Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
};

interface ProcessParameters {
  azimuth: string | null;
  rotation: string | null;
  coordinateMode: string | null;
  toolName: string | null;
  toolType: string | null;
  toolClass: string | null;
  cutterCompensation: string | null;
  entryStraight: string | null;
  entryAngle: string | null;
  exitStraight: string | null;
  exitAngle: string | null;
}

const bppCoordinateMode = (value: string | undefined): string | null => value === "1" ? "azrABS" : value === "0" ? "azrNO" : rawString(value);
const cixCoordinateModeToBpp = (value: string | null): string => value?.toUpperCase() === "AZRABS" ? "1" : value?.toUpperCase() === "AZRNO" || value === null ? "0" : value;

const processParameters = (operation: Operation): ProcessParameters => {
  const empty: ProcessParameters = {
    azimuth: null,
    rotation: null,
    coordinateMode: null,
    toolName: null,
    toolType: null,
    toolClass: null,
    cutterCompensation: null,
    entryStraight: null,
    entryAngle: null,
    exitStraight: null,
    exitAngle: null
  };
  if (operation.sourceType !== "BG" && operation.sourceType !== "BV" && operation.sourceType !== "ROUT") return empty;
  const defaults: ProcessParameters = operation.kind === "drill" ? {
    ...empty,
    azimuth: "0",
    rotation: "0",
    coordinateMode: "azrNO",
    toolType: "0",
    toolClass: "0"
  } : operation.kind === "route" ? {
    ...empty,
    toolType: "0",
    toolClass: "0",
    cutterCompensation: "0",
    entryStraight: "0",
    entryAngle: "0",
    exitStraight: "0",
    exitAngle: "0"
  } : empty;
  if (operation.raw.params && !Array.isArray(operation.raw.params)) {
    const values = rawCixParams(operation);
    return {
      ...defaults,
      azimuth: rawString(values.AZ) ?? defaults.azimuth,
      rotation: rawString(values.AR) ?? defaults.rotation,
      coordinateMode: rawString(values.CKA) ?? defaults.coordinateMode,
      toolName: operation.kind === "route" ? rawString(values.TNM) : null,
      toolType: rawString(values.TTP) ?? defaults.toolType,
      toolClass: rawString(values.TCL) ?? defaults.toolClass,
      cutterCompensation: operation.kind === "route" ? rawString(values.CRC) ?? defaults.cutterCompensation : null,
      entryStraight: operation.kind === "route" ? rawString(values.TIN) ?? defaults.entryStraight : null,
      entryAngle: operation.kind === "route" ? rawString(values.AIN) ?? defaults.entryAngle : null,
      exitStraight: operation.kind === "route" ? rawString(values.TOU) ?? defaults.exitStraight : null,
      exitAngle: operation.kind === "route" ? rawString(values.AOU) ?? defaults.exitAngle : null
    };
  }
  const values = rawBppParams(operation);
  if (operation.kind === "drill") return {
    ...defaults,
    azimuth: rawString(values[17]) ?? defaults.azimuth,
    rotation: rawString(values[18]) ?? defaults.rotation,
    coordinateMode: bppCoordinateMode(values[20]) ?? defaults.coordinateMode,
    toolType: rawString(values[21]) ?? defaults.toolType,
    toolClass: rawString(values[22]) ?? defaults.toolClass
  };
  if (operation.kind === "route") return {
    ...defaults,
    toolName: rawString(values[47]),
    toolType: rawString(values[48]) ?? defaults.toolType,
    toolClass: rawString(values[49]) ?? defaults.toolClass,
    cutterCompensation: rawString(values[50]) ?? defaults.cutterCompensation,
    entryStraight: rawString(values[51]) ?? defaults.entryStraight,
    entryAngle: rawString(values[52]) ?? defaults.entryAngle,
    exitStraight: rawString(values[53]) ?? defaults.exitStraight,
    exitAngle: rawString(values[54]) ?? defaults.exitAngle
  };
  return empty;
};
const isPreservableWait = (operation: Operation): boolean => operation.kind === "unknown"
  && operation.sourceType === "WAIT"
  && Array.isArray(operation.raw.params)
  && operation.raw.params.every(parameter => typeof parameter === "string");
const isBiesseDerivedRouteEntry = (operation: Operation): boolean => operation.raw.biesseDerivedRouteEntry === true;
const unresolvedSourceCodes = new Set([
  "BPP_RECORD_MALFORMED",
  "BPP_ARC_PROFILE_REQUIRED",
  "BPP_ORPHAN_PATH_RECORD",
  "CIX_ARC_INCOMPLETE",
  "CIX_BLOCK_RECORD_UNSUPPORTED",
  "CIX_MACRO_NAME_MISSING",
  "CIX_ORPHAN_PATH_MACRO",
  "CIX_TOP_LEVEL_RECORD"
]);

const diagnostic = (severity: Diagnostic["severity"], code: string, message: string, operation?: Operation): Diagnostic => ({
  severity,
  code,
  message,
  ...(operation ? { location: { record: operation.id } } : {})
});

const conversionDiagnostics = (document: OpenCncDocument, targetFormat: SourceFormat, sourceProfile: DialectProfile, targetProfile: DialectProfile): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  if (sourceProfile.format !== document.source.format) diagnostics.push(diagnostic("error", "CONVERSION_SOURCE_PROFILE_MISMATCH", `Profile ${sourceProfile.label} does not match ${document.source.format.toUpperCase()} input`));
  if (targetProfile.format !== targetFormat) diagnostics.push(diagnostic("error", "CONVERSION_TARGET_PROFILE_MISMATCH", `Profile ${targetProfile.label} does not match ${targetFormat.toUpperCase()} output`));
  const unresolvedSourceDiagnostics = document.diagnostics.filter(item => item.severity === "error" || unresolvedSourceCodes.has(item.code));
  if (unresolvedSourceDiagnostics.length) diagnostics.push(diagnostic("error", "CONVERSION_SOURCE_UNRESOLVED", `Source contains ${unresolvedSourceDiagnostics.length} unresolved parser or validation diagnostic(s)`));
  if (document.source.format === targetFormat) diagnostics.push(diagnostic("error", "CONVERSION_TARGET_EQUALS_SOURCE", `Source is already ${targetFormat.toUpperCase()}`));
  if (document.panel.unit !== "mm") diagnostics.push(diagnostic("error", "CONVERSION_UNIT_UNSUPPORTED", `Conversion requires millimetres; received ${document.panel.unit}`));
  for (const dimension of ["width", "height", "thickness"] as const) {
    const value = document.panel[dimension];
    if (value === undefined || !Number.isFinite(value) || value <= 0) diagnostics.push(diagnostic("error", "CONVERSION_PANEL_INCOMPLETE", `A positive panel ${dimension} is required for conversion`));
  }
  for (const operation of document.operations) {
    if (isBiesseDerivedRouteEntry(operation)) {
      diagnostics.push(diagnostic("info", "CONVERSION_DERIVED_ROUTE_ENTRY_NORMALIZED", `BiesseWorks-generated entry bore ${operation.id} is regenerated from its route rather than treated as separate source machining`, operation));
      continue;
    }
    if (isPreservableWait(operation)) {
      if (targetFormat === "bpp" && (operation.raw.params as string[]).length !== 5) diagnostics.push(diagnostic("error", "CONVERSION_WAIT_DIALECT_UNSUPPORTED", `WAIT ${operation.id} does not have the verified five-parameter Biesse v150 shape`, operation));
      diagnostics.push(diagnostic(
        targetFormat === "cix" ? "warning" : "info",
        targetFormat === "cix" ? "CONVERSION_WAIT_PRESERVED_AS_METADATA" : "CONVERSION_WAIT_RESTORED_FROM_METADATA",
        targetFormat === "cix"
          ? `WAIT ${operation.id} will be preserved as non-executing metadata because no verified CIX execution mapping is available`
          : `WAIT ${operation.id} will be restored from OpenCNC metadata`,
        operation
      ));
      continue;
    }
    if (operation.support && !operation.support.conversion) diagnostics.push(diagnostic("error", "CONVERSION_OPERATION_PROFILE_UNVERIFIED", `${operation.sourceType} ${operation.id} is available for ${operation.support.stage} only: ${operation.support.note ?? "no verified conversion profile"}`, operation));
    if (operation.kind !== "drill" && operation.kind !== "route") {
      diagnostics.push(diagnostic("error", "CONVERSION_OPERATION_UNSUPPORTED", `${operation.kind} operation ${operation.id} cannot be represented safely in ${targetFormat.toUpperCase()}`, operation));
      continue;
    }
    if (operation.face === undefined || !Number.isInteger(operation.face) || operation.face < 0 || operation.face > 5) diagnostics.push(diagnostic("error", "CONVERSION_FACE_INVALID", `${operation.sourceType} ${operation.id} requires a Biesse SIDE value from 0 through 5`, operation));
    if (operation.depth === undefined || !Number.isFinite(operation.depth) || operation.depth <= 0) diagnostics.push(diagnostic("error", "CONVERSION_DEPTH_INVALID", `${operation.sourceType} ${operation.id} requires a positive machining depth`, operation));
    if (operation.diameter === undefined || !Number.isFinite(operation.diameter) || operation.diameter <= 0) diagnostics.push(diagnostic("error", "CONVERSION_DIAMETER_INVALID", `${operation.sourceType} ${operation.id} requires a positive tool diameter`, operation));
    if (operation.kind === "drill") {
      if (operation.sourceType !== "BG" && operation.sourceType !== "BV") diagnostics.push(diagnostic("error", "CONVERSION_DRILL_DIALECT_UNSUPPORTED", `Drill type ${operation.sourceType} is not mapped`, operation));
      if (!operation.position) diagnostics.push(diagnostic("error", "CONVERSION_DRILL_POSITION_MISSING", `Drill ${operation.id} has no position`, operation));
      if (operation.path?.length) diagnostics.push(diagnostic("error", "CONVERSION_DRILL_PATH_UNSUPPORTED", `Drill ${operation.id} also contains an unmapped path`, operation));
      if (operation.repeat && (!Number.isInteger(operation.repeat.count) || operation.repeat.count < 1)) diagnostics.push(diagnostic("error", "CONVERSION_REPEAT_INVALID", `Drill ${operation.id} has an invalid repetition count`, operation));
      if (operation.repeat?.offset.z !== undefined && operation.repeat.offset.z !== 0) diagnostics.push(diagnostic("error", "CONVERSION_Z_REPEAT_UNSUPPORTED", `Drill ${operation.id} repeats along Z, which is not mapped`, operation));
    }
    if (operation.kind === "route") {
      if (operation.sourceType !== "ROUT") diagnostics.push(diagnostic("error", "CONVERSION_ROUTE_DIALECT_UNSUPPORTED", `Route type ${operation.sourceType} is not mapped`, operation));
      if ((operation.path?.length ?? 0) < 2) diagnostics.push(diagnostic("error", "CONVERSION_ROUTE_INCOMPLETE", `Route ${operation.id} needs at least two points`, operation));
      if (operation.position) diagnostics.push(diagnostic("error", "CONVERSION_ROUTE_POSITION_UNSUPPORTED", `Route ${operation.id} contains an unmapped standalone position`, operation));
      if (operation.repeat) diagnostics.push(diagnostic("error", "CONVERSION_ROUTE_REPEAT_UNSUPPORTED", `Repeated route ${operation.id} is not mapped`, operation));
      if (operation.segments?.length) {
        if (operation.segments.length !== Math.max(0, (operation.path?.length ?? 0) - 1)) diagnostics.push(diagnostic("error", "CONVERSION_ROUTE_SEGMENTS_INCOMPLETE", `Route ${operation.id} has a path/segment count mismatch`, operation));
        for (const segment of operation.segments) {
          if (segment.kind === "arc" && (!segment.center || segment.clockwise !== false)) diagnostics.push(diagnostic("error", "CONVERSION_ARC_PROFILE_UNSUPPORTED", `Route ${operation.id} contains an arc outside the verified ARC_EPCE counter-clockwise center/end profile`, operation));
        }
      }
    }
  }
  diagnostics.push(diagnostic("info", "CONVERSION_SOURCE_NORMALIZED", "Conversion preserves the supported OpenCNC panel and operation semantics, not source-specific comments, metadata, or byte layout"));
  return diagnostics;
};

interface BppIdentity {
  objectId: number;
  programId: string;
}

interface BppEmission {
  program: string[];
  vbscript: string[];
}

type VbParameterType = "raw" | "fcn" | "boolean" | "repeat" | "coordinate";

const fnv1a = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return hash >>> 0;
};

class BppIdentityAllocator {
  private objectOffset = 0;
  private programOffset = 0;

  constructor(private readonly objectBase: number) {}

  next(): BppIdentity {
    const identity = { objectId: this.objectBase + this.objectOffset * 8, programId: `P${1000 + this.programOffset}` };
    this.objectOffset += 1;
    this.programOffset += 1;
    return identity;
  }

  objectFor(programId: string): BppIdentity {
    const identity = { objectId: this.objectBase + this.objectOffset * 8, programId };
    this.objectOffset += 1;
    return identity;
  }

  resetProgramSequence(): void {
    this.programOffset = 0;
  }
}

const bppObjectBase = (document: OpenCncDocument): number => {
  const seed = `${document.source.name ?? "opencnc"}|${bppNumber(document.panel.width)}|${bppNumber(document.panel.height)}|${bppNumber(document.panel.thickness)}`;
  return 100_000_000 + (fnv1a(seed) % 80_000_000) * 8;
};

const bppRecord = (code: string, objectId: number, params: string[], indent = ""): string => `${indent}@ ${code}, "", "", ${objectId}, "", 0 :${params.length ? ` ${params.join(", ")}` : ""}`;

const vbParameter = (value: string, type: VbParameterType): string => {
  if (type === "fcn") return `(${value || "0"})*FCN`;
  if (type === "boolean") return value === "0" || value === "-1" ? "NO" : "YES";
  if (type === "repeat") return value === "-1" ? "rpNO" : value === "2" ? "rpXY" : value;
  if (type === "coordinate") return value === "1" ? "azrABS" : value === "0" ? "azrNO" : value;
  return value;
};

const DRILL_VB_TYPES: Partial<Record<number, VbParameterType>> = Object.fromEntries([
  ...[2, 3, 4, 5, 6, 9, 10, 11, 21, 22, 24, 33, 39, 40, 42, 43].map(index => [index, "fcn"] as const),
  ...[7, 16, 19, 25, 26, 27, 29, 44, 46].map(index => [index, "boolean"] as const),
  [8, "repeat"], [20, "coordinate"]
]);

const ROUTE_VB_TYPES: Partial<Record<number, VbParameterType>> = Object.fromEntries([
  ...[3, 4, 7, 9, 10, 11, 12, 13, 20, 21, 27, 30, 34, 36, 38, 42, 43, 45, 46, 54, 56, 57, 61, 63, 64, 65, 66, 67, 78, 81, 82, 83, 84, 91, 92, 93, 94].map(index => [index, "fcn"] as const),
  ...[6, 16, 23, 24, 25, 28, 29, 32, 37, 39, 69, 71, 72, 75, 77].map(index => [index, "boolean"] as const),
  [8, "repeat"], [22, "coordinate"]
]);

const vbParameters = (params: string[], types: Partial<Record<number, VbParameterType>>): string => params
  .map((value, index) => vbParameter(value, types[index] ?? "raw"))
  .join(", ");

const waitToBpp = (operation: Operation, identity: BppIdentity): BppEmission => {
  const params = operation.raw.params as string[];
  const waitType = params[0] === "1" ? "stTR" : params[0] ?? "stTR";
  const repeatMode = params[3] === "0" ? "mrrNO" : params[3] ?? "mrrNO";
  const enabled = params[4] === "0" ? "NO" : "YES";
  return {
    program: [bppRecord("WAIT", identity.objectId, params)],
    vbscript: [`Call ProgBuilder.AddWait(0, ${identity.objectId}, ""    , ${waitType}, ${params[1] ?? "0"}, ${params[2] ?? "0"}, ${repeatMode}, ${enabled})`]
  };
};
const waitToCix = (operation: Operation): string => `; OPENCNC-PRESERVED-WAIT ${encodeURIComponent(JSON.stringify({ id: operation.id, params: operation.raw.params }))}`;

const drillToBpp = (operation: Operation, identity: BppIdentity): BppEmission => {
  const repeat = operation.repeat;
  const technology = processParameters(operation);
  const params = [
    bppNumber(operation.face), quote("1"), bppPointValue(operation.position, "x"), bppPointValue(operation.position, "y"), bppPointValue(operation.position, "z"),
    bppNumber(operation.depth), bppNumber(operation.diameter), "0", repeat ? "2" : "-1", repeat ? bppNumber(repeat.offset.x) : "32",
    repeat ? bppNumber(repeat.offset.y) : "32", "50", "0", "45", String(repeat?.count ?? 0), quote(""), "1",
    technology.azimuth ?? "0", technology.rotation ?? "0", "0", cixCoordinateModeToBpp(technology.coordinateMode), technology.toolType ?? "0",
    technology.toolClass ?? "0", "0", "0", "1", "0", "0", "0", "0", "0", "-1", quote(identity.programId), "0",
    quote(""), quote(""), "0", "0", "0", "0", "0", quote(""), "0", "0", "0", "0", "0", quote(""), quote(""),
    quote(operation.label ?? "")
  ];
  return {
    program: [bppRecord(operation.sourceType, identity.objectId, params)],
    vbscript: [`SIDE = ${bppNumber(operation.face)}: Call BSW_OBJ_BORING.Add_Ver_000(0, ${identity.objectId}, ""    , ${vbParameters(params, DRILL_VB_TYPES)}): SIDE = -1`]
  };
};

const routeSegments = (operation: Operation): PathSegment[] => operation.segments?.length
  ? operation.segments
  : (operation.path ?? []).slice(1).map((end, index) => ({ kind: "line", start: operation.path![index]!, end }));

const needsObservedRouteEntry = (operation: Operation, technology: ProcessParameters, document: OpenCncDocument): boolean => {
  const start = operation.path?.[0];
  if (!start || operation.depth === undefined || operation.diameter === undefined || document.panel.width === undefined || document.panel.height === undefined) return false;
  const strictlyInsidePanel = start.x > 0 && start.y > 0 && start.x < document.panel.width && start.y < document.panel.height;
  return strictlyInsidePanel
    && operation.face === 0
    && Math.abs(operation.depth - 9.5) <= 0.001
    && Math.abs(operation.diameter - 10) <= 0.001
    && technology.toolName?.toUpperCase() === "DIA10"
    && technology.toolType === "103"
    && technology.toolClass === "1"
    && technology.cutterCompensation === "0";
};

const routeToBpp = (operation: Operation, document: OpenCncDocument, allocator: BppIdentityAllocator): BppEmission => {
  const identity = allocator.next();
  const technology = processParameters(operation);
  const params = ["P1000", "0", "1", "0", "0", "", "1", "0", "-1", "0", "0", "32", "32", "50", "0", "45", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "1", "0", "-1", "0", "0", "0", "0", "0", "", "", "", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "", "0", "0", "0", "0", "0", "0", "0", "0", "0", "", "0", "0", "0", "0", "0", "0", "", "", "", "0", "1", "1", "0", "0", "0", "0", "0"];
  params[0] = quote(identity.programId);
  params[1] = bppNumber(operation.face);
  params[2] = quote("1");
  params[3] = bppRouteNumber(operation.path?.[0]?.z) || "0";
  params[4] = bppNumber(operation.depth);
  params[5] = quote("");
  params[7] = bppNumber(operation.diameter);
  params[47] = technology.toolName === null ? quote("") : quote(technology.toolName);
  params[48] = technology.toolType ?? "0";
  params[49] = technology.toolClass ?? "0";
  params[50] = technology.cutterCompensation ?? "0";
  params[51] = technology.entryStraight ?? "0";
  params[52] = technology.entryAngle ?? "0";
  params[53] = technology.exitStraight ?? "0";
  params[54] = technology.exitAngle ?? "0";
  for (const index of [70, 80, 87, 88]) params[index] = quote("");
  params[89] = quote(operation.label ?? "");
  const path = operation.path ?? [];
  const start = path[0]!;
  const startIdentity = allocator.next();
  const entry = needsObservedRouteEntry(operation, technology, document) ? drillToBpp({
    id: `${operation.id}-entry`, kind: "drill", sourceType: "BV", face: operation.face!, label: "BG",
    position: { ...start }, depth: operation.diameter!, diameter: operation.diameter!,
    raw: { code: "BV", biesseDerivedRouteEntry: true, routeObjectId: operation.id }
  }, allocator.objectFor(startIdentity.programId)) : undefined;
  const records = [...(entry?.program ?? []), bppRecord("ROUT", identity.objectId, params)];
  const vbscript = [...(entry?.vbscript ?? []), `SIDE = ${bppNumber(operation.face)}: Call BSW_OBJ_ROUTING.Add_Ver_000(0, ${identity.objectId}, ""    , ${vbParameters(params, ROUTE_VB_TYPES)})`];
  records.push(bppRecord("START_POINT", startIdentity.objectId, [bppRouteNumber(start.x), bppRouteNumber(start.y), bppRouteNumber(start.z) || "0"], "  "));
  vbscript.push(`Call ProgBuilder.AddPoint(65, ${startIdentity.objectId}, ""    , (${bppRouteNumber(start.x)})*FCN, (${bppRouteNumber(start.y)})*FCN, (${bppRouteNumber(start.z) || "0"})*FCN)`);
  routeSegments(operation).forEach(segment => {
    const segmentIdentity = allocator.next();
    if (segment.kind === "arc") {
      const arcParams = [bppRouteNumber(segment.end.x), bppRouteNumber(segment.end.y), bppRouteNumber(segment.center!.x), bppRouteNumber(segment.center!.y), "2", bppRouteNumber(segment.start.z) || "0", bppRouteNumber(segment.end.z) || "0", "0", "0", "0", "0"];
      records.push(bppRecord("ARC_EPCE", segmentIdentity.objectId, arcParams, "  "));
      vbscript.push(`Call ProgBuilder.AddArcEPCE(76, ${segmentIdentity.objectId}, ""    , (${arcParams[0]})*FCN, (${arcParams[1]})*FCN, (${arcParams[2]})*FCN, (${arcParams[3]})*FCN, dirCCW, (${arcParams[5]})*FCN, (${arcParams[6]})*FCN, scOFF, (${arcParams[8]})*FCN, ${arcParams[9]}, ${arcParams[10]})`);
      return;
    }
    const lineParams = [bppRouteNumber(segment.end.x), bppRouteNumber(segment.end.y), "0", bppRouteNumber(segment.end.z) || "0", "0", "0", "0", "0", "0"];
    records.push(bppRecord("LINE_EP", segmentIdentity.objectId, lineParams, "  "));
    vbscript.push(`Call ProgBuilder.AddLineEP(66, ${segmentIdentity.objectId}, ""    , (${lineParams[0]})*FCN, (${lineParams[1]})*FCN, (${lineParams[2]})*FCN, (${lineParams[3]})*FCN, scOFF, (${lineParams[5]})*FCN, ${lineParams[6]}, ${lineParams[7]}, NO)`);
  });
  const endIdentity = allocator.next();
  records.push(bppRecord("ENDPATH", endIdentity.objectId, [], "  "));
  vbscript.push(`Call ProgBuilder.EndPath(64, ${endIdentity.objectId}, ""    ): SIDE = -1`);
  return { program: records, vbscript };
};

const metadataValues = (document: OpenCncDocument): Record<string, unknown> => {
  const value = document.source.format === "cix" ? document.metadata.mainData : document.metadata.variables;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
};

const panelOrientation = (document: OpenCncDocument): string => {
  const value = metadataValues(document).ORLST;
  return typeof value === "string" && value.trim() ? value.replace(/^"|"$/g, "") : "5";
};

const panelPutList = (document: OpenCncDocument): string => {
  const value = metadataValues(document).PUTLST;
  return typeof value === "string" ? value.replace(/^"|"$/g, "") : "";
};

const panelVariableLines = (document: OpenCncDocument): string[] => [
  `PAN=LPX|${bppNumber(document.panel.width)}||4|`,
  `PAN=LPY|${bppNumber(document.panel.height)}||4|`,
  `PAN=LPZ|${bppNumber(document.panel.thickness)}||4|`,
  `PAN=ORLST|${quote(panelOrientation(document))}||0|`,
  "PAN=SIMMETRY|1||0|", "PAN=TLCHK|0||0|", "PAN=TOOLING|\"\"||0|", "PAN=CUSTSTR|\"\"||0|",
  "PAN=FCN|1.000000||0|", "PAN=XCUT|0||4|", "PAN=YCUT|0||4|", "PAN=JIGTH|0||4|", "PAN=CKOP|0||0|",
  "PAN=UNIQUE|0||0|", "PAN=MATERIAL|\"wood\"||0|", `PAN=PUTLST|${quote(panelPutList(document))}||0|`, "PAN=OPPWKRS|0||0|",
  "PAN=UNICLAMP|0||0|", "PAN=CHKCOLL|0||0|", "PAN=WTPIANI|0||0|", "PAN=COLLTOOL|0||0|", "PAN=CALCEDTH|0||0|",
  "PAN=ENABLELABEL|0||0|", "PAN=LOCKWASTE|0||0|", "PAN=LOADEDGEOPT|0||0|"
];

const vbscriptHeader = (document: OpenCncDocument): string[] => [
  "Option Explicit",
  "Dim mm: mm = 1.000000000000000000",
  "Dim inc: inc = 25.399999999999999000",
  "Dim SIDE: SIDE = -1",
  `Dim LPX: LPX = ${bppNumber(document.panel.width)}`,
  `Dim LPY: LPY = ${bppNumber(document.panel.height)}`,
  `Dim LPZ: LPZ = ${bppNumber(document.panel.thickness)}`,
  `Dim ORLST: ORLST = ${quote(panelOrientation(document))}`,
  "Dim SIMMETRY: SIMMETRY = 1", "Dim TLCHK: TLCHK = 0", "Dim TOOLING: TOOLING = \"\"", "Dim CUSTSTR: CUSTSTR = \"\"",
  "Dim FCN: FCN = 1.000000", "Dim XCUT: XCUT = 0", "Dim YCUT: YCUT = 0", "Dim JIGTH: JIGTH = 0", "Dim CKOP: CKOP = 0",
  "Dim UNIQUE: UNIQUE = 0", "Dim MATERIAL: MATERIAL = \"wood\"", `Dim PUTLST: PUTLST = ${quote(panelPutList(document))}`, "Dim OPPWKRS: OPPWKRS = 0",
  "Dim UNICLAMP: UNICLAMP = 0", "Dim CHKCOLL: CHKCOLL = 0", "Dim WTPIANI: WTPIANI = 0", "Dim COLLTOOL: COLLTOOL = 0",
  "Dim CALCEDTH: CALCEDTH = 0", "Dim ENABLELABEL: ENABLELABEL = 0", "Dim LOCKWASTE: LOCKWASTE = 0", "Dim LOADEDGEOPT: LOADEDGEOPT = 0",
  "Sub Main()",
  "Call ProgBuilder.SetPanel(LPX*FCN, LPY*FCN, LPZ*FCN, ORLST, SIMMETRY, TLCHK, TOOLING, CUSTSTR, FCN, XCUT*FCN, YCUT*FCN, JIGTH*FCN, CKOP, UNIQUE, MATERIAL, PUTLST, OPPWKRS, UNICLAMP, CHKCOLL, WTPIANI, COLLTOOL, CALCEDTH, ENABLELABEL, LOCKWASTE, LOADEDGEOPT)"
];

const serializeBpp = (document: OpenCncDocument): string => {
  const allocator = new BppIdentityAllocator(bppObjectBase(document));
  const emissions: BppEmission[] = [];
  for (const operation of document.operations) {
    if (isBiesseDerivedRouteEntry(operation)) continue;
    if (operation.kind === "drill") emissions.push(drillToBpp(operation, allocator.next()));
    else if (operation.kind === "route") emissions.push(routeToBpp(operation, document, allocator));
    else {
      emissions.push(waitToBpp(operation, allocator.next()));
      allocator.resetProgramSequence();
    }
  }
  return [
    "[HEADER]",
    "TYPE=BPP",
    "VER=150",
    "",
    "[DESCRIPTION]",
    "|",
    "",
    "[VARIABLES]",
    ...panelVariableLines(document),
    "",
    "[PROGRAM]",
    "",
    ...emissions.flatMap(emission => emission.program),
    "",
    "[VBSCRIPT]",
    ...vbscriptHeader(document),
    ...emissions.flatMap(emission => emission.vbscript),
    "End Sub",
    "",
    "[MACRODATA]", "", "[TDCODES]", "", "[PCF]", "", "[TOOLING]", "", ""
  ].join("\r\n");
};

interface BppStructuralRecord {
  code: string;
  objectId: number;
  params: string[];
  lexicalParams: string[];
  line: number;
}

const splitBppLexical = (value: string): string[] => {
  if (!value.trim()) return [];
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') {
      field += character;
      if (quoted && value[index + 1] === '"') {
        field += value[index + 1];
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else field += character;
  }
  fields.push(field.trim());
  return fields;
};

const bppError = (code: string, message: string, line?: number): Diagnostic => ({ severity: "error", code, message, ...(line !== undefined ? { location: { line } } : {}) });

/** Validates the observed BiesseWorks v150 envelope in addition to machining semantics. */
export function validateBiesseBppV150(input: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (/(^|[^\r])\n/.test(input)) diagnostics.push(bppError("BPP_VENDOR_LINE_ENDINGS_INVALID", "BiesseWorks v150 output must use Windows CRLF line endings"));
  if (/[^\x09\x0A\x0D\x20-\x7E]/.test(input)) diagnostics.push(bppError("BPP_VENDOR_CODEPAGE_UNVERIFIED", "Non-ASCII BPP text requires a verified Windows code-page profile"));
  const normalized = input.replace(/\r\n/g, "\n");
  const requiredSections = ["HEADER", "DESCRIPTION", "VARIABLES", "PROGRAM", "VBSCRIPT", "MACRODATA", "TDCODES", "PCF", "TOOLING"];
  for (const section of requiredSections) if (!normalized.includes(`[${section}]`)) diagnostics.push(bppError("BPP_VENDOR_SECTION_MISSING", `Biesse v150 output requires [${section}]`));
  for (const variable of ["LPX", "LPY", "LPZ", "ORLST", "FCN", "MATERIAL", "PUTLST"]) if (!new RegExp(`^PAN=${variable}\\|`, "m").test(normalized)) diagnostics.push(bppError("BPP_VENDOR_PANEL_VARIABLE_MISSING", `Biesse v150 output requires panel variable ${variable}`));
  if (!normalized.includes("Call ProgBuilder.SetPanel(")) diagnostics.push(bppError("BPP_VENDOR_SETPANEL_MISSING", "Biesse v150 VBScript requires ProgBuilder.SetPanel"));
  if (!/\bSub Main\(\)[\s\S]*\bEnd Sub\b/.test(normalized)) diagnostics.push(bppError("BPP_VENDOR_VBSCRIPT_INCOMPLETE", "Biesse v150 VBScript requires a complete Main procedure"));

  const lines = normalized.split("\n");
  const programStart = lines.findIndex(line => line.trim() === "[PROGRAM]");
  const vbscriptStart = lines.findIndex(line => line.trim() === "[VBSCRIPT]");
  const records: BppStructuralRecord[] = [];
  if (programStart >= 0) {
    const programEnd = vbscriptStart > programStart ? vbscriptStart : lines.length;
    lines.slice(programStart + 1, programEnd).forEach((line, offset) => {
      if (!line.trim().startsWith("@")) return;
      const lineNumber = programStart + offset + 2;
      const match = line.match(/^\s*@\s*([A-Za-z_]+)\s*,\s*""\s*,\s*""\s*,\s*(\d+)\s*,\s*""\s*,\s*0\s*:\s*(.*)$/);
      if (!match?.[1] || !match[2]) {
        diagnostics.push(bppError("BPP_VENDOR_OBJECT_ID_INVALID", "Program records require an unquoted positive numeric object ID", lineNumber));
        return;
      }
      const objectId = Number(match[2]);
      if (!Number.isSafeInteger(objectId) || objectId <= 0) diagnostics.push(bppError("BPP_VENDOR_OBJECT_ID_INVALID", `Invalid Biesse object ID ${match[2]}`, lineNumber));
      const parameterText = match[3] ?? "";
      records.push({ code: match[1].toUpperCase(), objectId, params: parameterText.trim() ? splitBppCsv(parameterText) : [], lexicalParams: splitBppLexical(parameterText), line: lineNumber });
    });
  }
  if (!records.length) diagnostics.push(bppError("BPP_VENDOR_PROGRAM_EMPTY", "Biesse v150 output requires at least one valid program record"));

  const widths: Record<string, number> = { BG: 50, BV: 50, ROUT: 98, START_POINT: 3, LINE_EP: 9, ARC_EPCE: 11, ENDPATH: 0, WAIT: 5 };
  const quotedFields: Record<string, number[]> = {
    BG: [1, 15, 32, 34, 35, 41, 47, 48, 49], BV: [1, 15, 32, 34, 35, 41, 47, 48, 49],
    ROUT: [0, 2, 5, 47, 70, 80, 87, 88, 89]
  };
  const seenObjectIds = new Set<number>();
  let programNumber = 1000;
  const vbscript = vbscriptStart >= 0 ? lines.slice(vbscriptStart + 1).join("\n") : "";
  const numericParamEquals = (left: string | undefined, right: string | undefined): boolean => {
    if (left === undefined || right === undefined) return false;
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && Math.abs(leftNumber - rightNumber) <= 0.001;
  };
  const isDerivedRouteEntryRecord = (index: number): boolean => {
    const entry = records[index];
    const route = records[index + 1];
    const start = records[index + 2];
    return entry?.code === "BV" && entry.params[49] === "BG" && route?.code === "ROUT" && start?.code === "START_POINT"
      && entry.params[0] === route.params[1]
      && numericParamEquals(entry.params[2], start.params[0])
      && numericParamEquals(entry.params[3], start.params[1])
      && numericParamEquals(entry.params[4], start.params[2])
      && numericParamEquals(entry.params[5], entry.params[6])
      && numericParamEquals(entry.params[6], route.params[7]);
  };
  for (const [recordIndex, record] of records.entries()) {
    if (seenObjectIds.has(record.objectId)) diagnostics.push(bppError("BPP_VENDOR_OBJECT_ID_DUPLICATE", `Biesse object ID ${record.objectId} is duplicated`, record.line));
    seenObjectIds.add(record.objectId);
    const width = widths[record.code];
    if (width === undefined) diagnostics.push(bppError("BPP_VENDOR_RECORD_UNSUPPORTED", `Record ${record.code} is not in the verified v150 writer profile`, record.line));
    else if (record.params.length !== width) diagnostics.push(bppError("BPP_VENDOR_RECORD_WIDTH_INVALID", `${record.code} requires ${width} positional parameters; found ${record.params.length}`, record.line));
    for (const index of quotedFields[record.code] ?? []) {
      const value = record.lexicalParams[index];
      if (value === undefined || !value.startsWith('"') || !value.endsWith('"')) diagnostics.push(bppError("BPP_VENDOR_STRING_FIELD_INVALID", `${record.code} parameter ${index} must be a quoted string`, record.line));
    }
    const derivedRouteEntry = isDerivedRouteEntryRecord(recordIndex);
    const expectedProgramId = `P${programNumber + (derivedRouteEntry ? 1 : 0)}`;
    if ((record.code === "BG" || record.code === "BV") && record.params[32] !== expectedProgramId) diagnostics.push(bppError("BPP_VENDOR_PROGRAM_ID_INVALID", `${record.code} requires ${expectedProgramId}; found ${record.params[32] ?? "(missing)"}`, record.line));
    if (record.code === "ROUT" && record.params[0] !== expectedProgramId) diagnostics.push(bppError("BPP_VENDOR_PROGRAM_ID_INVALID", `ROUT requires ${expectedProgramId}; found ${record.params[0] ?? "(missing)"}`, record.line));
    const vbSignature = record.code === "BG" || record.code === "BV" ? `BSW_OBJ_BORING.Add_Ver_000(0, ${record.objectId},`
      : record.code === "ROUT" ? `BSW_OBJ_ROUTING.Add_Ver_000(0, ${record.objectId},`
      : record.code === "START_POINT" ? `ProgBuilder.AddPoint(65, ${record.objectId},`
      : record.code === "LINE_EP" ? `ProgBuilder.AddLineEP(66, ${record.objectId},`
      : record.code === "ARC_EPCE" ? `ProgBuilder.AddArcEPCE(76, ${record.objectId},`
      : record.code === "ENDPATH" ? `ProgBuilder.EndPath(64, ${record.objectId},`
      : record.code === "WAIT" ? `ProgBuilder.AddWait(0, ${record.objectId},` : undefined;
    if (vbSignature && !vbscript.includes(vbSignature)) diagnostics.push(bppError("BPP_VENDOR_VBSCRIPT_RECORD_MISSING", `VBScript call for ${record.code} object ${record.objectId} is missing`, record.line));
    if (record.code === "WAIT") programNumber = 1000;
    else if (!derivedRouteEntry) programNumber += 1;
  }
  return diagnostics;
}

const cixParam = (name: string, value: string): string => `\tPARAM,NAME=${name},VALUE=${value}`;
const cixBlock = (name: string, parameters: Array<[string, string]>): string => ["BEGIN MACRO", `\tNAME=${name}`, ...parameters.map(([key, value]) => cixParam(key, value)), "END MACRO"].join("\r\n");

const drillToCix = (operation: Operation): string => {
  const repeat = operation.repeat;
  const technology = processParameters(operation);
  const parameters: Array<[string, string]> = [
    ["SIDE", number(operation.face)],
    ["X", pointValue(operation.position, "x")],
    ["Y", pointValue(operation.position, "y")],
    ["Z", pointValue(operation.position, "z")],
    ["DP", number(operation.depth)],
    ["DIA", number(operation.diameter)],
    ["RTY", repeat ? "rpXY" : "rpNO"]
  ];
  if (repeat) parameters.push(["DX", number(repeat.offset.x)], ["DY", number(repeat.offset.y)], ["NRP", String(repeat.count)]);
  if (technology.azimuth !== null) parameters.push(["AZ", technology.azimuth]);
  if (technology.rotation !== null) parameters.push(["AR", technology.rotation]);
  if (technology.coordinateMode !== null) parameters.push(["CKA", technology.coordinateMode]);
  if (technology.toolType !== null) parameters.push(["TTP", technology.toolType]);
  if (technology.toolClass !== null) parameters.push(["TCL", technology.toolClass]);
  if (operation.label !== undefined) parameters.push(["LAY", quote(operation.label)]);
  return cixBlock(operation.sourceType, parameters);
};

const routeToCix = (operation: Operation): string[] => {
  const technology = processParameters(operation);
  const path = operation.path ?? [];
  const parameters: Array<[string, string]> = [
    ["SIDE", number(operation.face)],
    ["Z", pointValue(path[0], "z") || "0"],
    ["DP", number(operation.depth)],
    ["DIA", number(operation.diameter)],
    ["ZS", pointValue(path[0], "z") || "0"],
    ["ZE", pointValue(path.at(-1), "z") || "0"],
    ["THR", "NO"]
  ];
  if (technology.toolName !== null) parameters.push(["TNM", quote(technology.toolName)]);
  if (technology.toolType !== null) parameters.push(["TTP", technology.toolType]);
  if (technology.toolClass !== null) parameters.push(["TCL", technology.toolClass]);
  if (technology.cutterCompensation !== null) parameters.push(["CRC", technology.cutterCompensation]);
  if (technology.entryStraight !== null) parameters.push(["TIN", technology.entryStraight]);
  if (technology.entryAngle !== null) parameters.push(["AIN", technology.entryAngle]);
  if (technology.exitStraight !== null) parameters.push(["TOU", technology.exitStraight]);
  if (technology.exitAngle !== null) parameters.push(["AOU", technology.exitAngle]);
  if (operation.label !== undefined) parameters.push(["LAY", quote(operation.label)]);
  const start = path[0]!;
  return [
    cixBlock("ROUT", parameters),
    cixBlock("START_POINT", [["X", number(start.x)], ["Y", number(start.y)], ["Z", number(start.z)]]),
    ...routeSegments(operation).map(segment => segment.kind === "arc"
      ? cixBlock("ARC_EPCE", [
        ["XE", number(segment.end.x)], ["YE", number(segment.end.y)], ["XC", number(segment.center?.x)], ["YC", number(segment.center?.y)],
        ["DIR", segment.clockwise ? "dirCW" : "dirCCW"], ["ZS", number(segment.start.z)], ["ZE", number(segment.end.z)]
      ])
      : cixBlock("LINE_EP", [["XE", number(segment.end.x)], ["YE", number(segment.end.y)], ["ZS", number(segment.start.z)], ["ZE", number(segment.end.z)]])),
    cixBlock("ENDPATH", [])
  ];
};

const serializeCix = (document: OpenCncDocument): string => {
  const blocks = document.operations
    .filter(operation => !isBiesseDerivedRouteEntry(operation))
    .flatMap(operation => operation.kind === "drill" ? [drillToCix(operation)] : operation.kind === "route" ? routeToCix(operation) : [waitToCix(operation)]);
  return [
    "BEGIN ID CID3",
    "\tREL= 5.0",
    "END ID",
    "",
    "BEGIN MAINDATA",
    `\tLPX=${number(document.panel.width)}`,
    `\tLPY=${number(document.panel.height)}`,
    `\tLPZ=${number(document.panel.thickness)}`,
    `\tORLST=${quote(panelOrientation(document))}`,
    "END MAINDATA",
    "",
    "BEGIN VB",
    "\tVBLINE=\"\"",
    "END VB",
    "",
    ...blocks.flatMap(block => [block, ""])
  ].join("\r\n");
};

const normalizedPoint = (point: Point | undefined): unknown => point ? { x: point.x, y: point.y, z: point.z ?? null } : null;
const normalizedSegments = (operation: Operation): unknown => operation.segments?.map(segment => ({
  ...segment,
  start: normalizedPoint(segment.start),
  end: normalizedPoint(segment.end),
  ...(segment.kind === "arc" ? { center: normalizedPoint(segment.center), via: normalizedPoint(segment.via) } : {})
})) ?? null;
const normalizedOperation = (operation: Operation): unknown => ({
  kind: operation.kind,
  sourceType: operation.sourceType,
  face: operation.face ?? null,
  label: operation.label ?? null,
  position: normalizedPoint(operation.position),
  depth: operation.depth ?? null,
  diameter: operation.diameter ?? null,
  path: operation.path?.map(normalizedPoint) ?? null,
  segments: normalizedSegments(operation),
  geometryRef: operation.geometryRef ?? null,
  repeat: operation.repeat ? { count: operation.repeat.count, offset: { x: operation.repeat.offset.x, y: operation.repeat.offset.y, z: operation.repeat.offset.z ?? 0 } } : null,
  process: processParameters(operation),
  preservedRaw: operation.kind === "unknown" ? operation.raw.params ?? null : null
});

const jsonEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const approximatelyEqual = (left: number | undefined, right: number | undefined, tolerance: number): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return Math.abs(left - right) <= tolerance;
};
const pointApproximatelyEqual = (left: Point, right: Point, tolerance: number): boolean => approximatelyEqual(left.x, right.x, tolerance)
  && approximatelyEqual(left.y, right.y, tolerance)
  && approximatelyEqual(left.z ?? 0, right.z ?? 0, tolerance);
const pathApproximatelyEqual = (left: Point[], right: Point[], tolerance: number): boolean => left.length === right.length
  && left.every((point, index) => pointApproximatelyEqual(point, right[index]!, tolerance));
const optionalPointApproximatelyEqual = (left: Point | undefined, right: Point | undefined, tolerance: number): boolean => left && right
  ? pointApproximatelyEqual(left, right, tolerance)
  : left === right;
const segmentApproximatelyEqual = (left: PathSegment, right: PathSegment, tolerance: number): boolean => {
  if (left.kind !== right.kind || !pointApproximatelyEqual(left.start, right.start, tolerance) || !pointApproximatelyEqual(left.end, right.end, tolerance)) return false;
  if (left.kind === "line" || right.kind === "line") return true;
  return optionalPointApproximatelyEqual(left.center, right.center, tolerance)
    && optionalPointApproximatelyEqual(left.via, right.via, tolerance)
    && approximatelyEqual(left.radius, right.radius, tolerance)
    && left.clockwise === right.clockwise;
};
const segmentsApproximatelyEqual = (left: PathSegment[] | undefined, right: PathSegment[] | undefined, tolerance: number): boolean => {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((segment, index) => segmentApproximatelyEqual(segment, right[index]!, tolerance));
};
const comparisonField = (name: string, leftValue: unknown, rightValue: unknown, tolerance: number, message?: string): ComparisonField => {
  if (jsonEqual(leftValue, rightValue)) return { name, leftValue, rightValue, status: "exact", ...(message ? { message } : {}) };
  if (typeof leftValue === "number" && typeof rightValue === "number" && Math.abs(leftValue - rightValue) <= tolerance) {
    return { name, leftValue, rightValue, status: "equivalent", message: message ?? `Within ${tolerance} mm tolerance` };
  }
  return { name, leftValue, rightValue, status: "changed", ...(message ? { message } : {}) };
};

interface AtomicOperation {
  operation: Operation;
  occurrence: number;
  point?: Point;
  path?: Point[];
}

const atomize = (document: OpenCncDocument): AtomicOperation[] => document.operations.filter(operation => !isBiesseDerivedRouteEntry(operation)).flatMap<AtomicOperation>(operation => {
  if (operation.kind === "drill") return operationPoints(operation).map((point, occurrence) => ({ operation, occurrence, point }));
  if (operation.kind !== "unknown" && operation.path?.length) return [{ operation, occurrence: 0, path: operation.path }];
  return [];
});
const atomSpatialMatch = (left: AtomicOperation, right: AtomicOperation, tolerance: number): { matches: boolean; reversed: boolean; exact: boolean } => {
  if (left.operation.kind !== right.operation.kind) return { matches: false, reversed: false, exact: false };
  if (left.point && right.point) return {
    matches: pointApproximatelyEqual(left.point, right.point, tolerance),
    reversed: false,
    exact: jsonEqual(normalizedPoint(left.point), normalizedPoint(right.point))
  };
  if (left.path && right.path) {
    const direct = pathApproximatelyEqual(left.path, right.path, tolerance);
    const reversed = !direct && pathApproximatelyEqual(left.path, [...right.path].reverse(), tolerance);
    return { matches: direct || reversed, reversed, exact: direct && jsonEqual(left.path.map(normalizedPoint), right.path.map(normalizedPoint)) };
  }
  return { matches: false, reversed: false, exact: false };
};
const semanticCandidateScore = (left: Operation, right: Operation): number => [
  left.face ?? null,
  left.depth ?? null,
  left.diameter ?? null,
  left.label ?? null,
  processParameters(left),
  left.segments?.map(segment => segment.kind) ?? null
].reduce<number>((score, value, index) => score + (jsonEqual(value, [right.face ?? null, right.depth ?? null, right.diameter ?? null, right.label ?? null, processParameters(right), right.segments?.map(segment => segment.kind) ?? null][index]) ? 0 : 1), 0);
const uniqueValues = (values: unknown[]): unknown[] => values.filter((value, index) => values.findIndex(candidate => jsonEqual(candidate, value)) === index);
const aggregateValue = (values: unknown[]): unknown => {
  const unique = uniqueValues(values);
  return unique.length === 1 ? unique[0] : unique;
};
const aggregateField = (name: string, leftValue: unknown, rightValues: unknown[], tolerance: number): ComparisonField => comparisonField(name, leftValue, aggregateValue(rightValues), tolerance);
const repeatValue = (operation: Operation): unknown => operation.repeat
  ? { count: operation.repeat.count, offset: normalizedPoint(operation.repeat.offset) }
  : null;

export function compareDocuments(left: OpenCncDocument, right: OpenCncDocument, tolerance = 0.001): DocumentComparison {
  const operationMatches: OperationMatch[] = [];
  const leftAtoms = atomize(left);
  const rightAtoms = atomize(right);
  const usedRightAtoms = new Set<number>();
  const leftGroups = new Map<Operation, Array<{ left: AtomicOperation; rightIndex?: number; reversed: boolean; exact: boolean }>>();

  leftAtoms.forEach(leftAtom => {
    const candidates = rightAtoms
      .map((rightAtom, rightIndex) => ({ rightAtom, rightIndex, spatial: atomSpatialMatch(leftAtom, rightAtom, tolerance) }))
      .filter(candidate => !usedRightAtoms.has(candidate.rightIndex) && candidate.spatial.matches)
      .sort((a, b) => semanticCandidateScore(leftAtom.operation, a.rightAtom.operation) - semanticCandidateScore(leftAtom.operation, b.rightAtom.operation));
    const candidate = candidates[0];
    if (candidate) usedRightAtoms.add(candidate.rightIndex);
    const group = leftGroups.get(leftAtom.operation) ?? [];
    group.push({ left: leftAtom, ...(candidate ? { rightIndex: candidate.rightIndex } : {}), reversed: candidate?.spatial.reversed ?? false, exact: candidate?.spatial.exact ?? false });
    leftGroups.set(leftAtom.operation, group);
  });

  for (const [leftOperation, pairs] of leftGroups) {
    const paired = pairs.filter((pair): pair is typeof pair & { rightIndex: number } => pair.rightIndex !== undefined);
    const rightOperations = paired.map(pair => rightAtoms[pair.rightIndex]!.operation);
    const uniqueRightOperations = rightOperations.filter((operation, index) => rightOperations.indexOf(operation) === index);
    const rightOperationIds = uniqueRightOperations.map(operation => operation.id);
    const fields: ComparisonField[] = [];
    if (rightOperations.length) {
      fields.push(aggregateField("face", leftOperation.face ?? null, rightOperations.map(operation => operation.face ?? null), tolerance));
      fields.push(aggregateField("depth", leftOperation.depth ?? null, rightOperations.map(operation => operation.depth ?? null), tolerance));
      fields.push(aggregateField("diameter", leftOperation.diameter ?? null, rightOperations.map(operation => operation.diameter ?? null), tolerance));
      fields.push(aggregateField("label", leftOperation.label ?? null, rightOperations.map(operation => operation.label ?? null), tolerance));
      fields.push(aggregateField("process", processParameters(leftOperation), rightOperations.map(processParameters), tolerance));
      const sourceTypes = uniqueValues(rightOperations.map(operation => operation.sourceType));
      fields.push(comparisonField("sourceType", leftOperation.sourceType, aggregateValue(sourceTypes), tolerance));
      const sameRepresentation = uniqueRightOperations.length === 1
        && jsonEqual(repeatValue(leftOperation), repeatValue(rightOperations[0]!));
      fields.push(sameRepresentation
        ? comparisonField("repetition", repeatValue(leftOperation), repeatValue(rightOperations[0]!), tolerance)
        : { name: "repetition", leftValue: repeatValue(leftOperation), rightValue: `${paired.length} expanded occurrence(s) across ${rightOperationIds.length} operation(s)`, status: "equivalent", message: "Same expanded operations, different grouping" });
      const allSpatialExact = paired.length === pairs.length && paired.every(pair => pair.exact);
      const leftGeometryValue = leftOperation.kind !== "drill"
        ? leftOperation.path?.map(normalizedPoint) ?? []
        : pairs.map(pair => normalizedPoint(pair.left.point));
      const rightGeometryValue = leftOperation.kind !== "drill"
        ? rightOperations[0]?.path?.map(normalizedPoint) ?? []
        : paired.map(pair => normalizedPoint(rightAtoms[pair.rightIndex]?.point));
      fields.push({
        name: leftOperation.kind !== "drill" ? "path" : "position",
        leftValue: leftGeometryValue,
        rightValue: rightGeometryValue,
        status: paired.length !== pairs.length ? "changed" : allSpatialExact ? "exact" : "equivalent",
        ...(!allSpatialExact && paired.length === pairs.length ? { message: `Geometry matches within ${tolerance} mm tolerance` } : {})
      });
      if (leftOperation.kind !== "drill" && uniqueRightOperations.length === 1) {
        const rightOperation = uniqueRightOperations[0]!;
        const leftSegments = normalizedSegments(leftOperation);
        const rightSegments = normalizedSegments(rightOperation);
        const segmentsExact = jsonEqual(leftSegments, rightSegments);
        const segmentsEquivalent = segmentsApproximatelyEqual(leftOperation.segments, rightOperation.segments, tolerance);
        fields.push({
          name: "segments",
          leftValue: leftSegments,
          rightValue: rightSegments,
          status: segmentsExact ? "exact" : segmentsEquivalent ? "equivalent" : "changed",
          ...(!segmentsExact && segmentsEquivalent ? { message: `Line/arc geometry matches within ${tolerance} mm tolerance` } : {})
        });
      }
      if (paired.some(pair => pair.reversed)) fields.push({ name: "pathDirection", leftValue: "forward", rightValue: "reversed", status: "changed", message: "The same route traversed in reverse can change machining behavior" });
    } else {
      fields.push({ name: "geometry", leftValue: leftOperation.kind !== "drill" ? leftOperation.path?.map(normalizedPoint) ?? [] : `${pairs.length} expanded occurrence(s)`, rightValue: null, status: "changed", message: "No spatial match was found" });
    }
    if (paired.length !== pairs.length && rightOperations.length) fields.push({ name: "occurrences", leftValue: pairs.length, rightValue: paired.length, status: "changed", message: "Some expanded operations are missing" });
    const status: ComparisonStatus = paired.length === 0
      ? "left-only"
      : fields.some(field => field.status === "changed")
        ? "changed"
        : fields.some(field => field.status === "equivalent")
          ? "equivalent"
          : "exact";
    operationMatches.push({
      kind: leftOperation.kind,
      status,
      leftOperationIds: [leftOperation.id],
      rightOperationIds,
      leftOccurrences: pairs.length,
      rightOccurrences: paired.length,
      reversedPath: paired.some(pair => pair.reversed),
      fields
    });
  }

  const unusedRightGroups = new Map<Operation, AtomicOperation[]>();
  rightAtoms.forEach((atom, index) => {
    if (usedRightAtoms.has(index)) return;
    const group = unusedRightGroups.get(atom.operation) ?? [];
    group.push(atom);
    unusedRightGroups.set(atom.operation, group);
  });
  for (const [rightOperation, atoms] of unusedRightGroups) operationMatches.push({
    kind: atoms[0]!.operation.kind,
    status: "right-only",
    leftOperationIds: [],
    rightOperationIds: [rightOperation.id],
    leftOccurrences: 0,
    rightOccurrences: atoms.length,
    reversedPath: false,
    fields: [{ name: "geometry", leftValue: null, rightValue: atoms[0]!.operation.kind !== "drill" ? atoms[0]!.path?.map(normalizedPoint) ?? [] : `${atoms.length} expanded occurrence(s)`, status: "changed", message: "Only present in the comparison file" }]
  });

  const hasAtomicGeometry = (operation: Operation): boolean => operation.kind === "drill" ? operationPoints(operation).length > 0 : Boolean(operation.path?.length);
  const leftUnknown = left.operations.filter(operation => !isBiesseDerivedRouteEntry(operation) && (operation.kind === "unknown" || !hasAtomicGeometry(operation)));
  const rightUnknown = right.operations.filter(operation => !isBiesseDerivedRouteEntry(operation) && (operation.kind === "unknown" || !hasAtomicGeometry(operation)));
  const usedRightUnknown = new Set<number>();
  leftUnknown.forEach(operation => {
    let rightIndex = rightUnknown.findIndex((candidate, index) => !usedRightUnknown.has(index) && jsonEqual(normalizedOperation(operation), normalizedOperation(candidate)));
    if (rightIndex < 0) rightIndex = rightUnknown.findIndex((candidate, index) => !usedRightUnknown.has(index) && candidate.sourceType === operation.sourceType);
    const rightOperation = rightIndex >= 0 ? rightUnknown[rightIndex] : undefined;
    if (rightIndex >= 0) usedRightUnknown.add(rightIndex);
    const field = comparisonField("preservedMetadata", normalizedOperation(operation), rightOperation ? normalizedOperation(rightOperation) : null, tolerance);
    operationMatches.push({ kind: operation.kind, status: rightOperation ? field.status : "left-only", leftOperationIds: [operation.id], rightOperationIds: rightOperation ? [rightOperation.id] : [], leftOccurrences: 1, rightOccurrences: rightOperation ? 1 : 0, reversedPath: false, fields: [field] });
  });
  rightUnknown.forEach((operation, index) => {
    if (!usedRightUnknown.has(index)) operationMatches.push({ kind: operation.kind, status: "right-only", leftOperationIds: [], rightOperationIds: [operation.id], leftOccurrences: 0, rightOccurrences: 1, reversedPath: false, fields: [{ name: "preservedMetadata", leftValue: null, rightValue: normalizedOperation(operation), status: "changed" }] });
  });

  const panelFields = [
    comparisonField("width", left.panel.width ?? null, right.panel.width ?? null, tolerance),
    comparisonField("height", left.panel.height ?? null, right.panel.height ?? null, tolerance),
    comparisonField("thickness", left.panel.thickness ?? null, right.panel.thickness ?? null, tolerance),
    comparisonField("unit", left.panel.unit, right.panel.unit, tolerance)
  ];
  const dimensionsMatch = panelFields.every(field => field.status !== "changed");
  const geometryFields = new Set(["face", "depth", "diameter", "position", "path", "segments", "pathDirection", "geometry", "occurrences"]);
  const geometricMatches = operationMatches.filter(match => match.kind !== "unknown" && match.kind !== "tool-change" && match.kind !== "transform");
  const geometryMatch = dimensionsMatch && geometricMatches.every(match => match.status !== "left-only" && match.status !== "right-only"
    && match.fields.filter(field => geometryFields.has(field.name)).every(field => field.status !== "changed"));
  const semanticMatch = dimensionsMatch && operationMatches.every(match => match.status === "exact" || match.status === "equivalent");
  return {
    tolerance,
    dimensionsMatch,
    geometryMatch,
    semanticMatch,
    exact: operationMatches.filter(match => match.status === "exact").length,
    equivalent: operationMatches.filter(match => match.status === "equivalent").length,
    changed: operationMatches.filter(match => match.status === "changed").length,
    leftOnly: operationMatches.filter(match => match.status === "left-only").length,
    rightOnly: operationMatches.filter(match => match.status === "right-only").length,
    operationMatches
  };
}

const BIESSE_NUMERIC_RESOLUTION_MM = 0.001;

export function documentsSemanticallyEqual(left: OpenCncDocument, right: OpenCncDocument): boolean {
  return compareDocuments(left, right, BIESSE_NUMERIC_RESOLUTION_MM).semanticMatch;
}

export function documentsGeometryEqual(left: OpenCncDocument, right: OpenCncDocument): boolean {
  return compareDocuments(left, right, BIESSE_NUMERIC_RESOLUTION_MM).geometryMatch;
}

const fidelityStatus = (target: ComparisonStatus | ComparisonField["status"] | undefined, reverse: ComparisonStatus | ComparisonField["status"] | undefined): FidelityStatus => {
  if (target === "changed" || target === "left-only" || target === "right-only" || reverse === "changed" || reverse === "left-only" || reverse === "right-only") return "changed";
  if (target === "equivalent" || reverse === "equivalent") return "equivalent";
  return "exact";
};
const operationSummary = (operation: Operation | undefined): unknown => operation ? {
  kind: operation.kind,
  sourceType: operation.sourceType,
  face: operation.face ?? null,
  occurrences: operation.kind === "drill" ? operationPoints(operation).length : 1,
  depth: operation.depth ?? null,
  diameter: operation.diameter ?? null
} : null;
const operationMatchFor = (comparison: DocumentComparison | undefined, operationId: string): OperationMatch | undefined => comparison?.operationMatches.find(match => match.leftOperationIds.includes(operationId));

export function createConversionDiff(
  source: OpenCncDocument,
  target?: OpenCncDocument,
  reverse?: OpenCncDocument,
  diagnostics: Diagnostic[] = [],
  tolerance = 0.001
): ConversionDiff {
  const targetComparison = target ? compareDocuments(source, target, tolerance) : undefined;
  const reverseComparison = reverse ? compareDocuments(source, reverse, tolerance) : undefined;
  const entries: FidelityEntry[] = [];
  const panelFields = ["width", "height", "thickness", "unit"] as const;
  panelFields.forEach(field => {
    const sourceValue = source.panel[field] ?? null;
    const targetValue = target?.panel[field] ?? null;
    const reverseValue = reverse?.panel[field] ?? null;
    const targetField = comparisonField(field, sourceValue, targetValue, tolerance);
    const reverseField = reverse ? comparisonField(field, sourceValue, reverseValue, tolerance) : undefined;
    entries.push({
      id: `panel-${field}`,
      scope: "panel",
      path: `panel.${field}`,
      label: `Panel ${field}`,
      status: target ? fidelityStatus(targetField.status, reverseField?.status) : "unsupported",
      sourceValue,
      targetValue,
      ...(reverse ? { reverseValue } : {}),
      ...(targetField.message ? { message: targetField.message } : {})
    });
  });

  source.operations.forEach(operation => {
    const targetMatch = operationMatchFor(targetComparison, operation.id);
    const reverseMatch = operationMatchFor(reverseComparison, operation.id);
    const targetOperations = targetMatch?.rightOperationIds.map(id => target?.operations.find(candidate => candidate.id === id)).filter((candidate): candidate is Operation => Boolean(candidate)) ?? [];
    const reverseOperations = reverseMatch?.rightOperationIds.map(id => reverse?.operations.find(candidate => candidate.id === id)).filter((candidate): candidate is Operation => Boolean(candidate)) ?? [];
    const isMetadata = isPreservableWait(operation);
    entries.push({
      id: `operation-${operation.id}`,
      scope: "operation",
      path: `operations.${operation.id}`,
      label: `${operation.kind.toUpperCase()} ${operation.id}`,
      status: isMetadata ? "metadata" : target ? fidelityStatus(targetMatch?.status, reverseMatch?.status) : "unsupported",
      sourceValue: operationSummary(operation),
      targetValue: targetOperations.length === 1 ? operationSummary(targetOperations[0]) : targetOperations.map(operationSummary),
      ...(reverse ? { reverseValue: reverseOperations.length === 1 ? operationSummary(reverseOperations[0]) : reverseOperations.map(operationSummary) } : {}),
      sourceOperationIds: [operation.id],
      targetOperationIds: targetMatch?.rightOperationIds ?? [],
      reverseOperationIds: reverseMatch?.rightOperationIds ?? [],
      ...(isMetadata ? { message: "Preserved as inert metadata in CIX and restored when converted back to BPP" } : {})
    });
    targetMatch?.fields.forEach((field, fieldIndex) => {
      const reverseField = reverseMatch?.fields.find(candidate => candidate.name === field.name);
      entries.push({
        id: `operation-${operation.id}-${field.name}-${fieldIndex}`,
        scope: "operation",
        path: `operations.${operation.id}.${field.name}`,
        label: `${operation.id} · ${field.name}`,
        status: isMetadata ? "metadata" : fidelityStatus(field.status, reverseField?.status),
        sourceValue: field.leftValue,
        targetValue: field.rightValue,
        ...(reverseField ? { reverseValue: reverseField.rightValue } : {}),
        sourceOperationIds: [operation.id],
        targetOperationIds: targetMatch.rightOperationIds,
        reverseOperationIds: reverseMatch?.rightOperationIds ?? [],
        ...(field.message ? { message: field.message } : {})
      });
    });
  });

  targetComparison?.operationMatches.filter(match => match.status === "right-only").forEach((match, index) => entries.push({
    id: `target-only-${index}`,
    scope: "operation",
    path: `target.operations.${match.rightOperationIds.join("+")}`,
    label: `Target-only ${match.kind}`,
    status: "changed",
    sourceValue: null,
    targetValue: match.rightOperationIds,
    targetOperationIds: match.rightOperationIds,
    message: "The target contains an operation with no source match"
  }));

  entries.push({
    id: "file-source-text",
    scope: "file",
    path: "file.sourceText",
    label: "Source text, comments and byte layout",
    status: "normalized",
    sourceValue: "vendor source text",
    targetValue: "canonical OpenCNC output",
    reverseValue: reverse ? "canonical OpenCNC output" : undefined,
    message: "Supported machining semantics are preserved; source-specific formatting and comments are normalized"
  });
  entries.push({
    id: "file-machine-behavior",
    scope: "file",
    path: "file.machineBehavior",
    label: "Machine behavior and tooling",
    status: "machine-dependent",
    sourceValue: "not simulated",
    targetValue: "requires vendor simulation",
    reverseValue: reverse ? "requires vendor simulation" : undefined,
    message: "Collision, tool-library, postprocessor and controller behavior require machine-vendor validation"
  });
  diagnostics.filter(item => item.severity === "error").forEach((item, index) => entries.push({
    id: `unsupported-${item.code}-${index}`,
    scope: "file",
    path: `diagnostics.${item.code}`,
    label: item.code,
    status: "unsupported",
    message: item.message
  }));
  const statuses: FidelityStatus[] = ["exact", "equivalent", "normalized", "metadata", "unsupported", "machine-dependent", "changed"];
  const counts = Object.fromEntries(statuses.map(status => [status, entries.filter(entry => entry.status === status).length])) as Record<FidelityStatus, number>;
  return {
    verified: Boolean(targetComparison?.semanticMatch && reverseComparison?.semanticMatch && counts.changed === 0 && counts.unsupported === 0),
    counts,
    entries,
    ...(targetComparison ? { targetComparison } : {}),
    ...(reverseComparison ? { reverseComparison } : {})
  };
}

export function convertDocument(document: OpenCncDocument, targetFormat: SourceFormat, options: ConversionOptions = {}): ConversionResult {
  const detected = detectDialect(document);
  const sourceProfile = dialectProfile(options.sourceProfileId ?? detected.profileId);
  const targetProfile = dialectProfile(options.targetProfileId ?? sourceProfile.conversionTarget);
  const diagnostics = conversionDiagnostics(document, targetFormat, sourceProfile, targetProfile);
  if (diagnostics.some(item => item.severity === "error")) return { targetFormat, diagnostics, sourceProfile: detected, targetProfile };
  const contents = targetFormat === "bpp" ? serializeBpp(document) : serializeCix(document);
  const outputDiagnostics = targetFormat === "bpp" ? validateBiesseBppV150(contents) : [];
  const completeDiagnostics = [...diagnostics, ...outputDiagnostics];
  if (completeDiagnostics.some(item => item.severity === "error")) return { targetFormat, diagnostics: completeDiagnostics, sourceProfile: detected, targetProfile };
  return { targetFormat, contents, diagnostics: completeDiagnostics, sourceProfile: detected, targetProfile };
}

export function convertAndVerify(document: OpenCncDocument, targetFormat: SourceFormat, options: ConversionOptions = {}): VerifiedConversion {
  const conversion = convertDocument(document, targetFormat, options);
  if (conversion.contents === undefined) return { ...conversion, verified: false };
  const reparsed = targetFormat === "bpp" ? parseBpp(conversion.contents, "converted.bpp") : parseCix(conversion.contents, "converted.cix");
  reparsed.diagnostics.push(...validateDocument(reparsed));
  const diagnostics = [...conversion.diagnostics];
  const targetErrors = reparsed.diagnostics.filter(item => item.severity === "error");
  if (targetErrors.length) diagnostics.push(diagnostic("error", "CONVERSION_TARGET_INVALID", `Converted ${targetFormat.toUpperCase()} reparsed with ${targetErrors.length} error(s)`));
  const equivalent = documentsSemanticallyEqual(document, reparsed);
  if (!equivalent) diagnostics.push(diagnostic("error", "CONVERSION_ROUND_TRIP_MISMATCH", "Converted output did not reproduce the same supported panel and operation semantics"));
  return { ...conversion, diagnostics, verified: targetErrors.length === 0 && equivalent, reparsed };
}

const oppositeFormat = (format: SourceFormat): SourceFormat => format === "bpp" ? "cix" : "bpp";

interface TwoSidedFaceName {
  base: string;
  face: 0 | 1;
}

interface BulkConversionJob {
  name: string;
  sourceNames: string[];
  document: OpenCncDocument;
  diagnostics: Diagnostic[];
}

const twoSidedFaceName = (name: string): TwoSidedFaceName | undefined => {
  const match = /^(.*)_f([01])(?:-\d+)?\.cix$/i.exec(name.normalize("NFC"));
  if (!match?.[1] || (match[2] !== "0" && match[2] !== "1")) return undefined;
  return { base: match[1], face: Number(match[2]) as 0 | 1 };
};

const pairedPanelValueMatches = (left: number | undefined, right: number | undefined): boolean => left !== undefined
  && right !== undefined
  && Math.abs(left - right) <= 0.001;

const normalizedOrientation = (document: OpenCncDocument): string => panelOrientation(document).trim().toLocaleLowerCase();

const twoSidedPanelsMatch = (left: OpenCncDocument, right: OpenCncDocument): boolean => left.panel.unit === right.panel.unit
  && pairedPanelValueMatches(left.panel.width, right.panel.width)
  && pairedPanelValueMatches(left.panel.height, right.panel.height)
  && pairedPanelValueMatches(left.panel.thickness, right.panel.thickness)
  && normalizedOrientation(left) === normalizedOrientation(right);

const prefixedOperation = (operation: Operation, prefix: "f0" | "f1"): Operation => {
  const clone = structuredClone(operation);
  clone.id = `${prefix}:${operation.id}`;
  clone.raw = { ...clone.raw, twoSidedSourceFace: prefix };
  return clone;
};

const mergeTwoSidedDocuments = (base: string, face0: BulkConversionInput, face1: BulkConversionInput): OpenCncDocument => ({
  schemaVersion: "0.1",
  source: { format: "cix", name: face1.name },
  panel: structuredClone(face0.document.panel),
  operations: [
    ...face0.document.operations.map(operation => prefixedOperation(operation, "f0")),
    {
      id: `two-sided:${base}:wait`,
      kind: "unknown",
      sourceType: "WAIT",
      support: {
        stage: "verified-conversion",
        geometry: "none",
        conversion: true,
        note: "Verified BiesseWorks operator flip boundary between paired f0 and f1 CIX programs"
      },
      raw: {
        code: "WAIT",
        sourceId: null,
        params: ["1", "5", "0", "0", "1"],
        generatedBy: "opencnc-two-sided-pair",
        transition: { from: "f0", to: "f1" }
      }
    },
    ...face1.document.operations.map(operation => prefixedOperation(operation, "f1"))
  ],
  metadata: {
    ...structuredClone(face0.document.metadata),
    twoSidedPair: {
      schemaVersion: "0.1",
      base,
      sources: [face0.name, face1.name],
      operationOrder: ["f0", "WAIT", "f1"],
      waitParameters: ["1", "5", "0", "0", "1"]
    }
  },
  diagnostics: [
    ...structuredClone(face0.document.diagnostics),
    ...structuredClone(face1.document.diagnostics),
    diagnostic("info", "CIX_TWO_SIDED_PAIR_MERGED", `${face0.name} and ${face1.name} were merged in f0 → WAIT → f1 order using the verified BiesseWorks material-reposition boundary`)
  ]
});

const bulkConversionJobs = (inputs: BulkConversionInput[], mergeTwoSided: boolean): BulkConversionJob[] => {
  if (!mergeTwoSided) return inputs.map(input => ({ name: input.name, sourceNames: [input.name], document: input.document, diagnostics: [] }));
  const families = new Map<string, Array<{ input: BulkConversionInput; index: number; face: TwoSidedFaceName }>>();
  inputs.forEach((input, index) => {
    if (input.document.source.format !== "cix") return;
    const face = twoSidedFaceName(input.name);
    if (!face) return;
    const key = face.base.toLocaleLowerCase();
    const family = families.get(key) ?? [];
    family.push({ input, index, face });
    families.set(key, family);
  });

  const pairs = new Map<number, { face0: BulkConversionInput; face1: BulkConversionInput; base: string; indexes: number[] }>();
  const standaloneDiagnostics = new Map<number, Diagnostic[]>();
  for (const family of families.values()) {
    const face0 = family.filter(candidate => candidate.face.face === 0);
    const face1 = family.filter(candidate => candidate.face.face === 1);
    if (face0.length === 1 && face1.length === 1 && family.length === 2) {
      if (twoSidedPanelsMatch(face0[0]!.input.document, face1[0]!.input.document)) {
        const indexes = [face0[0]!.index, face1[0]!.index];
        pairs.set(Math.min(...indexes), { face0: face0[0]!.input, face1: face1[0]!.input, base: face0[0]!.face.base, indexes });
      } else {
        const warning = diagnostic("warning", "CIX_TWO_SIDED_PAIR_PANEL_MISMATCH", `${face0[0]!.input.name} and ${face1[0]!.input.name} look like a two-sided pair but panel dimensions, units, or orientation differ; they were not merged`);
        family.forEach(candidate => standaloneDiagnostics.set(candidate.index, [warning]));
      }
    } else if (family.length > 1) {
      const warning = diagnostic("warning", "CIX_TWO_SIDED_PAIR_AMBIGUOUS", `Could not safely pair ${family.map(candidate => candidate.input.name).join(", ")}; exactly one f0 and one f1 file are required`);
      family.forEach(candidate => standaloneDiagnostics.set(candidate.index, [warning]));
    }
  }

  const consumed = new Set<number>();
  const jobs: BulkConversionJob[] = [];
  inputs.forEach((input, index) => {
    if (consumed.has(index)) return;
    const pair = pairs.get(index);
    if (pair) {
      pair.indexes.forEach(pairIndex => consumed.add(pairIndex));
      jobs.push({
        name: pair.face1.name,
        sourceNames: [pair.face0.name, pair.face1.name],
        document: mergeTwoSidedDocuments(pair.base, pair.face0, pair.face1),
        diagnostics: [diagnostic("info", "CIX_TWO_SIDED_PAIR_MERGED", `${pair.face0.name} + ${pair.face1.name} → ${pair.face1.name.replace(/\.cix$/i, ".bpp")}`)]
      });
      return;
    }
    consumed.add(index);
    jobs.push({ name: input.name, sourceNames: [input.name], document: input.document, diagnostics: standaloneDiagnostics.get(index) ?? [] });
  });
  return jobs;
};

export function bulkConvertAndVerify(inputs: BulkConversionInput[], options: BulkConversionOptions = {}): BulkConversionResult {
  const outputs = bulkConversionJobs(inputs, options.mergeTwoSided !== false).map<BulkConversionItem>(({ name, sourceNames, document, diagnostics: jobDiagnostics }) => {
    const targetFormat = oppositeFormat(document.source.format);
    const outputName = name.replace(/\.(bpp|cix)$/i, `.${targetFormat}`);
    const conversion = convertAndVerify(document, targetFormat, options);
    const reverse = conversion.verified && conversion.reparsed ? convertAndVerify(conversion.reparsed, document.source.format) : undefined;
    const supportedSemanticRoundTrip = Boolean(reverse?.verified && reverse.reparsed && documentsSemanticallyEqual(document, reverse.reparsed));
    const expandedGeometryRoundTrip = Boolean(reverse?.verified && reverse.reparsed && documentsGeometryEqual(document, reverse.reparsed));
    const preservedInertOperationCount = document.operations.filter(isPreservableWait).length;
    const machineChecks = options.machineProfile ? checkDocumentAgainstMachine(document, options.machineProfile) : [];
    const diff = createConversionDiff(document, conversion.reparsed, reverse?.reparsed, conversion.diagnostics);
    return {
      name,
      sourceNames,
      outputName,
      sourceFormat: document.source.format,
      targetFormat,
      status: conversion.verified && supportedSemanticRoundTrip && expandedGeometryRoundTrip ? "converted" : "failed",
      ...(conversion.contents !== undefined ? { contents: conversion.contents } : {}),
      verified: conversion.verified,
      reverseVerified: reverse?.verified ?? false,
      supportedSemanticRoundTrip,
      expandedGeometryRoundTrip,
      sourceTextPreserved: false,
      machineBehaviorVerified: false,
      sourceProfile: conversion.sourceProfile,
      targetProfile: conversion.targetProfile,
      ...(options.machineProfile ? { machineProfileId: options.machineProfile.id } : {}),
      machineChecks,
      preservedInertOperationCount,
      diagnostics: [...jobDiagnostics, ...conversion.diagnostics],
      diff,
      sourceDocument: document,
      ...(conversion.reparsed ? { targetDocument: conversion.reparsed } : {}),
      ...(reverse?.reparsed ? { reverseDocument: reverse.reparsed } : {})
    };
  });
  const reportItems = outputs.map(({ contents: _contents, sourceDocument: _sourceDocument, targetDocument: _targetDocument, reverseDocument: _reverseDocument, ...item }) => item);
  return {
    outputs,
    report: {
      schemaVersion: "0.1",
      summary: {
        sourceFiles: inputs.length,
        total: outputs.length,
        twoSidedPairs: outputs.filter(item => item.sourceNames.length === 2).length,
        converted: outputs.filter(item => item.status === "converted").length,
        failed: outputs.filter(item => item.status === "failed").length,
        reverseVerified: outputs.filter(item => item.reverseVerified).length,
        supportedSemanticRoundTrips: outputs.filter(item => item.supportedSemanticRoundTrip).length,
        expandedGeometryRoundTrips: outputs.filter(item => item.expandedGeometryRoundTrip).length,
        preservedInertOperations: outputs.reduce((total, item) => total + item.preservedInertOperationCount, 0)
        ,machineWarnings: outputs.reduce((total, item) => total + item.machineChecks.filter(check => check.severity === "warning").length, 0)
      },
      fidelity: {
        supportedSemantics: "verified-by-reparse-and-reverse-conversion",
        expandedGeometry: "verified-by-expanded-operation-comparison",
        sourceText: "normalized-not-byte-identical",
        machineBehavior: "not-verified-requires-vendor-simulation"
      },
      items: reportItems
    }
  };
}
