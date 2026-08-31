import { describe, expect, it } from "vitest";
import { parseCix } from "./index.js";

describe("parseCix", () => {
  it("reads text-macro panel data, drilling, repetition, and routed paths", () => {
    const doc = parseCix(`BEGIN MAINDATA\nLPX=800\nLPY=400\nLPZ=18\nEND MAINDATA\nBEGIN MACRO\nNAME=BG\nPARAM,NAME=SIDE,VALUE=0\nPARAM,NAME=X,VALUE=20\nPARAM,NAME=Y,VALUE=30\nPARAM,NAME=Z,VALUE=0\nPARAM,NAME=DP,VALUE=10\nPARAM,NAME=DIA,VALUE=5\nPARAM,NAME=RTY,VALUE=rpXY\nPARAM,NAME=DX,VALUE=50\nPARAM,NAME=DY,VALUE=0\nPARAM,NAME=NRP,VALUE=4\nEND MACRO\nBEGIN MACRO\nNAME=ROUT\nPARAM,NAME=SIDE,VALUE=0\nPARAM,NAME=DP,VALUE=6\nPARAM,NAME=DIA,VALUE=8\nEND MACRO\nBEGIN MACRO\nNAME=START_POINT\nPARAM,NAME=X,VALUE=10\nPARAM,NAME=Y,VALUE=100\nEND MACRO\nBEGIN MACRO\nNAME=LINE_EP\nPARAM,NAME=XE,VALUE=790\nPARAM,NAME=YE,VALUE=100\nEND MACRO\nBEGIN MACRO\nNAME=ENDPATH\nEND MACRO`);
    expect(doc.panel).toMatchObject({ width: 800, height: 400, thickness: 18 });
    expect(doc.operations[0]).toMatchObject({ kind: "drill", repeat: { count: 4, offset: { x: 50, y: 0 } } });
    expect(doc.operations[1]).toMatchObject({ kind: "route", path: [{ x: 10, y: 100 }, { x: 790, y: 100 }] });
    expect(doc.diagnostics).toHaveLength(0);
  });

  it("structures advanced geometry for preview without enabling conversion", () => {
    const macro = (name: string, parameters: Record<string, string | number> = {}): string => ["BEGIN MACRO", `NAME=${name}`, ...Object.entries(parameters).map(([key, value]) => `PARAM,NAME=${key},VALUE=${value}`), "END MACRO"].join("\n");
    const doc = parseCix([
      "BEGIN MAINDATA\nLPX=600\nLPY=300\nLPZ=18\nEND MAINDATA",
      macro("GEO", { ID: "outline", SIDE: 0 }),
      macro("START_POINT", { X: 50, Y: 100 }),
      macro("ARC_EPCE", { XE: 150, YE: 100, XC: 100, YC: 100, DIR: "CW" }),
      macro("LINE_EP", { XE: 200, YE: 150 }),
      macro("ENDPATH"),
      macro("ROUTG", { ID: "route-outline", GID: "outline", DP: 6, DIA: 8 }),
      macro("PKT1", { ID: "pocket-outline", GID: "outline", DP: 4, DIA: 10 }),
      macro("CUT_X", { ID: "crosscut", X: 25, Y: 250, L: 300, DP: 8, DIA: 4 })
    ].join("\n"), "advanced.cix");
    const geometry = doc.operations.find(operation => operation.kind === "geometry");
    expect(geometry).toMatchObject({ id: "outline", support: { stage: "validated", geometry: "exact", conversion: false } });
    expect(geometry?.segments).toMatchObject([{ kind: "arc", center: { x: 100, y: 100 }, clockwise: true }, { kind: "line" }]);
    expect(doc.operations).toContainEqual(expect.objectContaining({ id: "route-outline", kind: "route", sourceType: "ROUTG", geometryRef: "outline", path: expect.any(Array) }));
    expect(doc.operations).toContainEqual(expect.objectContaining({ id: "pocket-outline", kind: "pocket", geometryRef: "outline" }));
    expect(doc.operations).toContainEqual(expect.objectContaining({ id: "crosscut", kind: "saw", path: [{ x: 25, y: 250 }, { x: 325, y: 250 }] }));
    expect(doc.diagnostics.map(item => item.code)).toContain("CIX_ADVANCED_OPERATIONS_PREVIEW_ONLY");
  });

  it("resolves the paired-corpus KILINCSM tool diameter when DIA is absent", () => {
    const doc = parseCix(`BEGIN MAINDATA\nLPX=2400\nLPY=600\nLPZ=36\nEND MAINDATA\nBEGIN MACRO\nNAME=ROUT\nPARAM,NAME=SIDE,VALUE=0\nPARAM,NAME=DP,VALUE=51\nPARAM,NAME=TNM,VALUE="KILINCSM"\nPARAM,NAME=TTP,VALUE=100\nPARAM,NAME=TCL,VALUE=1\nEND MACRO\nBEGIN MACRO\nNAME=START_POINT\nPARAM,NAME=X,VALUE=2250\nPARAM,NAME=Y,VALUE=600\nPARAM,NAME=Z,VALUE=0\nEND MACRO\nBEGIN MACRO\nNAME=LINE_EP\nPARAM,NAME=XE,VALUE=2400\nPARAM,NAME=YE,VALUE=450\nPARAM,NAME=ZE,VALUE=0\nEND MACRO\nBEGIN MACRO\nNAME=ENDPATH\nEND MACRO`, "kilincsm.cix");
    expect(doc.operations[0]).toMatchObject({ kind: "route", diameter: 18, raw: { inferredDiameterFromTool: "KILINCSM", inferredDiameterEvidence: "paired-biesseworks-bpp" } });
    expect(doc.diagnostics).toContainEqual(expect.objectContaining({ code: "CIX_TOOL_DIAMETER_INFERRED" }));
  });
});
