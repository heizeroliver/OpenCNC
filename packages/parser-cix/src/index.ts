import type { Diagnostic, OpenCncDocument, Operation, PathSegment, Point } from "../../core/src/index.js";

interface CixBlock {
  type: string;
  identifier?: string;
  line: number;
  values: Record<string, string>;
}

const unquote = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).replace(/""/g, '"') : trimmed;
};

const numeric = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(unquote(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const point = (x: string | undefined, y: string | undefined, z?: string): Point | undefined => {
  const parsedX = numeric(x);
  const parsedY = numeric(y);
  const parsedZ = numeric(z);
  if (parsedX === undefined || parsedY === undefined) return undefined;
  return { x: parsedX, y: parsedY, ...(parsedZ !== undefined ? { z: parsedZ } : {}) };
};

export function parseCixBlocks(input: string): { blocks: CixBlock[]; diagnostics: Diagnostic[] } {
  const blocks: CixBlock[] = [];
  const diagnostics: Diagnostic[] = [];
  let active: CixBlock | undefined;
  input.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((original, index) => {
    const line = original.trim();
    const lineNumber = index + 1;
    if (!line) return;
    const preservedWait = line.match(/^;\s*OPENCNC-PRESERVED-WAIT\s+(.+)$/i);
    if (preservedWait?.[1]) {
      try {
        const value: unknown = JSON.parse(decodeURIComponent(preservedWait[1]));
        if (!value || typeof value !== "object") throw new Error("Invalid preserved WAIT payload");
        const candidate = value as { id?: unknown; params?: unknown };
        if (typeof candidate.id !== "string" || !Array.isArray(candidate.params) || !candidate.params.every(parameter => typeof parameter === "string")) throw new Error("Invalid preserved WAIT fields");
        blocks.push({ type: "OPENCNC_PRESERVED_WAIT", identifier: candidate.id, line: lineNumber, values: { PARAMS: JSON.stringify(candidate.params) } });
      } catch {
        diagnostics.push({ severity: "warning", code: "CIX_PRESERVED_WAIT_MALFORMED", message: "An OpenCNC-preserved WAIT record could not be decoded", location: { line: lineNumber } });
      }
      return;
    }
    if (line.startsWith(";") || line.startsWith("//")) return;
    const begin = line.match(/^BEGIN\s+([^\s]+)(?:\s+(.+))?$/i);
    if (begin?.[1]) {
      if (active) diagnostics.push({ severity: "error", code: "CIX_NESTED_BLOCK", message: `Block ${begin[1]} began before ${active.type} ended`, location: { line: lineNumber } });
      active = { type: begin[1].toUpperCase(), ...(begin[2] ? { identifier: begin[2].trim() } : {}), line: lineNumber, values: {} };
      return;
    }
    const end = line.match(/^END\s+([^\s]+)$/i);
    if (end?.[1]) {
      if (!active || active.type !== end[1].toUpperCase()) diagnostics.push({ severity: "error", code: "CIX_BLOCK_MISMATCH", message: `Unexpected ${line}`, location: { line: lineNumber } });
      else blocks.push(active);
      active = undefined;
      return;
    }
    if (!active) {
      diagnostics.push({ severity: "info", code: "CIX_TOP_LEVEL_RECORD", message: "A top-level record was preserved but not interpreted", location: { line: lineNumber } });
      return;
    }
    const parameter = line.match(/^PARAM,NAME=([^,]+),VALUE=(.*)$/i);
    if (parameter?.[1]) {
      active.values[parameter[1].trim().toUpperCase()] = unquote(parameter[2] ?? "");
      return;
    }
    const separator = line.indexOf("=");
    if (separator > 0) active.values[line.slice(0, separator).trim().toUpperCase()] = unquote(line.slice(separator + 1));
    else diagnostics.push({ severity: "info", code: "CIX_BLOCK_RECORD_UNSUPPORTED", message: `A record in ${active.type} was preserved but not interpreted`, location: { line: lineNumber } });
  });
  if (active) diagnostics.push({ severity: "error", code: "CIX_BLOCK_UNCLOSED", message: `Block ${active.type} was not closed`, location: { line: active.line } });
  return { blocks, diagnostics };
}

const repeatFrom = (values: Record<string, string>): Operation["repeat"] => {
  const mode = values.RTY?.toUpperCase();
  const count = numeric(values.NRP);
  if (!mode || mode === "RPNO" || count === undefined || count <= 1) return undefined;
  return { count, offset: { x: numeric(values.DX) ?? 0, y: numeric(values.DY) ?? 0 } };
};

const operationId = (values: Record<string, string>, index: number): string => values.ID || values.GID || `cix-${index + 1}`;
const pathSupport = (note: string): NonNullable<Operation["support"]> => ({ stage: "validated", geometry: "exact", conversion: false, note });
const preservedSupport = (note: string): NonNullable<Operation["support"]> => ({ stage: "preserved", geometry: "none", conversion: false, note });
const observedToolDiameter = (toolName: string | undefined): number | undefined => {
  const normalized = toolName?.trim().toUpperCase();
  if (normalized === "KILINCSM") return 18;
  return undefined;
};
const direction = (value: string | undefined): boolean | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  if (["1", "CW", "DIRCW", "CLOCKWISE"].includes(normalized)) return true;
  if (["-1", "0", "CCW", "DIRCCW", "COUNTERCLOCKWISE"].includes(normalized)) return false;
  return undefined;
};

const appendLine = (operation: Operation, end: Point): void => {
  const start = operation.path?.at(-1);
  if (!start) return;
  operation.path = [...(operation.path ?? []), end];
  operation.segments = [...(operation.segments ?? []), { kind: "line", start, end }];
};

const appendArc = (operation: Operation, end: Point, values: Record<string, string>, code: string): boolean => {
  const start = operation.path?.at(-1);
  if (!start) return false;
  const center = point(values.XC ?? values.X0, values.YC ?? values.Y0, values.ZC);
  const via = point(values.X2 ?? values.XM ?? values.XI, values.Y2 ?? values.YM ?? values.YI, values.Z2 ?? values.ZM ?? values.ZI);
  const radius = numeric(values.R ?? values.RAD ?? values.RADIUS);
  const segment: PathSegment = {
    kind: "arc", start, end,
    ...(center ? { center } : {}), ...(via ? { via } : {}), ...(radius !== undefined ? { radius: Math.abs(radius) } : {}),
    ...(direction(values.DIR ?? values.CW ?? values.SENSE) !== undefined ? { clockwise: direction(values.DIR ?? values.CW ?? values.SENSE)! } : {})
  };
  if (!segment.center && !segment.via && segment.radius === undefined) return false;
  operation.path = [...(operation.path ?? []), end];
  operation.segments = [...(operation.segments ?? []), segment];
  operation.raw = { ...operation.raw, pathMacros: [...(Array.isArray(operation.raw.pathMacros) ? operation.raw.pathMacros : []), { code, params: values }] };
  return true;
};

const rectanglePath = (values: Record<string, string>): Point[] | undefined => {
  const center = point(values.XC ?? values.X, values.YC ?? values.Y, values.ZC ?? values.Z);
  const width = numeric(values.L ?? values.LX ?? values.DX);
  const height = numeric(values.H ?? values.LY ?? values.DY);
  if (!center || width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  const angle = (numeric(values.A ?? values.ANGLE) ?? 0) * Math.PI / 180;
  const rotate = (x: number, y: number): Point => ({ x: center.x + x * Math.cos(angle) - y * Math.sin(angle), y: center.y + x * Math.sin(angle) + y * Math.cos(angle), ...(center.z !== undefined ? { z: center.z } : {}) });
  const corners = [rotate(-width / 2, -height / 2), rotate(width / 2, -height / 2), rotate(width / 2, height / 2), rotate(-width / 2, height / 2)];
  return [...corners, corners[0]!];
};

export function parseCix(input: string, name?: string): OpenCncDocument {
  const parsed = parseCixBlocks(input);
  const diagnostics = [...parsed.diagnostics];
  const mainData = parsed.blocks.find(block => block.type === "MAINDATA")?.values ?? {};
  const macros = parsed.blocks.filter(block => block.type === "MACRO");
  const operationBlocks = parsed.blocks.filter(block => block.type === "MACRO" || block.type === "OPENCNC_PRESERVED_WAIT");
  const width = numeric(mainData.LPX);
  const height = numeric(mainData.LPY);
  const thickness = numeric(mainData.LPZ);
  if (width === undefined || height === undefined) diagnostics.push({ severity: "error", code: "PANEL_SIZE_UNKNOWN", message: "LPX/LPY panel dimensions could not be identified in MAINDATA" });
  if (parsed.blocks.length === 0) diagnostics.push({ severity: "error", code: "CIX_STRUCTURE_UNKNOWN", message: "No CIX BEGIN/END blocks were found" });

  const operations: Operation[] = [];
  let activePath: Operation | undefined;
  const geometryById = new Map<string, Operation>();
  for (const macro of operationBlocks) {
    if (macro.type === "OPENCNC_PRESERVED_WAIT") {
      const params = JSON.parse(macro.values.PARAMS ?? "[]") as string[];
      const operation: Operation = { id: macro.identifier ?? `cix-${operations.length + 1}`, kind: "unknown", sourceType: "WAIT", raw: { code: "WAIT", sourceId: macro.identifier ?? null, params, line: macro.line, preservation: "non-executing-comment" } };
      operations.push(operation);
      diagnostics.push({ severity: "info", code: "CIX_WAIT_PRESERVED_AS_METADATA", message: `WAIT ${operation.id} is preserved as non-executing OpenCNC metadata`, location: { line: macro.line, record: operation.id } });
      continue;
    }
    const code = macro.values.NAME?.toUpperCase();
    if (!code) {
      diagnostics.push({ severity: "warning", code: "CIX_MACRO_NAME_MISSING", message: "A MACRO block has no NAME", location: { line: macro.line } });
      continue;
    }
    if (code === "BG" || code === "BV") {
      activePath = undefined;
      const position = point(macro.values.X, macro.values.Y, macro.values.Z);
      const repeat = repeatFrom(macro.values);
      const face = numeric(macro.values.SIDE);
      const depth = numeric(macro.values.DP);
      const diameter = numeric(macro.values.DIA);
      const operation: Operation = {
        id: operationId(macro.values, operations.length),
        kind: "drill",
        sourceType: code,
        ...(face !== undefined ? { face } : {}),
        ...(macro.values.LAY ? { label: macro.values.LAY } : {}),
        ...(position ? { position } : {}),
        ...(depth !== undefined ? { depth } : {}),
        ...(diameter !== undefined ? { diameter } : {}),
        ...(repeat ? { repeat } : {}),
        raw: { code, params: macro.values, line: macro.line }
      };
      if (!position) diagnostics.push({ severity: "error", code: "CIX_DRILL_POSITION_INVALID", message: `Drill ${operation.id} has invalid coordinates`, location: { line: macro.line, record: operation.id } });
      operations.push(operation);
      continue;
    }
    if (code === "ROUT") {
      const face = numeric(macro.values.SIDE);
      const depth = numeric(macro.values.DP);
      const explicitDiameter = numeric(macro.values.DIA);
      const inferredDiameter = explicitDiameter === undefined ? observedToolDiameter(macro.values.TNM) : undefined;
      const diameter = explicitDiameter ?? inferredDiameter;
      const route: Operation = {
        id: operationId(macro.values, operations.length),
        kind: "route",
        sourceType: code,
        ...(face !== undefined ? { face } : {}),
        ...(macro.values.LAY ? { label: macro.values.LAY } : {}),
        ...(depth !== undefined ? { depth } : {}),
        ...(diameter !== undefined ? { diameter } : {}),
        path: [], segments: [],
        support: { stage: "verified-conversion", geometry: "exact", conversion: true },
        raw: { code, params: macro.values, line: macro.line, ...(inferredDiameter !== undefined ? { inferredDiameterFromTool: macro.values.TNM, inferredDiameterEvidence: "paired-biesseworks-bpp" } : {}) }
      };
      operations.push(route);
      if (inferredDiameter !== undefined) diagnostics.push({ severity: "info", code: "CIX_TOOL_DIAMETER_INFERRED", message: `Route ${route.id} uses the observed ${macro.values.TNM} tool profile (${inferredDiameter} mm) because DIA is absent`, location: { line: macro.line, record: route.id } });
      activePath = route;
      continue;
    }
    if (code === "GEO") {
      const face = numeric(macro.values.SIDE);
      const geometry: Operation = {
        id: operationId(macro.values, operations.length), kind: "geometry", sourceType: code,
        ...(face !== undefined ? { face } : {}), ...(macro.values.LAY ? { label: macro.values.LAY } : {}),
        path: [], segments: [], support: pathSupport("Geometry definition is parsed and rendered; serialization is intentionally disabled"),
        raw: { code, params: macro.values, line: macro.line }
      };
      operations.push(geometry);
      geometryById.set(geometry.id, geometry);
      if (macro.values.ID) geometryById.set(macro.values.ID, geometry);
      if (macro.values.GID) geometryById.set(macro.values.GID, geometry);
      activePath = geometry;
      continue;
    }
    if (code === "START_POINT") {
      const start = point(macro.values.X, macro.values.Y, macro.values.Z);
      if (activePath && start) { activePath.path = [start]; activePath.segments = []; }
      else diagnostics.push({ severity: "warning", code: "CIX_ORPHAN_PATH_MACRO", message: "START_POINT was not attached to a valid path operation", location: { line: macro.line } });
      continue;
    }
    if (code === "LINE_EP") {
      const end = point(macro.values.XE, macro.values.YE, macro.values.ZE ?? macro.values.ZS);
      if (activePath && end && activePath.path?.length) appendLine(activePath, end);
      else diagnostics.push({ severity: "warning", code: "CIX_ORPHAN_PATH_MACRO", message: "LINE_EP was not attached to a valid path", location: { line: macro.line } });
      continue;
    }
    if (code === "ARC_EPCE" || code === "ARC_EPRA" || code === "ARC_IPEP") {
      const end = point(macro.values.XE ?? macro.values.X3, macro.values.YE ?? macro.values.Y3, macro.values.ZE ?? macro.values.Z3);
      if (!activePath || !end || !appendArc(activePath, end, macro.values, code)) diagnostics.push({ severity: "warning", code: "CIX_ARC_INCOMPLETE", message: `${code} was preserved but did not contain enough numeric geometry`, location: { line: macro.line } });
      continue;
    }
    if (code === "RECTANGLE") {
      const path = rectanglePath(macro.values);
      if (activePath && path) {
        activePath.path = path;
        activePath.segments = path.slice(1).map((end, index) => ({ kind: "line", start: path[index]!, end }));
      } else diagnostics.push({ severity: "warning", code: "CIX_RECTANGLE_INCOMPLETE", message: "RECTANGLE was preserved but did not contain enough numeric geometry", location: { line: macro.line } });
      continue;
    }
    if (code === "ENDPATH") {
      if (!activePath) diagnostics.push({ severity: "warning", code: "CIX_ORPHAN_PATH_MACRO", message: "ENDPATH was not attached to a path", location: { line: macro.line } });
      activePath = undefined;
      continue;
    }
    if (code === "ROUTG" || code === "PKT1" || code === "POCK") {
      activePath = undefined;
      const reference = macro.values.GID ?? macro.values.IDG ?? macro.values.GEO;
      const geometry = reference ? geometryById.get(reference) : undefined;
      const face = numeric(macro.values.SIDE);
      const depth = numeric(macro.values.DP);
      const diameter = numeric(macro.values.DIA);
      const operation: Operation = {
        id: operationId(macro.values, operations.length), kind: code === "ROUTG" ? "route" : "pocket", sourceType: code,
        ...(face !== undefined ? { face } : {}), ...(depth !== undefined ? { depth } : {}), ...(diameter !== undefined ? { diameter } : {}),
        ...(reference ? { geometryRef: reference } : {}), ...(geometry?.path ? { path: geometry.path.map(value => ({ ...value })) } : {}),
        ...(geometry?.segments ? { segments: geometry.segments.map(segment => ({ ...segment, start: { ...segment.start }, end: { ...segment.end } })) } : {}),
        support: geometry ? pathSupport(`${code} references geometry ${reference}; conversion remains disabled until paired-corpus verification`) : preservedSupport(`${code} geometry reference could not be resolved`),
        raw: { code, params: macro.values, line: macro.line }
      };
      operations.push(operation);
      if (!geometry) diagnostics.push({ severity: "warning", code: "CIX_GEOMETRY_REFERENCE_UNRESOLVED", message: `${code} ${operation.id} references missing geometry ${reference ?? "(unspecified)"}`, location: { line: macro.line, record: operation.id } });
      continue;
    }
    if (["CUT_X", "CUT_Y", "GUT_X", "GUT_Y", "GUT_G", "GUT_GEO", "GUT_F", "GUT_FR"].includes(code)) {
      activePath = undefined;
      const start = point(macro.values.X ?? macro.values.XS, macro.values.Y ?? macro.values.YS, macro.values.Z ?? macro.values.ZS);
      const explicitEnd = point(macro.values.XE, macro.values.YE, macro.values.ZE);
      const length = numeric(macro.values.L ?? macro.values.LEN);
      const end = explicitEnd ?? (start && length !== undefined ? { x: start.x + (code.includes("_X") ? length : 0), y: start.y + (code.includes("_Y") ? length : 0), ...(start.z !== undefined ? { z: start.z } : {}) } : undefined);
      const face = numeric(macro.values.SIDE);
      const depth = numeric(macro.values.DP);
      const diameter = numeric(macro.values.DIA ?? macro.values.W);
      const operation: Operation = {
        id: operationId(macro.values, operations.length), kind: code.startsWith("GUT") ? "groove" : "saw", sourceType: code,
        ...(face !== undefined ? { face } : {}), ...(depth !== undefined ? { depth } : {}), ...(diameter !== undefined ? { diameter } : {}),
        ...(start && end ? { path: [start, end], segments: [{ kind: "line", start, end }] } : {}),
        support: start && end ? pathSupport(`${code} is rendered as an advisory linear cut`) : preservedSupport(`${code} parameters were preserved without inferred geometry`),
        raw: { code, params: macro.values, line: macro.line }
      };
      operations.push(operation);
      continue;
    }
    const unknown: Operation = { id: `cix-${operations.length + 1}`, kind: "unknown", sourceType: code, raw: { code, params: macro.values, line: macro.line } };
    operations.push(unknown);
    diagnostics.push({ severity: "info", code: "CIX_OPERATION_UNSUPPORTED", message: `Unsupported CIX macro ${code} was preserved`, location: { line: macro.line, record: unknown.id } });
  }

  for (const operation of operations.filter(operation => operation.kind === "route" && (operation.path?.length ?? 0) < 2)) diagnostics.push({ severity: "warning", code: "CIX_ROUTE_INCOMPLETE", message: `Route ${operation.id} does not contain a complete path`, location: { record: operation.id } });
  const advanced = operations.filter(operation => operation.support && !operation.support.conversion);
  if (advanced.length) diagnostics.push({ severity: "info", code: "CIX_ADVANCED_OPERATIONS_PREVIEW_ONLY", message: `${advanced.length} advanced operation(s) were preserved for preview and validation; conversion remains disabled until paired-corpus verification` });
  const expressionCount = input.split(/\r?\n/).filter(original => {
    const line = original.trim();
    return Boolean(line && !line.startsWith(";") && !line.startsWith("//") && (/^(IF|ELSE|ENDIF|FOR|NEXT)\b/i.test(line) || /\bVBSCRIPT\b/i.test(line) || /VALUE\s*=\s*(IF\b|[$%][A-Za-z_])/i.test(line)));
  }).length;
  if (expressionCount) diagnostics.push({ severity: "info", code: "CIX_EXPRESSIONS_PRESERVED", message: `${expressionCount} expression or conditional record(s) were preserved without execution` });

  const macroCounts: Record<string, number> = {};
  for (const macro of macros) {
    const code = macro.values.NAME?.toUpperCase() ?? "(missing)";
    macroCounts[code] = (macroCounts[code] ?? 0) + 1;
  }
  return {
    schemaVersion: "0.1",
    source: { format: "cix", ...(name ? { name } : {}) },
    panel: { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(thickness !== undefined ? { thickness } : {}), unit: "mm" },
    operations,
    metadata: { dialect: "CIX text macro", mainData, blockCount: parsed.blocks.length, macroCounts, recordShapes: [...new Set(parsed.blocks.map(block => block.type === "MACRO" ? block.values.NAME?.toUpperCase() ?? "MACRO" : block.type))], expressionCount },
    diagnostics
  };
}
