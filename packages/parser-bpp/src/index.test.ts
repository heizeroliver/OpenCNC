import { describe, expect, it } from "vitest";
import { parseBpp, splitBppCsv } from "./index.js";

describe("parseBpp", () => {
  it("reads real-style panel variables, drill repetitions, and route paths", () => {
    const doc = parseBpp(`[HEADER]\nTYPE=BPP\nVER=150\n[VARIABLES]\nPAN=LPX|800||4|\nPAN=LPY|400||4|\nPAN=LPZ|18||4|\n[PROGRAM]\n@ BG, "", "", 1001, "", 0 : 0, "1", 20, 30, 0, 10, 5, 0, 2, 50, 0, 50, 0, 45, 4, "Drill"\n@ ROUT, "", "", 1002, "", 0 : "P1002", 0, "1", 0, 6, "", 1, 8\n  @ START_POINT, "", "", 1003, "", 0 : 10, 100, 0\n  @ LINE_EP, "", "", 1004, "", 0 : 790, 100, 0, 0\n  @ ENDPATH, "", "", 1005, "", 0 :`);
    expect(doc.panel).toMatchObject({ width: 800, height: 400, thickness: 18 });
    expect(doc.operations).toHaveLength(2);
    expect(doc.operations[0]).toMatchObject({ kind: "drill", position: { x: 20, y: 30 }, depth: 10, diameter: 5, repeat: { count: 4, offset: { x: 50, y: 0 } } });
    expect(doc.operations[1]).toMatchObject({ kind: "route", depth: 6, diameter: 8, path: [{ x: 10, y: 100 }, { x: 790, y: 100 }] });
    expect(doc.diagnostics).toHaveLength(0);
  });

  it("handles quoted commas in compact records", () => {
    expect(splitBppCsv('1, "hello, world", 3')).toEqual(["1", "hello, world", "3"]);
  });
});
