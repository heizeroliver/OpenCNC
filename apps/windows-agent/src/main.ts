import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from "electron";
import type { AgentConfiguration, AgentJobHistoryRecord } from "../../../packages/agent-core/src/index.js";
import { SqliteAgentStore } from "../../../packages/agent-core/src/sqlite-store.js";
import { openVerifiedBppOutputs, type BiesseWorksOpenResult } from "./biesseworks.js";
import { AgentFileLogger } from "./logging.js";
import { LocalAgentService, type LocalAgentMode, type LocalAgentNotification, type LocalAgentState } from "./service.js";

export interface AgentBuildInfo {
  schemaVersion: 1;
  version: string;
  commit: string;
  shortCommit: string;
  ref: string;
  commitTime: string;
  dirty: boolean;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let tray: Tray | undefined;
let agentWindow: BrowserWindow | undefined;
let viewerWindow: BrowserWindow | undefined;
let service: LocalAgentService | undefined;
let store: SqliteAgentStore | undefined;
let logger: AgentFileLogger | undefined;
let buildInfo: AgentBuildInfo | undefined;
let shuttingDown = false;
let pendingAgentView: "status" | "jobs" | "errors" | "settings" = "status";
let trayRefreshQueue: Promise<void> = Promise.resolve();
let lastLoggedState = "";

const appRoot = (): string => app.getAppPath();
const dataPath = (name: string): string => join(app.getPath("userData"), name);
const errorText = (error: unknown): string => error instanceof Error ? error.stack ?? error.message : String(error);

const log = (level: "info" | "warning" | "error", message: string, details?: unknown): void => {
  const operation = logger?.write(level, message, details);
  if (!operation) {
    if (level === "error") console.error(message, details);
    return;
  }
  void operation.catch(error => { console.error(`OpenCNC logging failed: ${errorText(error)}`); });
};

const runBackground = (operation: string, promise: Promise<unknown>): void => {
  void promise.catch(error => {
    console.error(`${operation}: ${errorText(error)}`);
    log("error", `${operation} failed`, { error: errorText(error) });
  });
};

const readBuildInfo = async (): Promise<AgentBuildInfo> => {
  try {
    const value = JSON.parse(await readFile(join(appRoot(), "dist", "build-info.json"), "utf8")) as AgentBuildInfo;
    if (value.schemaVersion !== 1 || typeof value.version !== "string" || typeof value.commit !== "string") throw new Error("Invalid build-info.json");
    return value;
  } catch {
    return {
      schemaVersion: 1,
      version: app.getVersion(),
      commit: "unknown",
      shortCommit: "unknown",
      ref: "unknown",
      commitTime: "unknown",
      dirty: false
    };
  }
};

const modeColor: Record<LocalAgentMode, string> = {
  setup: "#64748b",
  running: "#16a34a",
  paused: "#64748b",
  processing: "#2563eb",
  warning: "#d97706",
  error: "#dc2626",
  stopped: "#334155"
};

const trayIcon = (mode: LocalAgentMode) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="${modeColor[mode]}"/><path fill="white" d="M8 10h16v4H12v8h12v4H8z"/><circle cx="22" cy="18" r="3" fill="white"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`).resize({ width: 16, height: 16 });
};

const secureWindowOptions = () => ({
  show: false,
  backgroundColor: "#07111f",
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true
  }
});

const openExternalHttpUrl = (url: string): void => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error(`Blocked external protocol ${parsed.protocol}`);
    runBackground("Open external URL", shell.openExternal(parsed.toString()));
  } catch (error) {
    log("warning", "Blocked invalid external URL", { url, error: errorText(error) });
  }
};

const installNavigationGuards = (window: BrowserWindow): void => {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttpUrl(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
      log("warning", "Blocked renderer navigation", { url });
    }
  });
};

const sendPendingAgentView = (): void => {
  if (!agentWindow || agentWindow.isDestroyed() || agentWindow.webContents.isLoadingMainFrame()) return;
  agentWindow.webContents.send("agent:navigate", pendingAgentView);
};

const createAgentWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    ...secureWindowOptions(),
    width: 1040,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    title: "OpenCNC Local Agent",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(appRoot(), "apps", "windows-agent", "preload.cjs")
    }
  });
  installNavigationGuards(window);
  window.webContents.on("did-finish-load", sendPendingAgentView);
  runBackground("Load Local Agent window", window.loadFile(join(appRoot(), "apps", "windows-agent", "ui", "index.html")));
  window.on("close", event => {
    if (!shuttingDown) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => { agentWindow = undefined; });
  return window;
};

const showAgentWindow = (view: "status" | "jobs" | "errors" | "settings" = "status"): void => {
  pendingAgentView = view;
  if (!agentWindow || agentWindow.isDestroyed()) agentWindow = createAgentWindow();
  agentWindow.show();
  agentWindow.focus();
  sendPendingAgentView();
};

const openOpenCnc = (): void => {
  if (!viewerWindow || viewerWindow.isDestroyed()) {
    viewerWindow = new BrowserWindow({ ...secureWindowOptions(), width: 1360, height: 900, minWidth: 960, minHeight: 680, title: "OpenCNC" });
    installNavigationGuards(viewerWindow);
    runBackground("Load OpenCNC viewer", viewerWindow.loadFile(join(appRoot(), "apps", "viewer", "dist", "index.html")));
    viewerWindow.on("closed", () => { viewerWindow = undefined; });
  }
  viewerWindow.show();
  viewerWindow.focus();
};

const applyAutoStart = (enabled: boolean): void => {
  if (process.platform !== "win32") return;
  app.setLoginItemSettings({
    name: "OpenCNC Local Agent",
    openAtLogin: enabled,
    path: process.execPath,
    args: ["--hidden"]
  });
};

const notify = (notification: LocalAgentNotification): void => {
  log(notification.level, notification.title, { body: notification.body });
  if (!Notification.isSupported()) return;
  new Notification({ title: notification.title, body: notification.body, silent: notification.level === "info" }).show();
};

const openPath = async (path: string | undefined): Promise<void> => {
  if (!path) return;
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
};

const openJobOutputsInBiesseWorks = async (jobId: unknown): Promise<BiesseWorksOpenResult> => {
  if (typeof jobId !== "string" || !jobId || jobId.length > 200) throw new Error("A valid conversion job ID is required");
  if (!store) throw new Error("Agent history is not ready");
  const job = (await store.recentJobs(10_000)).find(record => record.id === jobId);
  if (!job) throw new Error("The selected conversion is no longer available in job history");
  log("info", `Opening verified BPP batch in BiesseWorks: ${job.projectName}`, { jobId: job.id, outputNames: job.outputNames });
  try {
    const result = await openVerifiedBppOutputs(job, path => shell.openPath(path));
    log("info", `Opened ${result.openedCount} BPP file(s) in BiesseWorks: ${job.projectName}`, { jobId: job.id, outputNames: result.outputNames });
    return result;
  } catch (error) {
    log("warning", `Could not open BPP batch in BiesseWorks: ${job.projectName}`, { jobId: job.id, error: errorText(error) });
    throw error;
  }
};

const refreshTray = async (): Promise<void> => {
  if (!tray || !service) return;
  const snapshot = await service.snapshot(8);
  const current = snapshot.state;
  tray.setImage(trayIcon(current.mode));
  tray.setToolTip(`OpenCNC Local Agent — ${current.mode}: ${current.message}`);
  tray.setTitle(process.platform === "darwin" ? current.mode === "processing" ? " CNC" : "" : "");
  const recentItems: MenuItemConstructorOptions[] = snapshot.recentJobs.slice(0, 5).map(job => ({
    label: `${job.projectName}: ${job.status}`,
    click: () => showAgentWindow("jobs")
  }));
  const template: MenuItemConstructorOptions[] = [
    { label: `Status: ${current.mode}`, enabled: false },
    { label: current.message, enabled: false },
    { type: "separator" },
    { label: "Open OpenCNC", click: openOpenCnc },
    { label: "Open Local Agent", click: () => showAgentWindow("status") },
    { label: "Open monitored folder", enabled: Boolean(snapshot.configuration.parentProjectsFolder), click: () => { runBackground("Open monitored folder", openPath(snapshot.configuration.parentProjectsFolder)); } },
    { label: "Open logs folder", click: () => { runBackground("Open logs folder", openPath(app.getPath("userData"))); } },
    { type: "separator" },
    {
      label: snapshot.configuration.automationEnabled ? "Pause automation" : "Resume automation",
      click: () => { runBackground("Change automation state", service!.setAutomationEnabled(!snapshot.configuration.automationEnabled)); }
    },
    { label: "Convert now", enabled: snapshot.configuration.automationEnabled && Boolean(snapshot.configuration.parentProjectsFolder), click: () => { runBackground("Manual conversion cycle", service!.runCycle()); } },
    { label: "Change monitored folder…", click: () => { runBackground("Choose monitored folder", chooseParentFolder()); } },
    { label: "Recent jobs", submenu: recentItems.length ? recentItems : [{ label: "No jobs yet", enabled: false }] },
    { label: "View all jobs", click: () => showAgentWindow("jobs") },
    { label: "View errors", click: () => showAgentWindow("errors") },
    { label: "Settings", click: () => showAgentWindow("settings") },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: snapshot.configuration.autoStart,
      click: item => { runBackground("Change Windows startup setting", updateConfiguration({ autoStart: item.checked })); }
    },
    { type: "separator" },
    { label: "Exit", click: () => app.quit() }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
};

const queueTrayRefresh = (): void => {
  trayRefreshQueue = trayRefreshQueue.then(refreshTray).catch(error => {
    console.error(`Refresh tray failed: ${errorText(error)}`);
    log("error", "Refresh tray failed", { error: errorText(error) });
  });
};

const updateConfiguration = async (changes: Partial<AgentConfiguration>): Promise<AgentConfiguration> => {
  if (!service) throw new Error("Agent service is not ready");
  const before = (await service.snapshot(1)).configuration;
  const next = await service.updateConfiguration(changes);
  if (before.autoStart !== next.autoStart) applyAutoStart(next.autoStart);
  await logger?.write("info", "Configuration updated", { ...next, machineProfilePath: next.machineProfilePath ? "configured" : undefined });
  await refreshTray();
  agentWindow?.webContents.send("agent:state", (await service.snapshot(1)).state);
  return next;
};

const chooseParentFolder = async (): Promise<string | undefined> => {
  const options = { title: "Choose the parent CNC projects folder", properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
  const result = agentWindow ? await dialog.showOpenDialog(agentWindow, options) : await dialog.showOpenDialog(options);
  const selected = result.filePaths[0];
  if (!result.canceled && selected) {
    await updateConfiguration({ parentProjectsFolder: selected });
    showAgentWindow("settings");
    return selected;
  }
  return undefined;
};

const chooseMachineProfile = async (): Promise<string | undefined> => {
  const options = { title: "Choose an OpenCNC machine profile", properties: ["openFile"] as Array<"openFile">, filters: [{ name: "JSON machine profile", extensions: ["json"] }] };
  const result = agentWindow ? await dialog.showOpenDialog(agentWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
};

const assertAgentSender = (event: IpcMainInvokeEvent): void => {
  if (!agentWindow || agentWindow.isDestroyed() || event.sender.id !== agentWindow.webContents.id) throw new Error("Rejected IPC request from an untrusted renderer");
};

const allowedConfigurationKeys = new Set<keyof AgentConfiguration>([
  "schemaVersion", "automationEnabled", "parentProjectsFolder", "outputFolder", "scanIntervalSeconds", "stabilityScans",
  "qaEnabled", "machineProfilePath", "autoStart", "retryInitialSeconds", "retryMaximumSeconds", "notifyOnSuccess"
]);

const validateConfigurationChanges = (value: unknown): Partial<AgentConfiguration> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration changes must be an object");
  for (const key of Object.keys(value)) if (!allowedConfigurationKeys.has(key as keyof AgentConfiguration)) throw new Error(`Unsupported configuration key: ${key}`);
  return value as Partial<AgentConfiguration>;
};

const registerIpc = (): void => {
  ipcMain.handle("agent:snapshot", event => { assertAgentSender(event); return service!.snapshot(100); });
  ipcMain.handle("agent:about", event => { assertAgentSender(event); return structuredClone(buildInfo!); });
  ipcMain.handle("agent:choose-parent-folder", event => { assertAgentSender(event); return chooseParentFolder(); });
  ipcMain.handle("agent:choose-machine-profile", event => { assertAgentSender(event); return chooseMachineProfile(); });
  ipcMain.handle("agent:update-configuration", (event, changes: unknown) => { assertAgentSender(event); return updateConfiguration(validateConfigurationChanges(changes)); });
  ipcMain.handle("agent:set-enabled", async (event, enabled: unknown) => {
    assertAgentSender(event);
    if (typeof enabled !== "boolean") throw new Error("Automation state must be a boolean");
    await service!.setAutomationEnabled(enabled);
    await refreshTray();
  });
  ipcMain.handle("agent:run-now", async event => { assertAgentSender(event); await service!.runCycle(); return service!.snapshot(100); });
  ipcMain.handle("agent:open-bpp-in-biesseworks", (event, jobId: unknown) => { assertAgentSender(event); return openJobOutputsInBiesseWorks(jobId); });
  ipcMain.handle("agent:open-monitored-folder", async event => { assertAgentSender(event); return openPath((await service!.snapshot(1)).configuration.parentProjectsFolder); });
  ipcMain.handle("agent:open-data-folder", event => { assertAgentSender(event); return openPath(app.getPath("userData")); });
  ipcMain.handle("agent:open-opencnc", event => { assertAgentSender(event); return openOpenCnc(); });
};

const logState = (state: LocalAgentState): void => {
  if (state.mode === "processing") return;
  const signature = `${state.mode}\u0000${state.message}\u0000${state.rootFailureCount}`;
  if (signature === lastLoggedState) return;
  lastLoggedState = signature;
  log(state.mode === "error" ? "error" : state.mode === "warning" ? "warning" : "info", `Agent state: ${state.mode}`, state);
};

const logJob = (job: AgentJobHistoryRecord, previousStatus: AgentJobHistoryRecord["status"] | undefined): void => {
  const level = job.status === "retrying" || job.status === "failed" ? "error" : job.status === "blocked" || job.status === "conflicted" ? "warning" : "info";
  log(level, `Job ${job.status}: ${job.projectName}`, {
    jobId: job.id,
    previousStatus,
    projectPath: job.projectKey,
    fingerprint: job.fingerprint,
    retryCount: job.retryCount,
    sourceNames: job.sourceNames,
    outputNames: job.outputNames,
    inputChecksums: job.inputChecksums,
    outputChecksums: job.outputChecksums,
    message: job.message
  });
};

const shutdown = async (): Promise<void> => {
  let exitCode = 0;
  try {
    await logger?.write("info", "OpenCNC Local Agent shutting down", { version: buildInfo?.version, commit: buildInfo?.commit });
    await service?.stop();
    await trayRefreshQueue;
  } catch (error) {
    exitCode = 1;
    console.error(`OpenCNC shutdown failed: ${errorText(error)}`);
    try { await logger?.write("error", "Shutdown failed", { error: errorText(error) }); }
    catch (loggingError) { console.error(`OpenCNC logging failed: ${errorText(loggingError)}`); }
  } finally {
    try { store?.close(); }
    catch (error) { exitCode = 1; console.error(`OpenCNC database close failed: ${errorText(error)}`); }
    try { await logger?.flush(); }
    catch (error) { exitCode = 1; console.error(`OpenCNC log flush failed: ${errorText(error)}`); }
    if (exitCode) app.exit(exitCode);
    else app.quit();
  }
};

app.on("second-instance", () => showAgentWindow("status"));
app.on("window-all-closed", () => undefined);
app.on("before-quit", event => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  runBackground("Application shutdown", shutdown());
});

if (gotLock) void app.whenReady().then(async () => {
  app.setAppUserModelId("com.opencnc.localagent");
  buildInfo = await readBuildInfo();
  logger = new AgentFileLogger(dataPath("opencnc-agent.log"));
  await logger.write("info", "OpenCNC Local Agent starting", {
    version: buildInfo.version,
    commit: buildInfo.commit,
    ref: buildInfo.ref,
    dirty: buildInfo.dirty,
    userData: app.getPath("userData")
  });
  store = new SqliteAgentStore(dataPath("opencnc-agent.sqlite"));
  service = new LocalAgentService(store, {
    onState: state => {
      logState(state);
      agentWindow?.webContents.send("agent:state", state);
      if (!shuttingDown) queueTrayRefresh();
    },
    onNotification: notify,
    onJob: logJob
  });

  if (process.argv.includes("--smoke-test")) {
    await service.start();
    const snapshot = await service.snapshot(1);
    await logger.write("info", "Installed application smoke test passed", { state: snapshot.state.mode, database: dataPath("opencnc-agent.sqlite") });
    await service.stop();
    store.close();
    await logger.write("info", "OpenCNC Local Agent smoke test shutting down", { version: buildInfo.version, commit: buildInfo.commit });
    await logger.flush();
    app.exit(0);
    return;
  }

  registerIpc();
  tray = new Tray(trayIcon("setup"));
  tray.on("click", () => showAgentWindow("status"));
  await service.start();
  const snapshot = await service.snapshot(1);
  applyAutoStart(snapshot.configuration.autoStart);
  await refreshTray();
  if (!process.argv.includes("--hidden") || !snapshot.configuration.parentProjectsFolder) showAgentWindow(snapshot.configuration.parentProjectsFolder ? "status" : "settings");
}).catch(async error => {
  const message = errorText(error);
  console.error(message);
  try {
    await logger?.write("error", "OpenCNC Local Agent could not start", { error: message });
    await logger?.flush();
  } catch (loggingError) { console.error(`OpenCNC logging failed: ${errorText(loggingError)}`); }
  dialog.showErrorBox("OpenCNC Local Agent could not start", message);
  try { store?.close(); } catch { /* startup error is already surfaced */ }
  app.exit(1);
});
