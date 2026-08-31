import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { WatchAttemptController, discoverWatchProjects, exponentialRetryDelay, runWatchCycle, runWorkspaceOnce, type WatchProjectResult } from "./workspace-watch.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("unattended workspace watcher", () => {
  it("retries an unchanged project after transient failures with bounded exponential backoff, then clears retry state", async () => {
    const project = { name: "Network project", directory: "Z:\\Network project", files: [], fingerprint: "stable-fingerprint" };
    const controller = new WatchAttemptController({ stabilityScans: 1, initialDelayMs: 100, maximumDelayMs: 250 });
    const events: string[] = [];
    let now = 0;
    let attempts = 0;
    const unchanged: WatchProjectResult = {
      projectName: project.name, status: "unchanged", sourceCount: 1, written: 0, updated: 0, unchanged: 1,
      conflicts: [], orphanedOutputs: [], outputDirectory: "Z:\\Network project\\BPP", message: "output already current"
    };
    const cycle = (): Promise<void> => runWatchCycle(
      { rootDirectory: "Z:\\", intervalSeconds: 1, onEvent: message => events.push(message) },
      controller,
      {
        discover: async () => [project],
        convert: async () => {
          attempts += 1;
          if (attempts < 3) throw Object.assign(new Error("file is temporarily locked"), { code: "EBUSY" });
          return unchanged;
        },
        now: () => now
      }
    );

    await cycle();
    expect(attempts).toBe(1);
    expect(controller.snapshot(project.directory)).toMatchObject({ status: "retrying", retryCount: 1, nextAttemptAt: 100 });
    now = 99;
    await cycle();
    expect(attempts).toBe(1);
    now = 100;
    await cycle();
    expect(attempts).toBe(2);
    expect(controller.snapshot(project.directory)).toMatchObject({ status: "retrying", retryCount: 2, nextAttemptAt: 300 });
    now = 299;
    await cycle();
    expect(attempts).toBe(2);
    now = 300;
    await cycle();
    expect(attempts).toBe(3);
    expect(controller.snapshot(project.directory)).toMatchObject({ status: "completed", retryCount: 0 });
    now = 10_000;
    await cycle();
    expect(attempts).toBe(3);
    expect(events.filter(message => message.includes("transient failure"))).toHaveLength(2);
  });

  it("caps exponential retry delays", () => {
    expect([1, 2, 3, 4, 20].map(retry => exponentialRetryDelay(retry, 100, 250))).toEqual([100, 200, 250, 250, 250]);
  });

  it("does not retry a permanent conflict until the source fingerprint changes", async () => {
    const project = { name: "Conflict", directory: "C:\\Conflict", files: [], fingerprint: "one" };
    const controller = new WatchAttemptController({ stabilityScans: 1 });
    let attempts = 0;
    const conflict: WatchProjectResult = {
      projectName: project.name, status: "conflict", sourceCount: 1, written: 0, updated: 0, unchanged: 0,
      conflicts: ["part.bpp"], orphanedOutputs: [], outputDirectory: "C:\\Conflict\\BPP", message: "manual output edit"
    };
    const cycle = (): Promise<void> => runWatchCycle(
      { rootDirectory: "C:\\", intervalSeconds: 1, onEvent: () => undefined }, controller,
      { discover: async () => [project], convert: async () => { attempts += 1; return conflict; }, now: () => 0 }
    );
    await cycle();
    await cycle();
    expect(attempts).toBe(1);
    expect(controller.snapshot(project.directory)?.status).toBe("conflicted");
    project.fingerprint = "two";
    await cycle();
    expect(attempts).toBe(2);
  });

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
