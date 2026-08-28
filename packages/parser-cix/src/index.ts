import type { Diagnostic, OpenCncDocument, Operation, Point } from "../../core/src/index.js";

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
    if (!line || line.startsWith(";") || line.startsWith("//")) return;
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

export function parseCix(input: string, name?: string): OpenCncDocument {
  const parsed = parseCixBlocks(input);
  const diagnostics = [...parsed.diagnostics];
  const mainData = parsed.blocks.find(block => block.type === "MAINDATA")?.values ?? {};
  const macros = parsed.blocks.filter(block => block.type === "MACRO");
  const width = numeric(mainData.LPX);
  const height = numeric(mainData.LPY);
  const thickness = numeric(mainData.LPZ);
  if (width === undefined || height === undefined) diagnostics.push({ severity: "error", code: "PANEL_SIZE_UNKNOWN", message: "LPX/LPY panel dimensions could not be identified in MAINDATA" });
  if (parsed.blocks.length === 0) diagnostics.push({ severity: "error", code: "CIX_STRUCTURE_UNKNOWN", message: "No CIX BEGIN/END blocks were found" });

  const operations: Operation[] = [];
  let activeRoute: Operation | undefined;
  for (const macro of macros) {
    const code = macro.values.NAME?.toUpperCase();
    if (!code) {
      diagnostics.push({ severity: "warning", code: "CIX_MACRO_NAME_MISSING", message: "A MACRO block has no NAME", location: { line: macro.line } });
      continue;
    }
    if (code === "BG" || code === "BV") {
      activeRoute = undefined;
      const position = point(macro.values.X, macro.values.Y, macro.values.Z);
      const repeat = repeatFrom(macro.values);
      const face = numeric(macro.values.SIDE);
      const depth = numeric(macro.values.DP);
      const diameter = numeric(macro.values.DIA);
      const operation: Operation = {
        id: `cix-${operations.length + 1}`,
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
      const diameter = numeric(macro.values.DIA);
      const route: Operation = {
        id: `cix-${operations.length + 1}`,
        kind: "route",
        sourceType: code,
        ...(face !== undefined ? { face } : {}),
        ...(macro.values.LAY ? { label: macro.values.LAY } : {}),
        ...(depth !== undefined ? { depth } : {}),
        ...(diameter !== undefined ? { diameter } : {}),
        path: [],
        raw: { code, params: macro.values, line: macro.line }
      };
      operations.push(route);
      activeRoute = route;
      continue;
    }
    if (code === "START_POINT") {
      const start = point(macro.values.X, macro.values.Y, macro.values.Z);
      if (activeRoute && start) activeRoute.path = [start];
      else diagnostics.push({ severity: "warning", code: "CIX_ORPHAN_PATH_MACRO", message: "START_POINT was not attached to a valid route", location: { line: macro.line } });
      continue;
    }
    if (code === "LINE_EP") {
      const end = point(macro.values.XE, macro.values.YE, macro.values.ZE ?? macro.values.ZS);
      if (activeRoute && end) activeRoute.path = [...(activeRoute.path ?? []), end];
      else diagnostics.push({ severity: "warning", code: "CIX_ORPHAN_PATH_MACRO", message: "LINE_EP was not attached to a valid route", location: { line: macro.line } });
      continue;
    }
    if (code === "ENDPATH") {
      if (!activeRoute) diagnostics.push({ severity: "warning", code: "CIX_ORPHAN_PATH_MACRO", message: "ENDPATH was not attached to a route", location: { line: macro.line } });
      activeRoute = undefined;
      continue;
    }
    const unknown: Operation = { id: `cix-${operations.length + 1}`, kind: "unknown", sourceType: code, raw: { code, params: macro.values, line: macro.line } };
    operations.push(unknown);
    diagnostics.push({ severity: "info", code: "CIX_OPERATION_UNSUPPORTED", message: `Unsupported CIX macro ${code} was preserved`, location: { line: macro.line, record: unknown.id } });
  }

  for (const operation of operations.filter(operation => operation.kind === "route" && (operation.path?.length ?? 0) < 2)) diagnostics.push({ severity: "warning", code: "CIX_ROUTE_INCOMPLETE", message: `Route ${operation.id} does not contain a complete path`, location: { record: operation.id } });

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
    metadata: { dialect: "CIX text macro", mainData, blockCount: parsed.blocks.length, macroCounts },
    diagnostics
  };
}
