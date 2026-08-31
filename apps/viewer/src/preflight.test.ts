import { describe, expect, it } from "vitest";
import { conflictingKeys, outputNameFromTemplate, sanitizeOutputName } from "./preflight.js";

describe("bulk conversion preflight", () => {
  it("builds deterministic output names for each template", () => {
    expect(outputNameFromTemplate("cabinet door.bpp", "bpp", "cix", "opposite")).toBe("cabinet door.cix");
    expect(outputNameFromTemplate("cabinet door.bpp", "bpp", "cix", "converted")).toBe("cabinet door-converted.cix");
    expect(outputNameFromTemplate("cabinet door.bpp", "bpp", "cix", "direction")).toBe("cabinet door-bpp-to-cix.cix");
  });

  it("sanitizes paths and enforces the conversion extension", () => {
    expect(sanitizeOutputName("../unsafe\\name.bpp", "cix")).toBe("-unsafe-name.cix");
    expect(sanitizeOutputName("   ", "bpp")).toBe("converted.bpp");
  });

  it("detects case-insensitive conflicts only among included files", () => {
    expect([...conflictingKeys([
      { key: "a", included: true, outputName: "Part.cix" },
      { key: "b", included: true, outputName: "part.cix" },
      { key: "c", included: false, outputName: "PART.cix" },
      { key: "d", included: true, outputName: "other.cix" }
    ])].sort()).toEqual(["a", "b"]);
  });
});
