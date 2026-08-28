import { describe, expect, it } from "vitest";
import type { OpenCncDocument } from "../../core/src/index.js";
import { renderSvg } from "./index.js";

describe("renderSvg", () => {
  it("renders repeated drills and a routed path", () => {
    const document: OpenCncDocument = {
      schemaVersion: "0.1",
      source: { format: "cix" },
      panel: { width: 100, height: 50, unit: "mm" },
      operations: [
        { id: "drill", kind: "drill", sourceType: "BG", position: { x: 10, y: 10 }, diameter: 5, repeat: { count: 3, offset: { x: 20, y: 0 } }, raw: {} },
        { id: "route", kind: "route", sourceType: "ROUT", path: [{ x: 0, y: 25 }, { x: 100, y: 25 }], diameter: 4, raw: {} }
      ],
      metadata: {},
      diagnostics: []
    };
    const svg = renderSvg(document);
    expect(svg.match(/<circle/g)).toHaveLength(3);
    expect(svg).toContain('<polyline points="0,25 100,25"');
  });
});
