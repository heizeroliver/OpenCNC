import type { SourceFormat } from "../../../packages/core/src/index.js";

export type OutputNameTemplate = "opposite" | "converted" | "direction";

export interface ConflictCandidate {
  key: string;
  included: boolean;
  outputName: string;
}

const stem = (name: string): string => name.replace(/\.(bpp|cix)$/i, "");

export function sanitizeOutputName(name: string, targetFormat: SourceFormat, fallback = `converted.${targetFormat}`): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/g, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 180);
  const base = stem(cleaned).replace(/[. ]+$/g, "").trim();
  return `${base || stem(fallback) || "converted"}.${targetFormat}`;
}

export function outputNameFromTemplate(sourceName: string, sourceFormat: SourceFormat, targetFormat: SourceFormat, template: OutputNameTemplate): string {
  const sourceStem = stem(sourceName);
  const requested = template === "converted"
    ? `${sourceStem}-converted.${targetFormat}`
    : template === "direction"
      ? `${sourceStem}-${sourceFormat}-to-${targetFormat}.${targetFormat}`
      : `${sourceStem}.${targetFormat}`;
  return sanitizeOutputName(requested, targetFormat);
}

export function conflictingKeys(candidates: ConflictCandidate[]): Set<string> {
  const groups = new Map<string, string[]>();
  candidates.filter(candidate => candidate.included).forEach(candidate => {
    const normalized = candidate.outputName.trim().toLocaleLowerCase();
    const group = groups.get(normalized) ?? [];
    group.push(candidate.key);
    groups.set(normalized, group);
  });
  return new Set([...groups.values()].filter(group => group.length > 1).flat());
}
