import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentJobHistoryRecord } from "../../../packages/agent-core/src/index.js";
import { openVerifiedBppOutputs, resolveVerifiedBppOutputDirectory, resolveVerifiedBppOutputs } from "./biesseworks.js";

const roots: string[] = [];
const checksum = (value: string): string => createHash("sha256").update(value).digest("hex");

const job = (outputDirectory: string, outputNames: string[], contents: Record<string, string>): AgentJobHistoryRecord => ({
  id: "job-1",
  projectKey: join(outputDirectory, ".."),
  projectName: "Kitchen doors",
  fingerprint: "fingerprint",
  sourceNames: ["doors.cix"],
  outputNames,
  outputDirectory,
  detectedAt: new Date(0).toISOString(),
  completedAt: new Date(1).toISOString(),
  status: "completed",
  retryCount: 0,
  inputChecksums: { "doors.cix": checksum("source") },
  outputChecksums: Object.fromEntries(Object.entries(contents).map(([name, value]) => [name, checksum(value)])),
  verified: true,
  reverseVerified: true,
  qaEnabled: false
});

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("BiesseWorks verified batch launcher", () => {
  it("opens every checksum-matched output from one completed conversion", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc biesseworks "));
    roots.push(root);
    const contents = { "Ajtó 1.bpp": "first output", "Ajtó 2.bpp": "second output" };
    await Promise.all(Object.entries(contents).map(([name, value]) => writeFile(join(root, name), value)));
    const opened: string[] = [];

    const result = await openVerifiedBppOutputs(job(root, Object.keys(contents), contents), async outputs => { opened.push(...outputs.map(output => output.path)); return outputs.length; }, { platform: "win32" });

    expect(result).toEqual({ jobId: "job-1", projectName: "Kitchen doors", openedCount: 2, outputNames: ["Ajtó 1.bpp", "Ajtó 2.bpp"] });
    expect(opened).toEqual([join(root, "Ajtó 1.bpp"), join(root, "Ajtó 2.bpp")]);
    expect(resolveVerifiedBppOutputDirectory(job(root, Object.keys(contents), contents))).toBe(root);
  });

  it("rejects unsafe or unverified history without opening anything", async () => {
    const base = job(tmpdir(), ["part.bpp"], { "part.bpp": "output" });
    const opened: string[] = [];
    await expect(openVerifiedBppOutputs({ ...base, verified: false }, async outputs => { opened.push(...outputs.map(output => output.path)); return outputs.length; }, { platform: "win32" })).rejects.toThrow("fully verified");
    expect(() => resolveVerifiedBppOutputs({ ...base, outputNames: ["..\\part.bpp"] })).toThrow("Unsafe BPP output name");
    expect(opened).toEqual([]);
  });

  it("checks the whole batch before launch and blocks a changed output", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc biesseworks changed "));
    roots.push(root);
    const contents = { "one.bpp": "one", "two.bpp": "two" };
    await writeFile(join(root, "one.bpp"), contents["one.bpp"]);
    await writeFile(join(root, "two.bpp"), "externally changed");
    const opened: string[] = [];

    await expect(openVerifiedBppOutputs(job(root, Object.keys(contents), contents), async outputs => { opened.push(...outputs.map(output => output.path)); return outputs.length; }, { platform: "win32" })).rejects.toThrow("changed after its verified conversion");
    expect(opened).toEqual([]);
  });

  it("rejects an incomplete result returned by the sequential bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc biesseworks association "));
    roots.push(root);
    const contents = { "one.bpp": "one", "two.bpp": "two" };
    await Promise.all(Object.entries(contents).map(([name, value]) => writeFile(join(root, name), value)));

    await expect(openVerifiedBppOutputs(job(root, Object.keys(contents), contents), async () => 1, { platform: "win32" }))
      .rejects.toThrow("BiesseWorks opened 1/2 verified BPP file(s)");
  });
});
