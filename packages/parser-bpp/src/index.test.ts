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

  it("recognizes BiesseWorks' generated entry bore before an inside-panel route", () => {
    const entry = Array.from({ length: 50 }, () => "0");
    entry[0] = "0";
    entry[1] = '"1"';
    entry[2] = "10";
    entry[3] = "100";
    entry[4] = "0";
    entry[5] = "8";
    entry[6] = "8";
    entry[32] = '"P1001"';
    entry[49] = '"BG"';
    const doc = parseBpp(`[HEADER]\r\nTYPE=BPP\r\nVER=150\r\n[VARIABLES]\r\nPAN=LPX|800||4|\r\nPAN=LPY|400||4|\r\nPAN=LPZ|18||4|\r\n[PROGRAM]\r\n@ BV, "", "", 1001, "", 0 : ${entry.join(", ")}\r\n@ ROUT, "", "", 1002, "", 0 : "P1000", 0, "1", 0, 6, "", 1, 8\r\n  @ START_POINT, "", "", 1003, "", 0 : 10, 100, 0\r\n  @ LINE_EP, "", "", 1004, "", 0 : 790, 100, 0, 0, 0, 0, 0, 0, 0\r\n  @ ENDPATH, "", "", 1005, "", 0 :`, "route-entry.bpp");
    const derived = doc.operations[0];
    expect(derived).toMatchObject({ kind: "drill", sourceType: "BV", label: "BG", raw: { biesseDerivedRouteEntry: true } });
    expect(derived?.support).toMatchObject({ stage: "verified-conversion", geometry: "exact", conversion: true });
    expect(doc.diagnostics).toContainEqual(expect.objectContaining({ code: "BPP_DERIVED_ROUTE_ENTRY" }));
  });

  it("decodes the verified 11-field counter-clockwise ARC_EPCE record", () => {
    const doc = parseBpp(`[HEADER]\r\nTYPE=BPP\r\nVER=150\r\n[VARIABLES]\r\nPAN=LPX|2400||4|\r\nPAN=LPY|600||4|\r\nPAN=LPZ|36||4|\r\n[PROGRAM]\r\n@ ROUT, "", "", 1000, "", 0 : "P1000", 0, "1", 0, 51, "", 1, 18\r\n  @ START_POINT, "", "", 1001, "", 0 : 1362.5, 539.5, 0\r\n  @ LINE_EP, "", "", 1002, "", 0 : 1637.5, 539.5, 0, 0, 0, 0, 0, 0, 0\r\n  @ ARC_EPCE, "", "", 1003, "", 0 : 1712.5, 464.5, 1637.5, 464.5, 2, 0, 0, 0, 0, 0, 0\r\n  @ ENDPATH, "", "", 1004, "", 0 :`, "arc.bpp");
    expect(doc.operations[0]).toMatchObject({
      kind: "route",
      path: [{ x: 1362.5, y: 539.5, z: 0 }, { x: 1637.5, y: 539.5, z: 0 }, { x: 1712.5, y: 464.5, z: 0 }],
      segments: [{ kind: "line" }, { kind: "arc", center: { x: 1637.5, y: 464.5 }, clockwise: false }],
      support: { stage: "verified-conversion", geometry: "exact", conversion: true }
    });
    expect(doc.diagnostics.map(item => item.code)).not.toContain("BPP_ARC_PROFILE_REQUIRED");
  });
});
