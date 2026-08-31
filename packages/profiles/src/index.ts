import { operationPoints, type OpenCncDocument, type OperationKind, type SourceFormat } from "../../core/src/index.js";

export type ProfileConfidence = "verified-corpus" | "observed-compatible" | "ambiguous" | "unknown";
export type DialectProfileId = "biesse-bpp-v150-observed" | "biesse-bpp-generic" | "biesse-cix-text-macro-observed" | "biesse-cix-generic";

export interface DialectProfile {
  id: DialectProfileId;
  label: string;
  format: SourceFormat;
  version?: string;
  recordShapes: string[];
  conventions: string[];
  supportedOperations: OperationKind[];
  quirks: string[];
  conversionTarget: DialectProfileId;
}

export interface DialectDetection {
  profileId: DialectProfileId;
  format: SourceFormat;
  version?: string;
  exporterSignature?: string;
  confidence: ProfileConfidence;
  reasons: string[];
  warnings: string[];
}

const PROFILES: Record<DialectProfileId, DialectProfile> = {
  "biesse-bpp-v150-observed": {
    id: "biesse-bpp-v150-observed", label: "Biesse BPP v150 (observed)", format: "bpp", version: "150",
    recordShapes: ["BG", "BV", "ROUT", "START_POINT", "LINE_EP", "ARC_EPCE", "ENDPATH"],
    conventions: ["millimetres", "numeric SIDE face", "BPP positional records"],
    supportedOperations: ["drill", "route"], quirks: ["Parameter positions are profile-specific", "Counter-clockwise 11-field ARC_EPCE is paired-corpus verified", "Unknown records are preserved but not executed"],
    conversionTarget: "biesse-cix-text-macro-observed"
  },
  "biesse-bpp-generic": {
    id: "biesse-bpp-generic", label: "Biesse BPP family (generic)", format: "bpp",
    recordShapes: [], conventions: ["BPP sections and positional records"], supportedOperations: ["drill", "route"],
    quirks: ["Version or exporter signature was not identified"], conversionTarget: "biesse-cix-text-macro-observed"
  },
  "biesse-cix-text-macro-observed": {
    id: "biesse-cix-text-macro-observed", label: "Biesse CIX text macro (observed)", format: "cix",
    recordShapes: ["MAINDATA", "MACRO", "BG", "BV", "ROUT", "START_POINT", "LINE_EP", "ARC_EPCE", "ENDPATH"],
    conventions: ["millimetres", "named macro parameters", "numeric SIDE face"],
    supportedOperations: ["drill", "route", "geometry", "pocket", "saw", "groove"],
    quirks: ["Counter-clockwise center/end ARC_EPCE is paired-corpus verified", "Other advanced operations are preview-only until corpus-verified"], conversionTarget: "biesse-bpp-v150-observed"
  },
  "biesse-cix-generic": {
    id: "biesse-cix-generic", label: "Biesse CIX family (generic)", format: "cix",
    recordShapes: [], conventions: ["CIX block structure"], supportedOperations: ["drill", "route"],
    quirks: ["Macro dialect or exporter signature was not identified"], conversionTarget: "biesse-bpp-v150-observed"
  }
};

export const dialectProfiles = (): DialectProfile[] => Object.values(PROFILES);
export const dialectProfile = (id: DialectProfileId): DialectProfile => PROFILES[id];

const recordShapes = (document: OpenCncDocument): string[] => {
  const value = document.metadata.recordShapes;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
};

export function detectDialect(document: OpenCncDocument): DialectDetection {
  const shapes = recordShapes(document);
  if (document.source.format === "bpp") {
    const version = typeof document.metadata.version === "string" ? document.metadata.version : undefined;
    const observed = version === "150" && shapes.some(shape => ["BG", "BV", "ROUT"].includes(shape));
    return {
      profileId: observed ? "biesse-bpp-v150-observed" : "biesse-bpp-generic",
      format: "bpp", ...(version ? { version } : {}), confidence: observed ? "observed-compatible" : "ambiguous",
      reasons: [version ? `Header version ${version}` : "No header version", shapes.length ? `Records: ${shapes.join(", ")}` : "No program record signature"],
      warnings: observed ? ["Observed-compatible, not a vendor-certified postprocessor profile"] : ["Select an explicit BPP profile before relying on parameter positions"]
    };
  }
  const mainData = document.metadata.mainData;
  const signature = mainData && typeof mainData === "object" && !Array.isArray(mainData)
    ? ["REL", "TECHNOLOGY", "AUTHOR", "MACHINE"].map(key => (mainData as Record<string, unknown>)[key]).find(value => typeof value === "string") as string | undefined
    : undefined;
  const observed = document.metadata.dialect === "CIX text macro" && typeof document.metadata.blockCount === "number" && document.metadata.blockCount > 0;
  return {
    profileId: observed ? "biesse-cix-text-macro-observed" : "biesse-cix-generic", format: "cix",
    ...(signature ? { exporterSignature: signature } : {}), confidence: observed ? "observed-compatible" : "ambiguous",
    reasons: [observed ? "BEGIN/END text-macro structure" : "Generic CIX structure", shapes.length ? `Records: ${shapes.join(", ")}` : "No macro signature"],
    warnings: observed ? ["Observed-compatible, not a vendor-certified postprocessor profile"] : ["Select an explicit CIX profile before relying on macro semantics"]
  };
}

export type MachineToolKind = "drill" | "router" | "saw";
export interface MachineTool { id?: string; diameter: number; kind: MachineToolKind; maxDepth?: number; toolClass?: string; minRpm?: number; maxRpm?: number }
export interface MachineProfile {
  schemaVersion: "0.1";
  id: string;
  name: string;
  travel: { minX: number; maxX: number; minY: number; maxY: number; minZ?: number; maxZ?: number };
  supportedFaces: number[];
  availableTools?: MachineTool[];
  maxDrillDepth?: number;
  maxRouteDepth?: number;
  maxSawDepth?: number;
  drillBank?: { supportedDiameters?: number[]; faces?: number[] };
  spindle?: { minRpm?: number; maxRpm?: number };
  notes?: string;
}

export interface MachineCheck {
  severity: "info" | "warning";
  code: string;
  message: string;
  operationId?: string;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export function validateMachineProfile(profile: MachineProfile): string[] {
  const issues: string[] = [];
  if (profile.schemaVersion !== "0.1") issues.push("schemaVersion must be 0.1");
  if (!profile.id.trim() || !profile.name.trim()) issues.push("id and name are required");
  const { minX, maxX, minY, maxY, minZ, maxZ } = profile.travel;
  if (![minX, maxX, minY, maxY].every(finite) || minX >= maxX || minY >= maxY) issues.push("travel X/Y ranges must be finite and increasing");
  if ((minZ !== undefined || maxZ !== undefined) && (!finite(minZ) || !finite(maxZ) || minZ >= maxZ)) issues.push("travel Z range must be complete and increasing");
  if (!Array.isArray(profile.supportedFaces) || profile.supportedFaces.some(face => !finite(face))) issues.push("supportedFaces must contain finite numbers");
  if (profile.availableTools?.some(tool => !finite(tool.diameter) || tool.diameter <= 0)) issues.push("tool diameters must be positive finite numbers");
  return issues;
}

const rawParameters = (operation: OpenCncDocument["operations"][number]): Record<string, unknown> => {
  const params = operation.raw.params;
  return params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
};
const parameterNumber = (operation: OpenCncDocument["operations"][number], ...keys: string[]): number | undefined => {
  const params = rawParameters(operation);
  for (const key of keys) {
    const value = params[key];
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.replace(",", ".")) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

export function checkDocumentAgainstMachine(document: OpenCncDocument, profile: MachineProfile): MachineCheck[] {
  const profileIssues = validateMachineProfile(profile);
  if (profileIssues.length) return profileIssues.map(message => ({ severity: "warning", code: "MACHINE_PROFILE_INVALID", message }));
  const checks: MachineCheck[] = [];
  const { minX, maxX, minY, maxY, minZ, maxZ } = profile.travel;
  if ((document.panel.width ?? 0) > maxX - minX || (document.panel.height ?? 0) > maxY - minY) checks.push({ severity: "warning", code: "MACHINE_PANEL_EXCEEDS_TRAVEL", message: `Panel ${document.panel.width ?? "?"} × ${document.panel.height ?? "?"} mm exceeds the configured X/Y travel envelope` });
  for (const operation of document.operations) {
    const points = operationPoints(operation);
    if (points.some(point => point.x < minX || point.x > maxX || point.y < minY || point.y > maxY || (point.z !== undefined && ((minZ !== undefined && point.z < minZ) || (maxZ !== undefined && point.z > maxZ))))) {
      checks.push({ severity: "warning", code: "MACHINE_OPERATION_OUTSIDE_TRAVEL", message: `${operation.sourceType} ${operation.id} reaches outside configured travel`, operationId: operation.id });
    }
    if (operation.face !== undefined && !profile.supportedFaces.includes(operation.face)) checks.push({ severity: "warning", code: "MACHINE_FACE_UNSUPPORTED", message: `Face ${operation.face} is not enabled in this profile`, operationId: operation.id });
    const maxDepth = operation.kind === "drill" ? profile.maxDrillDepth : operation.kind === "route" || operation.kind === "pocket" || operation.kind === "groove" ? profile.maxRouteDepth : operation.kind === "saw" || operation.kind === "cut" ? profile.maxSawDepth : undefined;
    if (operation.depth !== undefined && maxDepth !== undefined && operation.depth > maxDepth) checks.push({ severity: "warning", code: "MACHINE_DEPTH_EXCEEDS_PROFILE", message: `${operation.depth} mm depth exceeds the configured ${maxDepth} mm limit`, operationId: operation.id });
    const toolKind: MachineToolKind | undefined = operation.kind === "drill" ? "drill" : operation.kind === "route" || operation.kind === "pocket" || operation.kind === "groove" ? "router" : operation.kind === "saw" || operation.kind === "cut" ? "saw" : undefined;
    if (toolKind && operation.diameter !== undefined && profile.availableTools?.length) {
      const matches = profile.availableTools.filter(tool => tool.kind === toolKind && Math.abs(tool.diameter - operation.diameter!) <= 0.001);
      if (!matches.length) checks.push({ severity: "warning", code: "MACHINE_TOOL_NOT_FOUND", message: `No ${toolKind} tool with ${operation.diameter} mm diameter is configured`, operationId: operation.id });
      else if (operation.depth !== undefined && matches.every(tool => tool.maxDepth !== undefined && operation.depth! > tool.maxDepth)) checks.push({ severity: "warning", code: "MACHINE_TOOL_DEPTH_EXCEEDED", message: `Configured ${operation.diameter} mm tool depth is insufficient`, operationId: operation.id });
    }
    if (operation.kind === "drill" && operation.diameter !== undefined && profile.drillBank?.supportedDiameters?.length && !profile.drillBank.supportedDiameters.some(diameter => Math.abs(diameter - operation.diameter!) <= 0.001)) checks.push({ severity: "warning", code: "MACHINE_DRILL_BANK_DIAMETER_UNSUPPORTED", message: `${operation.diameter} mm is not in the configured drill bank`, operationId: operation.id });
    if (operation.kind === "drill" && operation.face !== undefined && profile.drillBank?.faces?.length && !profile.drillBank.faces.includes(operation.face)) checks.push({ severity: "warning", code: "MACHINE_DRILL_BANK_FACE_UNSUPPORTED", message: `Face ${operation.face} is not served by the configured drill bank`, operationId: operation.id });
    const rpm = parameterNumber(operation, "RPM", "RSP", "SPINDLE_SPEED");
    if (rpm !== undefined && ((profile.spindle?.minRpm !== undefined && rpm < profile.spindle.minRpm) || (profile.spindle?.maxRpm !== undefined && rpm > profile.spindle.maxRpm))) checks.push({ severity: "warning", code: "MACHINE_SPINDLE_RANGE_EXCEEDED", message: `${rpm} RPM is outside the configured spindle range`, operationId: operation.id });
  }
  checks.push({ severity: "info", code: "MACHINE_PREFLIGHT_ADVISORY", message: "Profile checks are advisory; collision, clamping, postprocessor, and controller behavior require vendor simulation" });
  return checks;
}
