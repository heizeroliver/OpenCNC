import { operationPoints, type OpenCncDocument, type Operation } from "../../../packages/core/src/index.js";
import { compareDocuments as compareConvertedDocuments, type DocumentComparison } from "../../../packages/converter/src/index.js";

export interface DrillGroup {
  diameter?: number;
  depth?: number;
  face?: number;
  quantity: number;
  labels: string[];
  references: OperationReference[];
  first?: { x: number; y: number };
  last?: { x: number; y: number };
}

export interface RouteGroup {
  diameter?: number;
  depth?: number;
  face?: number;
  quantity: number;
  totalLength: number;
  labels: string[];
  references: OperationReference[];
}

export interface OperationReference {
  id: string;
  sourceType: string;
  line?: number;
}

export interface PreviewFilters {
  topDrill: boolean;
  sideDrill: boolean;
  route: boolean;
  advanced: boolean;
}

export type PreviewLayer = keyof PreviewFilters;

export interface WorkshopSummary {
  drillCount: number;
  routeCount: number;
  advancedCount: number;
  errorCount: number;
  warningCount: number;
  throughOperationCount: number;
}

const finite = (value: number | undefined): string => value === undefined ? "?" : String(value);

const operationReference = (operation: Operation): OperationReference => {
  const line = operation.raw.line;
  return {
    id: operation.id,
    sourceType: operation.sourceType,
    ...(typeof line === "number" && Number.isFinite(line) ? { line } : {})
  };
};

export function previewLayer(operation: Operation): PreviewLayer | undefined {
  if (operation.kind === "route") return "route";
  if (["geometry", "pocket", "saw", "groove", "cut"].includes(operation.kind) && operation.path?.length) return "advanced";
  if (operation.kind !== "drill") return undefined;
  return operation.face === undefined || operation.face === 0 ? "topDrill" : "sideDrill";
}

export function filterPreviewOperations(operations: Operation[], filters: PreviewFilters): Operation[] {
  return operations.filter(operation => {
    const layer = previewLayer(operation);
    return layer !== undefined && filters[layer];
  });
}

export function summarizeDocument(document: OpenCncDocument): WorkshopSummary {
  return {
    drillCount: document.operations.filter(operation => operation.kind === "drill").reduce((total, operation) => total + operationPoints(operation).length, 0),
    routeCount: document.operations.filter(operation => operation.kind === "route").length,
    advancedCount: document.operations.filter(operation => !["drill", "route", "unknown"].includes(operation.kind)).length,
    errorCount: document.diagnostics.filter(diagnostic => diagnostic.severity === "error").length,
    warningCount: document.diagnostics.filter(diagnostic => diagnostic.severity === "warning").length,
    throughOperationCount: document.diagnostics.filter(diagnostic => diagnostic.code === "DEPTH_EXCEEDS_PANEL_THICKNESS").length
  };
}

export function groupDrills(operations: Operation[]): DrillGroup[] {
  const groups = new Map<string, DrillGroup>();
  for (const operation of operations.filter(operation => operation.kind === "drill")) {
    const key = [finite(operation.diameter), finite(operation.depth), finite(operation.face)].join("|");
    const points = operationPoints(operation);
    const group = groups.get(key) ?? {
      ...(operation.diameter !== undefined ? { diameter: operation.diameter } : {}),
      ...(operation.depth !== undefined ? { depth: operation.depth } : {}),
      ...(operation.face !== undefined ? { face: operation.face } : {}),
      quantity: 0,
      labels: [],
      references: []
    };
    group.quantity += points.length;
    if (operation.label && !group.labels.includes(operation.label)) group.labels.push(operation.label);
    group.references.push(operationReference(operation));
    if (!group.first && points[0]) group.first = points[0];
    const lastPoint = points.at(-1);
    if (lastPoint) group.last = lastPoint;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.diameter ?? Infinity) - (b.diameter ?? Infinity) || (a.depth ?? Infinity) - (b.depth ?? Infinity) || (a.face ?? Infinity) - (b.face ?? Infinity));
}

const pathLength = (operation: Operation): number => {
  const path = operation.path ?? [];
  return path.slice(1).reduce((total, point, index) => {
    const previous = path[index]!;
    return total + Math.hypot(point.x - previous.x, point.y - previous.y);
  }, 0);
};

export function groupRoutes(operations: Operation[]): RouteGroup[] {
  const groups = new Map<string, RouteGroup>();
  for (const operation of operations.filter(operation => operation.kind === "route")) {
    const key = [finite(operation.diameter), finite(operation.depth), finite(operation.face)].join("|");
    const group = groups.get(key) ?? {
      ...(operation.diameter !== undefined ? { diameter: operation.diameter } : {}),
      ...(operation.depth !== undefined ? { depth: operation.depth } : {}),
      ...(operation.face !== undefined ? { face: operation.face } : {}),
      quantity: 0,
      totalLength: 0,
      labels: [],
      references: []
    };
    group.quantity += 1;
    group.totalLength += pathLength(operation);
    if (operation.label && !group.labels.includes(operation.label)) group.labels.push(operation.label);
    group.references.push(operationReference(operation));
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.diameter ?? Infinity) - (b.diameter ?? Infinity) || (a.depth ?? Infinity) - (b.depth ?? Infinity));
}

export function compareDocuments(left: OpenCncDocument, right: OpenCncDocument, tolerance = 0.001): DocumentComparison {
  return compareConvertedDocuments(left, right, tolerance);
}

export function jobStem(name: string): string {
  return name.replace(/\.(bpp|cix)$/i, "").toLocaleLowerCase();
}
