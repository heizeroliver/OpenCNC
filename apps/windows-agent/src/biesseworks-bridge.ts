import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifiedBppOutput } from "./biesseworks.js";

export type BiesseWorksBridgeState = "waiting_permission" | "starting" | "opening" | "completed" | "failed";

export interface BiesseWorksBridgeProgress {
  state: BiesseWorksBridgeState;
  current: number;
  total: number;
  fileName?: string;
  message?: string;
}

interface BridgeResult extends BiesseWorksBridgeProgress {
  schemaVersion: 1;
  openedCount: number;
}

export interface BiesseWorksBridgeOptions {
  scriptPath: string;
  outputs: VerifiedBppOutput[];
  onProgress?(progress: BiesseWorksBridgeProgress): void;
  systemRoot?: string;
}

const psLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const quotedProcessArgument = (value: string): string => {
  if (value.includes('"')) throw new Error("BiesseWorks bridge paths cannot contain quotation marks");
  return `"${value}"`;
};

export const elevatedBridgeCommand = (powershellPath: string, scriptPath: string, requestPath: string, resultPath: string): string => {
  const childArguments = [
    "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File",
    quotedProcessArgument(scriptPath), "-RequestPath", quotedProcessArgument(requestPath), "-ResultPath", quotedProcessArgument(resultPath)
  ];
  return [
    "$ErrorActionPreference='Stop'",
    `$bridgeArguments=@(${childArguments.map(psLiteral).join(",")})`,
    `try{$process=Start-Process -FilePath ${psLiteral(powershellPath)} -ArgumentList $bridgeArguments -Verb RunAs -Wait -PassThru;exit $process.ExitCode}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}`
  ].join(";");
};

const parseResult = async (path: string): Promise<BridgeResult | undefined> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<BridgeResult>;
    if (value.schemaVersion !== 1 || !["waiting_permission", "starting", "opening", "completed", "failed"].includes(value.state ?? "")) return undefined;
    if (!Number.isInteger(value.current) || !Number.isInteger(value.total) || !Number.isInteger(value.openedCount)) return undefined;
    return value as BridgeResult;
  } catch { return undefined; }
};

export async function runBiesseWorksBridge(options: BiesseWorksBridgeOptions): Promise<number> {
  if (process.platform !== "win32") throw new Error("The BiesseWorks File → Open bridge is available only on Windows");
  if (!options.outputs.length) throw new Error("The BiesseWorks bridge requires at least one verified BPP output");
  await access(options.scriptPath);

  const root = await mkdtemp(join(tmpdir(), "opencnc-biesseworks-"));
  const requestPath = join(root, "request.json");
  const resultPath = join(root, "result.json");
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const powershellPath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const request = {
    schemaVersion: 1,
    outputs: options.outputs.map(output => ({ name: output.name, path: output.path, checksum: output.checksum }))
  };

  await writeFile(requestPath, JSON.stringify(request), { encoding: "utf8", mode: 0o600 });
  options.onProgress?.({ state: "waiting_permission", current: 0, total: options.outputs.length });
  const encoded = Buffer.from(elevatedBridgeCommand(powershellPath, options.scriptPath, requestPath, resultPath), "utf16le").toString("base64");
  let lastProgress = "";
  let polling = false;
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const result = await parseResult(resultPath);
      if (!result) return;
      const signature = JSON.stringify(result);
      if (signature !== lastProgress) {
        lastProgress = signature;
        options.onProgress?.({ state: result.state, current: result.current, total: result.total, ...(result.fileName ? { fileName: result.fileName } : {}), ...(result.message ? { message: result.message } : {}) });
      }
    } finally { polling = false; }
  };

  let stderr = "";
  const timer = setInterval(() => { void poll(); }, 200);
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(powershellPath, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("close", code => resolve(code ?? 1));
    });
    await poll();
    const result = await parseResult(resultPath);
    if (!result) throw new Error(exitCode === 0 ? "BiesseWorks bridge did not return a result" : `Administrator permission was cancelled or the BiesseWorks bridge could not start${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    if (result.state !== "completed" || exitCode !== 0) throw new Error(result.message || `BiesseWorks bridge exited with code ${exitCode}`);
    return result.openedCount;
  } finally {
    clearInterval(timer);
    await rm(root, { recursive: true, force: true });
  }
}
