import { describe, expect, it } from "vitest";
import { validateDocument, type OpenCncDocument } from "./index.js";

describe("validateDocument", () => {
  it("reports operations outside the panel", () => {
    const document: OpenCncDocument = { schemaVersion: "0.1", source: { format: "bpp" }, panel: { width: 10, height: 10, unit: "mm" }, operations: [{ id: "x", kind: "drill", sourceType: "BG", position: { x: 12, y: 5 }, raw: {} }], metadata: {}, diagnostics: [] };
    expect(validateDocument(document).map(d => d.code)).toContain("OPERATION_OUTSIDE_PANEL");
  });

  it("validates every point in a repeated operation", () => {
    const document: OpenCncDocument = { schemaVersion: "0.1", source: { format: "cix" }, panel: { width: 100, height: 50, unit: "mm" }, operations: [{ id: "row", kind: "drill", sourceType: "BG", position: { x: 10, y: 10 }, repeat: { count: 4, offset: { x: 40, y: 0 } }, raw: {} }], metadata: {}, diagnostics: [] };
    expect(validateDocument(document).map(d => d.code)).toContain("OPERATION_OUTSIDE_PANEL");
  });
});
