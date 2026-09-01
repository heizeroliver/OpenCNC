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
    expect(main).toContain('parsed.protocol !== "https:" && parsed.protocol !== "http:"');
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
});
