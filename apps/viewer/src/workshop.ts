import { operationPoints, type OpenCncDocument, type Operation } from "../../../packages/core/src/index.js";

export interface DrillGroup {
  diameter?: number;
  depth?: number;
  face?: number;
  quantity: number;
  labels: string[];
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
}

export interface WorkshopSummary {
  drillCount: number;
  routeCount: number;
  errorCount: number;
  warningCount: number;
  throughOperationCount: number;
}

const finite = (value: number | undefined): string => value === undefined ? "?" : String(value);

export function summarizeDocument(document: OpenCncDocument): WorkshopSummary {
  return {
    drillCount: document.operations.filter(operation => operation.kind === "drill").reduce((total, operation) => total + operationPoints(operation).length, 0),
    routeCount: document.operations.filter(operation => operation.kind === "route").length,
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
      labels: []
    };
    group.quantity += points.length;
    if (operation.label && !group.labels.includes(operation.label)) group.labels.push(operation.label);
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
      labels: []
    };
    group.quantity += 1;
    group.totalLength += pathLength(operation);
    if (operation.label && !group.labels.includes(operation.label)) group.labels.push(operation.label);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.diameter ?? Infinity) - (b.diameter ?? Infinity) || (a.depth ?? Infinity) - (b.depth ?? Infinity));
}

const normalizedGeometry = (document: OpenCncDocument): unknown => document.operations
  .filter(operation => operation.kind !== "unknown")
  .map(({ kind, face, position, depth, diameter, path, repeat }) => ({ kind, face: face ?? null, position: position ?? null, depth: depth ?? null, diameter: diameter ?? null, path: path ?? null, repeat: repeat ?? null }));

export function compareDocuments(left: OpenCncDocument, right: OpenCncDocument): { dimensionsMatch: boolean; geometryMatch: boolean } {
  const dimensionsMatch = ["width", "height", "thickness"].every(key => left.panel[key as keyof typeof left.panel] === right.panel[key as keyof typeof right.panel]);
  return { dimensionsMatch, geometryMatch: dimensionsMatch && JSON.stringify(normalizedGeometry(left)) === JSON.stringify(normalizedGeometry(right)) };
}

export function jobStem(name: string): string {
  return name.replace(/\.(bpp|cix)$/i, "").toLocaleLowerCase();
}
