import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseBpp } from "../../../packages/parser-bpp/src/index.js";
import { compareProjectFiles, createMemoryProjectStore, createProjectSession } from "./history.js";

describe("local project sessions", () => {
  it("stores and restores a complete local session", async () => {
    const store = createMemoryProjectStore();
    const session = createProjectSession({
      name: "Kitchen batch",
      archiveName: "kitchen-west",
      operatorNotes: "Simulate after tool setup",
      simulationStatus: "pending",
      selectedFileName: "minimal.bpp",
      files: [{ name: "minimal.bpp", size: 42, sourceText: "[HEADER]", sourceFormat: "bpp" }]
    }, { id: "session-1", now: "2026-08-30T12:00:00.000Z" });
    await store.saveSession(session);
    expect((await store.listSessions())[0]).toMatchObject({ name: "Kitchen batch", fileCount: 1, simulationStatus: "pending" });
    expect(await store.loadSession("session-1")).toEqual(session);
  });

  it("compares the previous and current local file sets", async () => {
    const sourceText = await readFile(new URL("../../../fixtures/synthetic/minimal.bpp", import.meta.url), "utf8");
    const document = parseBpp(sourceText, "minimal.bpp");
    const comparison = compareProjectFiles(
      [{ name: "minimal.bpp", document }],
      [{ name: "minimal.bpp", document }, { name: "added.bpp", document }],
      "2026-08-30T12:00:00.000Z"
    );
    expect(comparison).toMatchObject({ comparableFiles: 1, semanticMatches: 1, geometryMatches: 1, addedFiles: ["added.bpp"], changedFiles: [] });
  });
});
