import { describe, expect, it } from "vitest";
import type { OpenCncDocument } from "../../core/src/index.js";
import type { MachineProfile } from "./index.js";
import { checkDocumentAgainstMachine, detectDialect, validateMachineProfile } from "./index.js";

const document: OpenCncDocument = {
  schemaVersion: "0.1", source: { format: "bpp", name: "panel.bpp" }, panel: { width: 800, height: 400, thickness: 18, unit: "mm" },
  operations: [
    { id: "drill", kind: "drill", sourceType: "BG", face: 2, position: { x: 750, y: 100 }, diameter: 5, depth: 20, raw: {} },
    { id: "route", kind: "route", sourceType: "ROUT", path: [{ x: 10, y: 10 }, { x: 900, y: 10 }], diameter: 8, depth: 8, raw: {} }
  ],
  metadata: { type: "BPP", version: "150", recordShapes: ["BG", "ROUT"] }, diagnostics: []
};

const machine: MachineProfile = {
  schemaVersion: "0.1", id: "test-machine", name: "Test machine", travel: { minX: 0, maxX: 700, minY: 0, maxY: 500 }, supportedFaces: [0],
  maxDrillDepth: 18, maxRouteDepth: 10, availableTools: [{ kind: "drill", diameter: 8 }, { kind: "router", diameter: 8 }]
};

describe("profiles", () => {
  it("detects observed BPP v150 while surfacing its confidence boundary", () => {
    expect(detectDialect(document)).toMatchObject({ profileId: "biesse-bpp-v150-observed", version: "150", confidence: "observed-compatible" });
  });

  it("validates and applies advisory machine constraints", () => {
    expect(validateMachineProfile(machine)).toEqual([]);
    const codes = checkDocumentAgainstMachine(document, machine).map(check => check.code);
    expect(codes).toContain("MACHINE_PANEL_EXCEEDS_TRAVEL");
    expect(codes).toContain("MACHINE_OPERATION_OUTSIDE_TRAVEL");
    expect(codes).toContain("MACHINE_FACE_UNSUPPORTED");
    expect(codes).toContain("MACHINE_DEPTH_EXCEEDS_PROFILE");
    expect(codes).toContain("MACHINE_TOOL_NOT_FOUND");
    expect(codes).toContain("MACHINE_PREFLIGHT_ADVISORY");
    expect(checkDocumentAgainstMachine(document, machine).every(check => check.severity !== ("error" as never))).toBe(true);
  });
});
