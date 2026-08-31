import { describe, expect, it } from "vitest";
import { caseInsensitiveNameCollisions, readStableWorkspaceSource } from "./node-workspace.js";

describe("Node workspace safety", () => {
  it("detects Windows case-insensitive and Unicode-normalized collisions", () => {
    expect(caseInsensitiveNameCollisions(["PartA.cix", "parta.cix", "Tétel.cix", "Te\u0301tel.cix", "other.cix"])).toEqual([
      { normalizedName: "parta.cix", names: ["parta.cix", "PartA.cix"] },
      { normalizedName: "tétel.cix", names: ["Tétel.cix", "Te\u0301tel.cix"] }
    ]);
  });

  it("rejects a source that changes while being read", async () => {
    const file = { name: "part.cix", path: "C:\\Project\\part.cix", size: 100, lastModified: 200 };
    await expect(readStableWorkspaceSource(file, {
      read: async () => "partial export",
      inspect: async () => ({ size: 120, mtimeMs: 201 })
    })).rejects.toMatchObject({ code: "WORKSPACE_SOURCE_CHANGED" });
  });

  it("returns source text when size and timestamp remain stable", async () => {
    const file = { name: "part.cix", path: "C:\\Project\\part.cix", size: 100, lastModified: 200 };
    await expect(readStableWorkspaceSource(file, {
      read: async () => "complete export",
      inspect: async () => ({ size: 100, mtimeMs: 200 })
    })).resolves.toBe("complete export");
  });
});
