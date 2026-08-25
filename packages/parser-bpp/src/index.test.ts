import { describe, expect, it } from "vitest";
import { parseBpp } from "./index.js";

describe("parseBpp", () => {
  it("reads panel dimensions and preserves unknown records", () => {
    const doc = parseBpp("[HEADER]\nL=800\nH=400\nT=18\n[PROGRAM]\nUNKNOWN");
    expect(doc.panel).toMatchObject({ width: 800, height: 400, thickness: 18 });
    expect(doc.operations).toHaveLength(1);
  });
});

