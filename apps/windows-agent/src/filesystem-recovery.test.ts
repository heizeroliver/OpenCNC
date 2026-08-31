import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NODE_WORKSPACE_MANIFEST_FILE,
  atomicWorkspaceWrite,
  convertNodeWorkspaceProject,
  discoverNodeWorkspaceProjects
} from "../../../packages/agent-core/src/node-workspace.js";

const temporaryRoots: string[] = [];
const fixture = join(process.cwd(), "fixtures", "synthetic", "minimal.cix");

const temporaryRoot = async (label: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `opencnc ${label} `));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("local agent filesystem and recovery matrix", () => {
  it("ignores empty projects and converts Unicode files in paths with spaces", async () => {
    const root = await temporaryRoot("árvíztűrő workspace");
    await mkdir(join(root, "Empty project"));
    const projectDirectory = join(root, "Konyha felső elemek");
    await mkdir(projectDirectory);
    await copyFile(fixture, join(projectDirectory, "Tetőlap ágyútükör.cix"));

    const projects = await discoverNodeWorkspaceProjects(root);
    expect(projects.map(project => project.name)).toEqual(["Konyha felső elemek"]);
    const result = await convertNodeWorkspaceProject(projects[0]!);
    expect(result).toMatchObject({ status: "converted", verified: true, reverseVerified: true, outputNames: ["Tetőlap ágyútükör.bpp"] });
    expect(await stat(join(projectDirectory, "BPP", "Tetőlap ágyútükör.bpp"))).toMatchObject({ isFile: expect.any(Function) });
  });

  it.runIf(process.platform === "win32")("handles a Windows path longer than the legacy 260-character limit", async () => {
    const root = await temporaryRoot("long path");
    const projectDirectory = join(root, `Project ${"x".repeat(140)}`);
    const sourceName = `árvíztűrő tükörfúrógép ${"y".repeat(90)}.cix`;
    await mkdir(projectDirectory);
    await copyFile(fixture, join(projectDirectory, sourceName));
    expect(join(projectDirectory, sourceName).length).toBeGreaterThan(260);
    const projects = await discoverNodeWorkspaceProjects(root);
    const result = await convertNodeWorkspaceProject(projects[0]!);
    expect(result.status).toBe("converted");
    expect(await stat(join(projectDirectory, "BPP", sourceName.replace(/\.cix$/i, ".bpp")))).toMatchObject({ isFile: expect.any(Function) });
  });

  it("blocks a stable but incomplete CIX export without creating production output", async () => {
    const root = await temporaryRoot("partial export");
    const projectDirectory = join(root, "Incomplete");
    await mkdir(projectDirectory);
    await writeFile(join(projectDirectory, "partial.cix"), "BEGIN MAINDATA\r\nLPX=800\r\nLPY=400\r\nLPZ=18\r\nBEGIN MACRO\r\nNAME=BG\r\n", "utf8");
    const projects = await discoverNodeWorkspaceProjects(root);
    const result = await convertNodeWorkspaceProject(projects[0]!);
    expect(result.status).toBe("blocked");
    await expect(stat(join(projectDirectory, "BPP"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite a manually edited BPP after its CIX source changes", async () => {
    const root = await temporaryRoot("manual protection");
    const projectDirectory = join(root, "Protected");
    await mkdir(projectDirectory);
    const sourcePath = join(projectDirectory, "panel.cix");
    await copyFile(fixture, sourcePath);
    const firstProject = (await discoverNodeWorkspaceProjects(root))[0]!;
    expect((await convertNodeWorkspaceProject(firstProject)).status).toBe("converted");
    const outputPath = join(projectDirectory, "BPP", "panel.bpp");
    const original = await readFile(outputPath, "utf8");
    await writeFile(outputPath, `${original}\r\n; MANUAL BIESSE EDIT\r\n`, "utf8");
    await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}\r\n; NEW EXPORT COMMENT\r\n`, "utf8");

    const changedProject = (await discoverNodeWorkspaceProjects(root))[0]!;
    const result = await convertNodeWorkspaceProject(changedProject);
    expect(result).toMatchObject({ status: "conflict", conflicts: ["panel.bpp"] });
    expect(await readFile(outputPath, "utf8")).toContain("MANUAL BIESSE EDIT");
  });

  it("leaves no temporary sibling after a successful atomic replacement", async () => {
    const root = await temporaryRoot("atomic");
    const target = join(root, "BPP", "panel.bpp");
    await mkdir(dirname(target));
    await atomicWorkspaceWrite(target, "first");
    await atomicWorkspaceWrite(target, "second");
    expect(await readFile(target, "utf8")).toBe("second");
    expect((await readdir(dirname(target))).filter(name => name.startsWith(`.opencnc-${basename(target)}`))).toEqual([]);
  });

  it("writes the manifest last with verified source and output checksums", async () => {
    const root = await temporaryRoot("manifest");
    const projectDirectory = join(root, "Manifest");
    await mkdir(projectDirectory);
    await copyFile(fixture, join(projectDirectory, "panel.cix"));
    const project = (await discoverNodeWorkspaceProjects(root))[0]!;
    const result = await convertNodeWorkspaceProject(project);
    const manifest = JSON.parse(await readFile(join(projectDirectory, "BPP", NODE_WORKSPACE_MANIFEST_FILE), "utf8")) as { entries: Array<{ sourceChecksum: string; targetChecksum: string; verified: boolean; reverseVerified: boolean }> };
    expect(result).toMatchObject({ status: "converted", verified: true, reverseVerified: true });
    expect(manifest.entries[0]).toMatchObject({ sourceChecksum: result.inputChecksums?.["panel.cix"], targetChecksum: result.outputChecksums?.["panel.bpp"], verified: true, reverseVerified: true });
  });
});
