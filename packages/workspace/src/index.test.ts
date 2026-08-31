import { describe, expect, it } from "vitest";
import { createWorkspaceManifest, parseWorkspaceManifest, planWorkspaceWrite, quickWorkspaceFingerprint, workspaceNeedsConversion, type WorkspaceManifestEntry } from "./index.js";

const entry: WorkspaceManifestEntry = {
  name: "part.cix",
  size: 123,
  lastModified: 456,
  sourceChecksum: "source",
  outputName: "part.bpp",
  targetChecksum: "target-old",
  convertedAt: "2026-08-30T12:00:00.000Z",
  verified: true,
  reverseVerified: true,
  semanticRoundTrip: true,
  geometryRoundTrip: true
};

describe("folder workspace safety", () => {
  it("only overwrites outputs that still match the previous OpenCNC checksum", () => {
    expect(planWorkspaceWrite({ outputName: "part.bpp", targetChecksum: "target-new" })).toBe("create");
    expect(planWorkspaceWrite({ outputName: "part.bpp", targetChecksum: "target-new", existingChecksum: "target-new" })).toBe("unchanged");
    expect(planWorkspaceWrite({ outputName: "part.bpp", targetChecksum: "target-new", existingChecksum: "target-old", previousEntry: entry })).toBe("update");
    expect(planWorkspaceWrite({ outputName: "part.bpp", targetChecksum: "target-new", existingChecksum: "manual-edit", previousEntry: entry })).toBe("conflict");
  });

  it("detects new, removed, changed, and missing-output sources", () => {
    const manifest = createWorkspaceManifest("Project A", [entry]);
    expect(workspaceNeedsConversion([{ name: "part.cix", size: 123, lastModified: 456 }], ["part.bpp"], manifest)).toBe(false);
    expect(workspaceNeedsConversion([{ name: "part.cix", size: 124, lastModified: 456 }], ["part.bpp"], manifest)).toBe(true);
    expect(workspaceNeedsConversion([{ name: "part.cix", size: 123, lastModified: 456 }], [], manifest)).toBe(true);
    expect(workspaceNeedsConversion([], ["part.bpp"], manifest)).toBe(true);
  });

  it("round-trips manifests and creates stable order-independent fingerprints", () => {
    const manifest = createWorkspaceManifest("Project A", [entry]);
    expect(parseWorkspaceManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(parseWorkspaceManifest("not-json")).toBeUndefined();
    const left = quickWorkspaceFingerprint([{ name: "b.cix", size: 2, lastModified: 2 }, { name: "a.cix", size: 1, lastModified: 1 }]);
    const right = quickWorkspaceFingerprint([{ name: "a.cix", size: 1, lastModified: 1 }, { name: "b.cix", size: 2, lastModified: 2 }]);
    expect(left).toBe(right);
  });
});
