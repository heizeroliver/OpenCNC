import type { Diagnostic, OpenCncDocument, Operation, Point } from "../../core/src/index.js";

const numeric = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replace(/""/g, '"')
    : trimmed;
};

export function splitBppCsv(value: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field.trim());
  return fields;
}

interface ProgramRecord {
  code: string;
  sourceId?: string;
  params: string[];
  line: number;
}

const parseProgramRecord = (line: string, lineNumber: number): ProgramRecord | undefined => {
  const match = line.trim().match(/^@\s*([A-Za-z_]+)\s*,(.*?)\s*:\s*(.*)$/);
  if (!match?.[1]) return undefined;
  const header = splitBppCsv(match[2] ?? "");
  return {
    code: match[1].toUpperCase(),
    ...(header[2] ? { sourceId: unquote(header[2]) } : {}),
    params: splitBppCsv(match[3] ?? "").map(unquote),
    line: lineNumber
  };
};

const point = (x: string | undefined, y: string | undefined, z?: string): Point | undefined => {
  const parsedX = numeric(x);
  const parsedY = numeric(y);
  const parsedZ = numeric(z);
  if (parsedX === undefined || parsedY === undefined) return undefined;
  return { x: parsedX, y: parsedY, ...(parsedZ !== undefined ? { z: parsedZ } : {}) };
};

const repetition = (params: string[]): Operation["repeat"] => {
  const mode = params[8]?.toUpperCase();
  const count = numeric(params[14]);
  if (!mode || mode === "-1" || mode === "RPNO" || count === undefined || count <= 1) return undefined;
  return { count, offset: { x: numeric(params[9]) ?? 0, y: numeric(params[10]) ?? 0 } };
};

const drill = (record: ProgramRecord, index: number): Operation => {
  const position = point(record.params[2], record.params[3], record.params[4]);
  const repeat = repetition(record.params);
  const face = numeric(record.params[0]);
  const depth = numeric(record.params[5]);
  const diameter = numeric(record.params[6]);
  const label = record.params.at(-1);
  return {
    id: record.sourceId || `bpp-${index + 1}`,
    kind: "drill",
    sourceType: record.code,
    ...(face !== undefined ? { face } : {}),
    ...(label ? { label } : {}),
    ...(position ? { position } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(diameter !== undefined ? { diameter } : {}),
    ...(repeat ? { repeat } : {}),
    raw: { code: record.code, sourceId: record.sourceId ?? null, params: record.params, line: record.line }
  };
};

export function parseBpp(input: string, name?: string): OpenCncDocument {
  const diagnostics: Diagnostic[] = [];
  const lines = input.replace(/^\uFEFF/, "").split(/\r?\n/);
  const sectionLines: Record<string, Array<{ line: number; value: string }>> = {};
  const variables: Record<string, string> = {};
  const header: Record<string, string> = {};
  const records: ProgramRecord[] = [];
  let section = "ROOT";

  lines.forEach((original, index) => {
    const line = original.trim();
    const lineNumber = index + 1;
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading?.[1]) {
      section = heading[1].toUpperCase();
      sectionLines[section] ??= [];
      return;
    }
    if (!line || line.startsWith(";") || line.startsWith("//")) return;
    (sectionLines[section] ??= []).push({ line: lineNumber, value: line });
    if (section === "HEADER") {
      const separator = line.indexOf("=");
      if (separator > 0) header[line.slice(0, separator).trim().toUpperCase()] = unquote(line.slice(separator + 1));
    }
    if (section === "VARIABLES") {
      const match = line.match(/^PAN=([^|]+)\|([^|]*)\|/i);
      if (match?.[1]) variables[match[1].trim().toUpperCase()] = unquote(match[2] ?? "");
    }
    if (section === "PROGRAM" && line.startsWith("@")) {
      const record = parseProgramRecord(line, lineNumber);
      if (record) records.push(record);
      else diagnostics.push({ severity: "warning", code: "BPP_RECORD_MALFORMED", message: "Could not parse a BPP program record", location: { line: lineNumber } });
    }
  });

  if (header.TYPE?.toUpperCase() !== "BPP") diagnostics.push({ severity: "warning", code: "BPP_HEADER_MISSING", message: "TYPE=BPP was not found in the header" });
  const width = numeric(variables.LPX);
  const height = numeric(variables.LPY);
  const thickness = numeric(variables.LPZ);
  if (width === undefined || height === undefined) diagnostics.push({ severity: "error", code: "PANEL_SIZE_UNKNOWN", message: "LPX/LPY panel dimensions could not be identified" });

  const operations: Operation[] = [];
  let activeRoute: Operation | undefined;
  for (const record of records) {
    if (record.code === "BG" || record.code === "BV") {
      activeRoute = undefined;
      const operation = drill(record, operations.length);
      if (!operation.position) diagnostics.push({ severity: "error", code: "BPP_DRILL_POSITION_INVALID", message: `Drill ${operation.id} has invalid coordinates`, location: { line: record.line, record: operation.id } });
      operations.push(operation);
      continue;
    }
    if (record.code === "ROUT") {
      const face = numeric(record.params[1]);
      const depth = numeric(record.params[4]);
      const diameter = numeric(record.params[7]);
      const route: Operation = {
        id: record.sourceId || record.params[0] || `bpp-${operations.length + 1}`,
        kind: "route",
        sourceType: record.code,
        ...(face !== undefined ? { face } : {}),
        ...(record.params[89] ? { label: record.params[89] } : {}),
        ...(depth !== undefined ? { depth } : {}),
        ...(diameter !== undefined ? { diameter } : {}),
        path: [],
        raw: { code: record.code, sourceId: record.sourceId ?? null, params: record.params, line: record.line }
      };
      operations.push(route);
      activeRoute = route;
      continue;
    }
    if (record.code === "START_POINT") {
      const start = point(record.params[0], record.params[1], record.params[2]);
      if (activeRoute && start) activeRoute.path = [start];
      else diagnostics.push({ severity: "warning", code: "BPP_ORPHAN_PATH_RECORD", message: "START_POINT was not attached to a valid route", location: { line: record.line } });
      continue;
    }
    if (record.code === "LINE_EP") {
      const end = point(record.params[0], record.params[1], record.params[3] ?? record.params[2]);
      if (activeRoute && end) activeRoute.path = [...(activeRoute.path ?? []), end];
      else diagnostics.push({ severity: "warning", code: "BPP_ORPHAN_PATH_RECORD", message: "LINE_EP was not attached to a valid route", location: { line: record.line } });
      continue;
    }
    if (record.code === "ENDPATH") {
      if (!activeRoute) diagnostics.push({ severity: "warning", code: "BPP_ORPHAN_PATH_RECORD", message: "ENDPATH was not attached to a route", location: { line: record.line } });
      activeRoute = undefined;
      continue;
    }
    const unknown: Operation = { id: record.sourceId || `bpp-${operations.length + 1}`, kind: "unknown", sourceType: record.code, raw: { code: record.code, sourceId: record.sourceId ?? null, params: record.params, line: record.line } };
    operations.push(unknown);
    diagnostics.push({ severity: "info", code: "BPP_OPERATION_UNSUPPORTED", message: `Unsupported BPP operation ${record.code} was preserved`, location: { line: record.line, record: unknown.id } });
  }

  for (const operation of operations.filter(operation => operation.kind === "route" && (operation.path?.length ?? 0) < 2)) diagnostics.push({ severity: "warning", code: "BPP_ROUTE_INCOMPLETE", message: `Route ${operation.id} does not contain a complete path`, location: { record: operation.id } });

  return {
    schemaVersion: "0.1",
    source: { format: "bpp", ...(name ? { name } : {}) },
    panel: { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(thickness !== undefined ? { thickness } : {}), unit: "mm" },
    operations,
    metadata: { type: header.TYPE ?? null, version: header.VER ?? null, variables, sectionNames: Object.keys(sectionLines), programRecordCount: records.length },
    diagnostics
  };
}
