import { describe, expect, it } from "vitest";
import type { OpenCncDocument } from "../../../packages/core/src/index.js";
import { compareDocuments, groupDrills, groupRoutes, jobStem, summarizeDocument } from "./workshop.js";

const document: OpenCncDocument = {
  schemaVersion: "0.1",
  source: { format: "cix", name: "panel.cix" },
  panel: { width: 800, height: 400, thickness: 18, unit: "mm" },
  operations: [
    { id: "d1", kind: "drill", sourceType: "BG", position: { x: 10, y: 20 }, diameter: 5, depth: 10, face: 0, repeat: { count: 4, offset: { x: 32, y: 0 } }, raw: {} },
    { id: "r1", kind: "route", sourceType: "ROUT", path: [{ x: 0, y: 100 }, { x: 300, y: 500 }], diameter: 8, depth: 6, face: 0, raw: {} }
  ],
  metadata: {},
  diagnostics: [{ severity: "warning", code: "TEST", message: "test" }]
};

describe("workshop summaries", () => {
  it("counts expanded drilling and groups workshop operations", () => {
    expect(summarizeDocument(document)).toMatchObject({ drillCount: 4, routeCount: 1, warningCount: 1 });
    expect(groupDrills(document.operations)).toMatchObject([{ quantity: 4, diameter: 5, depth: 10 }]);
    expect(groupRoutes(document.operations)).toMatchObject([{ quantity: 1, totalLength: 500, diameter: 8, depth: 6 }]);
  });

  it("compares matching normalized geometry", () => {
    const other = structuredClone(document);
    other.source = { format: "bpp", name: "panel.bpp" };
    expect(compareDocuments(document, other)).toEqual({ dimensionsMatch: true, geometryMatch: true });
    other.panel.width = 801;
    expect(compareDocuments(document, other)).toEqual({ dimensionsMatch: false, geometryMatch: false });
  });

  it("normalizes paired filenames", () => {
    expect(jobStem("Panel_01.BPP")).toBe("panel_01");
  });
});

