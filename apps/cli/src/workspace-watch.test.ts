import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { discoverWatchProjects, runWorkspaceOnce } from "./workspace-watch.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("unattended workspace watcher", () => {
  it("discovers project folders and safely creates their BPP outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc-watch-"));
    temporaryDirectories.push(root);
    const project = join(root, "Kitchen 42");
    await import("node:fs/promises").then(module => module.mkdir(project));
    const source = await readFile(new URL("../../../fixtures/synthetic/minimal.cix", import.meta.url), "utf8");
    await writeFile(join(project, "shelf.cix"), source);
    expect((await discoverWatchProjects(root)).map(value => value.name)).toEqual(["Kitchen 42"]);
    const first = await runWorkspaceOnce({ rootDirectory: root });
    expect(first.summary).toMatchObject({ total: 1, converted: 1, blocked: 0, conflicts: 0 });
    expect(await readFile(join(project, "BPP", "shelf.bpp"), "utf8")).toContain("[PROGRAM]");
    const second = await runWorkspaceOnce({ rootDirectory: root });
    expect(second.summary).toMatchObject({ unchanged: 1, conflicts: 0 });
  });

  it("refuses to overwrite a BPP file edited after OpenCNC generated it", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc-watch-"));
    temporaryDirectories.push(root);
    const project = join(root, "Wardrobe");
    await import("node:fs/promises").then(module => module.mkdir(project));
    const source = await readFile(new URL("../../../fixtures/synthetic/minimal.cix", import.meta.url), "utf8");
    await writeFile(join(project, "panel.cix"), source);
    await runWorkspaceOnce({ rootDirectory: root });
    await writeFile(join(project, "BPP", "panel.bpp"), "MANUAL OPERATOR EDIT\n");
    const result = await runWorkspaceOnce({ rootDirectory: root });
    expect(result.summary.conflicts).toBe(1);
    expect(await readFile(join(project, "BPP", "panel.bpp"), "utf8")).toBe("MANUAL OPERATOR EDIT\n");
  });

  it("automatically combines a stable f0/f1 export pair into one tracked two-sided BPP", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc-watch-"));
    temporaryDirectories.push(root);
    const project = join(root, "Two sided top");
    await import("node:fs/promises").then(module => module.mkdir(project));
    const source = await readFile(new URL("../../../fixtures/synthetic/minimal.cix", import.meta.url), "utf8");
    await writeFile(join(project, "Tetolap_1_f0.cix"), source);
    await writeFile(join(project, "Tetolap_1_f1.cix"), source.replace("PARAM,NAME=X,VALUE=20", "PARAM,NAME=X,VALUE=25"));

    const first = await runWorkspaceOnce({ rootDirectory: root });
    expect(first.summary).toMatchObject({ total: 1, converted: 1, blocked: 0, conflicts: 0 });
    const bpp = await readFile(join(project, "BPP", "Tetolap_1_f1.bpp"), "utf8");
    expect(bpp).toMatch(/@ WAIT, "", "", \d+, "", 0 : 1, 5, 0, 0, 1/);
    await expect(readFile(join(project, "BPP", "Tetolap_1_f0.bpp"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const manifest = JSON.parse(await readFile(join(project, "BPP", "opencnc-sync-manifest.json"), "utf8")) as { entries: Array<{ name: string; outputName: string }> };
    expect(manifest.entries).toEqual([
      expect.objectContaining({ name: "Tetolap_1_f0.cix", outputName: "Tetolap_1_f1.bpp" }),
      expect.objectContaining({ name: "Tetolap_1_f1.cix", outputName: "Tetolap_1_f1.bpp" })
    ]);
    const report = JSON.parse(await readFile(join(project, "BPP", "opencnc-conversion-report.json"), "utf8")) as { summary: { sourceFiles: number; total: number; twoSidedPairs: number } };
    expect(report.summary).toMatchObject({ sourceFiles: 2, total: 1, twoSidedPairs: 1 });

    const second = await runWorkspaceOnce({ rootDirectory: root });
    expect(second.summary).toMatchObject({ unchanged: 1, conflicts: 0 });
  });
});
