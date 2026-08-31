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
    expect(svg).toContain('<path d="M 0 25 L 100 25"');
    expect(svg).toContain('data-operation-id="drill"');
  });

  it("filters and highlights traceable operations", () => {
    const document: OpenCncDocument = {
      schemaVersion: "0.1",
      source: { format: "bpp" },
      panel: { width: 100, height: 50, unit: "mm" },
      operations: [
        { id: "visible", kind: "drill", sourceType: "BG", position: { x: 10, y: 10 }, raw: { line: 12 } },
        { id: "hidden", kind: "drill", sourceType: "BG", position: { x: 20, y: 20 }, raw: { line: 13 } }
      ],
      metadata: {},
      diagnostics: []
    };
    const svg = renderSvg(document, { operationIds: new Set(["visible"]), highlightedOperationIds: new Set(["visible"]) });
    expect(svg).toContain('class="opencnc-preview has-highlight"');
    expect(svg).toContain('data-operation-id="visible" data-source-line="12"');
    expect(svg).not.toContain('data-operation-id="hidden"');
  });

  it("renders structured arcs as SVG arc commands", () => {
    const document: OpenCncDocument = {
      schemaVersion: "0.1", source: { format: "cix" }, panel: { width: 200, height: 100, unit: "mm" },
      operations: [{ id: "arc", kind: "geometry", sourceType: "GEO", path: [{ x: 25, y: 50 }, { x: 125, y: 50 }], segments: [{ kind: "arc", start: { x: 25, y: 50 }, end: { x: 125, y: 50 }, center: { x: 75, y: 50 }, clockwise: true }], raw: {} }],
      metadata: {}, diagnostics: []
    };
    const svg = renderSvg(document);
    expect(svg).toContain("A 50 50");
    expect(svg).toContain("operation-geometry");
    expect(svg).toContain('stroke-dasharray="7 5"');
  });
});
