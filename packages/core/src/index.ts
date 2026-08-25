export type SourceFormat = "bpp" | "cix";
export type Severity = "info" | "warning" | "error";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  location?: { line?: number; record?: string };
}

export interface Point { x: number; y: number }

export interface Panel {
  width?: number;
  height?: number;
  thickness?: number;
  unit: "mm" | "inch" | "unknown";
}

export interface Operation {
  id: string;
  kind: "drill" | "groove" | "cut" | "unknown";
  position?: Point;
  depth?: number;
  diameter?: number;
  path?: Point[];
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

export function validateDocument(document: OpenCncDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { width, height, thickness } = document.panel;
  for (const [name, value] of Object.entries({ width, height, thickness })) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      diagnostics.push({ severity: "error", code: "INVALID_PANEL_DIMENSION", message: `${name} must be a positive finite number` });
    }
  }
  if (width !== undefined && height !== undefined) {
    for (const operation of document.operations) {
      const points = [...(operation.position ? [operation.position] : []), ...(operation.path ?? [])];
      if (points.some(({ x, y }) => x < 0 || y < 0 || x > width || y > height)) {
        diagnostics.push({ severity: "warning", code: "OPERATION_OUTSIDE_PANEL", message: `Operation ${operation.id} extends outside the panel`, location: { record: operation.id } });
      }
    }
  }
  return diagnostics;
}

