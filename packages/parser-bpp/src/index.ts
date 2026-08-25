import type { Diagnostic, OpenCncDocument, Operation } from "../../core/src/index.js";

const number = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
};

export function parseBpp(input: string, name?: string): OpenCncDocument {
  const diagnostics: Diagnostic[] = [];
  const sections: Record<string, Record<string, string>> = {};
  const records: Array<Record<string, string>> = [];
  let section = "ROOT";

  input.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((original, index) => {
    const line = original.trim();
    if (!line || line.startsWith(";") || line.startsWith("//")) return;
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading?.[1]) {
      section = heading[1].toUpperCase();
      sections[section] ??= {};
      return;
    }
    const separator = line.indexOf("=");
    if (separator < 1) {
      records.push({ section, value: line, line: String(index + 1) });
      diagnostics.push({ severity: "info", code: "BPP_RECORD_PRESERVED", message: "Unrecognized record preserved as raw data", location: { line: index + 1 } });
      return;
    }
    const key = line.slice(0, separator).trim().toUpperCase();
    const value = line.slice(separator + 1).trim().replace(/^"|"$/g, "");
    (sections[section] ??= {})[key] = value;
  });

  const header = { ...(sections.HEADER ?? {}), ...(sections.PAN ?? {}), ...(sections.PANEL ?? {}) };
  const width = number(header.L ?? header.LENGTH ?? header.DX);
  const height = number(header.H ?? header.WIDTH ?? header.DY);
  const thickness = number(header.T ?? header.THICKNESS ?? header.DZ);
  if (width === undefined || height === undefined) diagnostics.push({ severity: "warning", code: "PANEL_SIZE_UNKNOWN", message: "Panel width/height could not be identified" });

  const operations: Operation[] = records.map((record, i) => ({ id: `bpp-${i + 1}`, kind: "unknown", raw: record }));
  return {
    schemaVersion: "0.1",
    source: { format: "bpp", ...(name ? { name } : {}) },
    panel: { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(thickness !== undefined ? { thickness } : {}), unit: "mm" },
    operations,
    metadata: { sections, rawRecordCount: records.length },
    diagnostics
  };
}

