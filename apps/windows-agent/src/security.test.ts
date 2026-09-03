import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): Promise<string> => readFile(join(process.cwd(), path), "utf8");

describe("Windows Electron security posture", () => {
  it("keeps every renderer isolated, sandboxed, and without Node integration", async () => {
    const main = await source("apps/windows-agent/src/main.ts");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("webSecurity: true");
    expect(main).not.toMatch(/nodeIntegration:\s*true/);
  });

  it("limits navigation, external protocols, IPC senders, and preload exposure", async () => {
    const [main, preload] = await Promise.all([
      source("apps/windows-agent/src/main.ts"),
      source("apps/windows-agent/preload.cjs")
    ]);
    expect(main).toContain('parsed.protocol !== "https:"');
    expect(main).toContain("setWindowOpenHandler");
    expect(main).toContain("will-navigate");
    expect(main).toContain("assertAgentSender(event)");
    expect(main).not.toMatch(/loadURL\(["']https?:/);
    expect(preload).toContain("contextBridge.exposeInMainWorld");
    expect(preload).toContain('require("electron")');
    expect(preload.match(/require\(/g)).toHaveLength(1);
  });

  it("applies a restrictive Content Security Policy to both local interfaces", async () => {
    const pages = await Promise.all([
      source("apps/windows-agent/ui/index.html"),
      source("apps/viewer/index.html")
    ]);
    for (const page of pages) {
      expect(page).toContain("Content-Security-Policy");
      expect(page).toContain("script-src 'self'");
      expect(page).toContain("object-src 'none'");
    }
  });

  it("loads and packages the production viewer from Vite's actual output directory", async () => {
    const [main, builder] = await Promise.all([
      source("apps/windows-agent/src/main.ts"),
      source("electron-builder.yml")
    ]);
    expect(main).toContain('join(appRoot(), "apps", "viewer", "dist", "index.html")');
    expect(builder).toContain("apps/viewer/dist/**/*");
  });

  it("opens BiesseWorks batches by persisted job ID rather than renderer-supplied paths", async () => {
    const [main, preload, launcher, bridge, builder] = await Promise.all([
      source("apps/windows-agent/src/main.ts"),
      source("apps/windows-agent/preload.cjs"),
      source("apps/windows-agent/src/biesseworks.ts"),
      source("apps/windows-agent/resources/biesseworks-bridge.ps1"),
      source("electron-builder.yml")
    ]);
    expect(preload).toContain('openBppInBiesseWorks: jobId => ipcRenderer.invoke("agent:open-bpp-in-biesseworks", jobId)');
    expect(main).toContain('(await store.recentJobs(10_000)).find(record => record.id === jobId)');
    expect(main).toContain('assertAgentSender(event); return openJobOutputsInBiesseWorks(jobId)');
    expect(launcher).toContain('sha256(await read(output.path)) !== output.checksum');
    expect(launcher).toContain('extname(name).toLowerCase() !== ".bpp"');
    expect(bridge).toContain("Get-FileHash -LiteralPath $output.path -Algorithm SHA256");
    expect(bridge).toContain("FindMainWindow");
    expect(bridge).toContain("SendMessageText(fileName, 0x000C");
    expect(bridge).toContain("PostMessage(openButton, 0x00F5");
    expect(bridge).not.toContain("SetWindowText");
    expect(bridge).toContain("$interFileDelayMilliseconds = 3000");
    expect(bridge).toContain("$visibleFileDialog = [OpenCncBiesseWindows]::FindFileDialog");
    expect(bridge).toContain('[System.Windows.Forms.SendKeys]::SendWait("^o")');
    expect(bridge).not.toMatch(/Set-ItemProperty|New-ItemProperty|reg\.exe|reg add/i);
    expect(builder).toContain("apps/windows-agent/resources/biesseworks-bridge.ps1");
  });

  it("opens project folders only after resolving them from the current service inventory", async () => {
    const [main, preload] = await Promise.all([
      source("apps/windows-agent/src/main.ts"),
      source("apps/windows-agent/preload.cjs")
    ]);
    expect(preload).toContain('openProjectFolder: directory => ipcRenderer.invoke("agent:open-project-folder", directory)');
    expect(main).toContain("const folder = await currentProjectFolder(directory)");
    expect(main).toContain("projectFolders.find(candidate => candidate.directory === directory)");
  });
});
