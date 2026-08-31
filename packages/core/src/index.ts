export type SourceFormat = "bpp" | "cix";
export type Severity = "info" | "warning" | "error";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  location?: { line?: number; record?: string };
}

export interface Point { x: number; y: number; z?: number }

export type OperationKind = "drill" | "route" | "geometry" | "pocket" | "saw" | "groove" | "tool-change" | "transform" | "cut" | "unknown";
export type OperationSupportStage = "preserved" | "preview" | "validated" | "experimental-conversion" | "verified-conversion";

export interface LineSegment {
  kind: "line";
  start: Point;
  end: Point;
}

export interface ArcSegment {
  kind: "arc";
  start: Point;
  end: Point;
  center?: Point;
  via?: Point;
  radius?: number;
  clockwise?: boolean;
}

export type PathSegment = LineSegment | ArcSegment;

export interface OperationSupport {
  stage: OperationSupportStage;
  geometry: "exact" | "partial" | "none";
  conversion: boolean;
  note?: string;
}

export interface Panel {
  width?: number;
  height?: number;
  thickness?: number;
  unit: "mm" | "inch" | "unknown";
}

export interface Operation {
  id: string;
  kind: OperationKind;
  sourceType: string;
  face?: number;
  label?: string;
  position?: Point;
  depth?: number;
  diameter?: number;
  path?: Point[];
  segments?: PathSegment[];
  geometryRef?: string;
  support?: OperationSupport;
  repeat?: { count: number; offset: Point };
  raw: Record<string, unknown>;
}

export interface OpenCncDocument {
  schemaVersion: "0.1";
  source: { format: SourceFormat; name?: string };
  panel: Panel;
  operations: Operation[];
  metadata: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

const MAX_EXPANDED_POINTS = 100_000;

export function operationPoints(operation: Operation): Point[] {
  if (!operation.position) {
    const points = operation.path ?? [];
    if (!operation.segments?.length) return points;
    const segmentPoints = operation.segments.flatMap(segment => segment.kind === "arc" && segment.via
      ? [segment.start, segment.via, segment.end]
      : [segment.start, segment.end]);
    return [...points, ...segmentPoints].filter((point, index, all) => all.findIndex(candidate => candidate.x === point.x && candidate.y === point.y && (candidate.z ?? 0) === (point.z ?? 0)) === index);
  }
  if (!operation.repeat || operation.repeat.count <= 1) return [operation.position];
  const count = Math.min(operation.repeat.count, MAX_EXPANDED_POINTS);
  return Array.from({ length: count }, (_, index) => ({
    x: operation.position!.x + operation.repeat!.offset.x * index,
    y: operation.position!.y + operation.repeat!.offset.y * index,
    ...(operation.position!.z !== undefined
      ? { z: operation.position!.z + (operation.repeat!.offset.z ?? 0) * index }
      : {})
  }));
}

export function validateDocument(document: OpenCncDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { width, height, thickness } = document.panel;
  for (const [name, value] of Object.entries({ width, height, thickness })) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      diagnostics.push({ severity: "error", code: "INVALID_PANEL_DIMENSION", message: `${name} must be a positive finite number` });
    }
  }
  for (const operation of document.operations) {
    const points = operationPoints(operation);
    if (points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) {
      diagnostics.push({ severity: "error", code: "INVALID_OPERATION_COORDINATE", message: `Operation ${operation.id} contains a non-finite coordinate`, location: { record: operation.id } });
    } else if (width !== undefined && height !== undefined && points.some(({ x, y }) => x < 0 || y < 0 || x > width || y > height)) {
      diagnostics.push({
        severity: operation.kind === "route" || operation.kind === "geometry" ? "info" : "warning",
        code: operation.kind === "route" || operation.kind === "geometry" ? "PATH_EXTENDS_OUTSIDE_PANEL" : "OPERATION_OUTSIDE_PANEL",
        message: operation.kind === "route" || operation.kind === "geometry"
          ? `Path ${operation.id} extends outside the panel; this may be an intentional lead-in or lead-out`
          : `Operation ${operation.id} extends outside the panel`,
        location: { record: operation.id }
      });
    }
    if (operation.diameter !== undefined && operation.diameter <= 0) diagnostics.push({ severity: "error", code: "INVALID_DIAMETER", message: `Operation ${operation.id} has a non-positive diameter`, location: { record: operation.id } });
    if (operation.depth !== undefined && operation.depth <= 0) diagnostics.push({ severity: "error", code: "INVALID_DEPTH", message: `Operation ${operation.id} has a non-positive depth`, location: { record: operation.id } });
    if (thickness !== undefined && operation.depth !== undefined && operation.depth > thickness) diagnostics.push({ severity: "info", code: "DEPTH_EXCEEDS_PANEL_THICKNESS", message: `Operation ${operation.id} may be a through operation (${operation.depth} > ${thickness})`, location: { record: operation.id } });
    if (operation.repeat && (!Number.isInteger(operation.repeat.count) || operation.repeat.count < 1 || operation.repeat.count > MAX_EXPANDED_POINTS)) diagnostics.push({ severity: "error", code: "INVALID_REPEAT_COUNT", message: `Operation ${operation.id} has an invalid repetition count`, location: { record: operation.id } });
  }
  return diagnostics;
}
