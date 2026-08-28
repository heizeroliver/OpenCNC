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
});
