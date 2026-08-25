import { describe, expect, it } from "vitest";
import { parseCix } from "./index.js";

describe("parseCix", () => {
  it("reads basic panel attributes", () => {
    expect(parseCix('<CIX><Panel length="800" height="400" thickness="18" /></CIX>').panel).toMatchObject({ width: 800, height: 400, thickness: 18 });
  });
});

