export interface WorkspaceSourceFingerprint {
  name: string;
  size: number;
  lastModified: number;
  sourceChecksum: string;
}

export interface WorkspaceManifestEntry extends WorkspaceSourceFingerprint {
  outputName: string;
  targetChecksum: string;
  convertedAt: string;
  verified: true;
  reverseVerified: true;
  semanticRoundTrip: true;
  geometryRoundTrip: true;
}

export interface WorkspaceManifest {
  schemaVersion: "0.1";
  engineVersion: "0.2.0";
  workspaceName: string;
  updatedAt: string;
  entries: WorkspaceManifestEntry[];
}

export type WorkspaceWriteDecision = "create" | "update" | "unchanged" | "conflict";

export interface WorkspaceWritePlanInput {
  outputName: string;
  targetChecksum: string;
  existingChecksum?: string;
  previousEntry?: WorkspaceManifestEntry;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function quickWorkspaceFingerprint(files: Array<Pick<WorkspaceSourceFingerprint, "name" | "size" | "lastModified">>): string {
  return files
    .map(file => `${file.name.toLocaleLowerCase()}:${file.size}:${file.lastModified}`)
    .sort()
    .join("|");
}

export function parseWorkspaceManifest(sourceText: string | undefined): WorkspaceManifest | undefined {
  if (!sourceText) return undefined;
  try {
    const value = JSON.parse(sourceText) as Partial<WorkspaceManifest>;
    if (value.schemaVersion !== "0.1" || value.engineVersion !== "0.2.0" || typeof value.workspaceName !== "string" || typeof value.updatedAt !== "string" || !Array.isArray(value.entries)) return undefined;
    if (!value.entries.every(entry => entry && typeof entry.name === "string" && typeof entry.size === "number" && typeof entry.lastModified === "number" && typeof entry.sourceChecksum === "string" && typeof entry.outputName === "string" && typeof entry.targetChecksum === "string" && typeof entry.convertedAt === "string" && entry.verified === true && entry.reverseVerified === true && entry.semanticRoundTrip === true && entry.geometryRoundTrip === true)) return undefined;
    return value as WorkspaceManifest;
  } catch {
    return undefined;
  }
}

export function planWorkspaceWrite(input: WorkspaceWritePlanInput): WorkspaceWriteDecision {
  if (input.existingChecksum === undefined) return "create";
  if (input.existingChecksum === input.targetChecksum) return "unchanged";
  if (input.previousEntry?.outputName === input.outputName && input.previousEntry.targetChecksum === input.existingChecksum) return "update";
  return "conflict";
}

export function workspaceNeedsConversion(
  files: Array<Pick<WorkspaceSourceFingerprint, "name" | "size" | "lastModified">>,
  outputNames: string[],
  manifest: WorkspaceManifest | undefined
): boolean {
  if (!files.length || !manifest || manifest.entries.length !== files.length) return true;
  const outputs = new Set(outputNames.map(name => name.toLocaleLowerCase()));
  const entries = new Map(manifest.entries.map(entry => [entry.name.toLocaleLowerCase(), entry]));
  return files.some(file => {
    const entry = entries.get(file.name.toLocaleLowerCase());
    return !entry || entry.size !== file.size || entry.lastModified !== file.lastModified || !outputs.has(entry.outputName.toLocaleLowerCase());
  });
}

export function createWorkspaceManifest(workspaceName: string, entries: WorkspaceManifestEntry[], updatedAt = new Date().toISOString()): WorkspaceManifest {
  return {
    schemaVersion: "0.1",
    engineVersion: "0.2.0",
    workspaceName,
    updatedAt,
    entries: [...entries].sort((left, right) => left.name.localeCompare(right.name))
  };
}
