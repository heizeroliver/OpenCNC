import type { Diagnostic, OpenCncDocument } from "../../core/src/index.js";

const attr = (xml: string, names: string[]): number | undefined => {
  for (const name of names) {
    const match = xml.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
    if (match?.[1]) {
      const parsed = Number(match[1].replace(",", "."));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
};

export function parseCix(input: string, name?: string): OpenCncDocument {
  const diagnostics: Diagnostic[] = [];
  if (!input.trim().startsWith("<")) diagnostics.push({ severity: "error", code: "CIX_NOT_XML", message: "CIX input does not appear to be XML" });
  const width = attr(input, ["length", "width", "dx"]);
  const height = attr(input, ["height", "dy"]);
  const thickness = attr(input, ["thickness", "dz"]);
  if (width === undefined || height === undefined) diagnostics.push({ severity: "warning", code: "PANEL_SIZE_UNKNOWN", message: "Panel width/height could not be identified" });
  diagnostics.push({ severity: "info", code: "CIX_OPERATIONS_PENDING", message: "Operation mapping requires representative CIX fixtures" });
  return {
    schemaVersion: "0.1",
    source: { format: "cix", ...(name ? { name } : {}) },
    panel: { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(thickness !== undefined ? { thickness } : {}), unit: "mm" },
    operations: [],
    metadata: { rootElement: input.match(/<([A-Za-z_][\w:.-]*)/)?.[1] ?? null },
    diagnostics
  };
}

