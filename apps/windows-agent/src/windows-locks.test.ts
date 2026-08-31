import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convertNodeWorkspaceProject, discoverNodeWorkspaceProjects } from "../../../packages/agent-core/src/node-workspace.js";

const roots: string[] = [];
const locks: ChildProcessWithoutNullStreams[] = [];
const fixture = join(process.cwd(), "fixtures", "synthetic", "minimal.cix");

const acquireExclusiveWindowsLock = async (path: string): Promise<ChildProcessWithoutNullStreams> => {
  const script = "$stream=[System.IO.File]::Open($env:OPENCNC_LOCK_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); Write-Output 'LOCKED'; [Console]::Out.Flush(); Start-Sleep -Seconds 60";
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, OPENCNC_LOCK_PATH: path },
    stdio: "pipe"
  });
  locks.push(child);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out acquiring exclusive Windows file lock")), 10_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.stdout.on("data", chunk => {
      if (!String(chunk).includes("LOCKED")) return;
      clearTimeout(timeout);
      resolve();
    });
    child.stderr.on("data", chunk => {
      const message = String(chunk).trim();
      if (message) { clearTimeout(timeout); reject(new Error(message)); }
    });
  });
  return child;
};

const releaseLock = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode === null) child.kill();
  await new Promise<void>(resolve => child.exitCode === null ? child.once("exit", () => resolve()) : resolve());
  const index = locks.indexOf(child);
  if (index >= 0) locks.splice(index, 1);
};

afterEach(async () => {
  for (const lock of locks.splice(0)) if (lock.exitCode === null) lock.kill();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === "win32")("real Windows exclusive-lock recovery", () => {
  it("retries safely after exclusive CIX and BPP locks are released", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc windows lock "));
    roots.push(root);
    const projectDirectory = join(root, "Locked project");
    await mkdir(projectDirectory);
    const sourcePath = join(projectDirectory, "panel.cix");
    await copyFile(fixture, sourcePath);

    const initialProject = (await discoverNodeWorkspaceProjects(root))[0]!;
    const sourceLock = await acquireExclusiveWindowsLock(sourcePath);
    await expect(convertNodeWorkspaceProject(initialProject)).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM|EBUSY/) });
    await releaseLock(sourceLock);
    expect((await convertNodeWorkspaceProject(initialProject)).status).toBe("converted");

    const source = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, source.replace("PARAM,NAME=DP,VALUE=10", "PARAM,NAME=DP,VALUE=11"), "utf8");
    const changedProject = (await discoverNodeWorkspaceProjects(root))[0]!;
    const outputPath = join(projectDirectory, "BPP", "panel.bpp");
    const outputLock = await acquireExclusiveWindowsLock(outputPath);
    await expect(convertNodeWorkspaceProject(changedProject)).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM|EBUSY/) });
    await releaseLock(outputLock);
    expect((await convertNodeWorkspaceProject(changedProject)).status).toBe("converted");
  });
});
