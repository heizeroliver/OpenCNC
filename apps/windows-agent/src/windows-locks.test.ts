import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { convertNodeWorkspaceProject, discoverNodeWorkspaceProjects } from "../../../packages/agent-core/src/node-workspace.js";

const roots: string[] = [];
const locks: ChildProcessWithoutNullStreams[] = [];
const fixture = join(process.cwd(), "fixtures", "synthetic", "minimal.cix");

const acquireExclusiveWindowsLock = async (path: string): Promise<ChildProcessWithoutNullStreams> => {
  const readyPath = join(tmpdir(), `opencnc-lock-ready-${randomUUID()}`);
  const script = "$stream=[System.IO.File]::Open($env:OPENCNC_LOCK_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); [System.IO.File]::WriteAllText($env:OPENCNC_LOCK_READY,'LOCKED'); Start-Sleep -Seconds 60";
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, OPENCNC_LOCK_PATH: path, OPENCNC_LOCK_READY: readyPath },
    stdio: "pipe"
  });
  locks.push(child);
  let spawnError: Error | undefined;
  let stderr = "";
  child.once("error", error => { spawnError = error; });
  child.stderr.on("data", chunk => { stderr += String(chunk); });

  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) {
        throw new Error(`Windows lock helper exited with code ${child.exitCode}: ${stderr.trim() || "no diagnostic output"}`);
      }
      try {
        if ((await readFile(readyPath, "utf8")) === "LOCKED") return child;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out acquiring exclusive Windows file lock: ${stderr.trim() || "helper produced no diagnostic output"}`);
  } finally {
    await rm(readyPath, { force: true });
  }
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
  it("retries safely after exclusive CIX and BPP locks are released", { timeout: 90_000 }, async () => {
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
    const originalOutput = await readFile(outputPath);
    const outputLock = await acquireExclusiveWindowsLock(outputPath);
    await expect(convertNodeWorkspaceProject(changedProject)).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM|EBUSY/) });
    expect((await readdir(join(projectDirectory, "BPP"))).filter(name => name.startsWith(".opencnc-") && name.endsWith(".tmp"))).toEqual([]);
    await releaseLock(outputLock);
    expect(await readFile(outputPath)).toEqual(originalOutput);
    expect((await convertNodeWorkspaceProject(changedProject)).status).toBe("converted");
  });
});
