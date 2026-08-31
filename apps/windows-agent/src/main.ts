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
  type MenuItemConstructorOptions
} from "electron";
import type { AgentConfiguration } from "../../../packages/agent-core/src/index.js";
import { SqliteAgentStore } from "../../../packages/agent-core/src/sqlite-store.js";
import { AgentFileLogger } from "./logging.js";
import { LocalAgentService, type LocalAgentMode, type LocalAgentNotification, type LocalAgentState } from "./service.js";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let tray: Tray | undefined;
let agentWindow: BrowserWindow | undefined;
let viewerWindow: BrowserWindow | undefined;
let service: LocalAgentService | undefined;
let store: SqliteAgentStore | undefined;
let logger: AgentFileLogger | undefined;
let shuttingDown = false;

const appRoot = (): string => app.getAppPath();
const dataPath = (name: string): string => join(app.getPath("userData"), name);

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
    sandbox: true
  }
});

const installNavigationGuards = (window: BrowserWindow): void => {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
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
      preload: join(appRoot(), "apps", "windows-agent", "preload.cjs")
    }
  });
  installNavigationGuards(window);
  void window.loadFile(join(appRoot(), "apps", "windows-agent", "ui", "index.html"));
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
  if (!agentWindow || agentWindow.isDestroyed()) agentWindow = createAgentWindow();
  agentWindow.show();
  agentWindow.focus();
  agentWindow.webContents.send("agent:navigate", view);
};

const openOpenCnc = (): void => {
  if (!viewerWindow || viewerWindow.isDestroyed()) {
    viewerWindow = new BrowserWindow({ ...secureWindowOptions(), width: 1360, height: 900, minWidth: 960, minHeight: 680, title: "OpenCNC" });
    installNavigationGuards(viewerWindow);
    void viewerWindow.loadFile(join(appRoot(), "dist", "index.html"));
    viewerWindow.on("closed", () => { viewerWindow = undefined; });
  }
  viewerWindow.show();
  viewerWindow.focus();
};

const applyAutoStart = (enabled: boolean): void => {
  if (process.platform !== "win32") return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: ["--hidden"]
  });
};

const notify = (notification: LocalAgentNotification): void => {
  void logger?.write(notification.level, notification.title, { body: notification.body });
  if (!Notification.isSupported()) return;
  new Notification({ title: notification.title, body: notification.body, silent: notification.level === "info" }).show();
};

const openPath = async (path: string | undefined): Promise<void> => {
  if (!path) return;
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
};

const refreshTray = async (state?: LocalAgentState): Promise<void> => {
  if (!tray || !service) return;
  const snapshot = await service.snapshot(8);
  const current = state ?? snapshot.state;
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
    { label: "Open monitored folder", enabled: Boolean(snapshot.configuration.parentProjectsFolder), click: () => { void openPath(snapshot.configuration.parentProjectsFolder); } },
    { type: "separator" },
    {
      label: snapshot.configuration.automationEnabled ? "Pause automation" : "Resume automation",
      click: () => { void service!.setAutomationEnabled(!snapshot.configuration.automationEnabled); }
    },
    { label: "Convert now", enabled: snapshot.configuration.automationEnabled && Boolean(snapshot.configuration.parentProjectsFolder), click: () => { void service!.runCycle(); } },
    { label: "Change monitored folder…", click: () => { void chooseParentFolder(); } },
    { label: "Recent jobs", submenu: recentItems.length ? recentItems : [{ label: "No jobs yet", enabled: false }] },
    { label: "View all jobs", click: () => showAgentWindow("jobs") },
    { label: "View errors", click: () => showAgentWindow("errors") },
    { label: "Settings", click: () => showAgentWindow("settings") },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: snapshot.configuration.autoStart,
      click: item => { void updateConfiguration({ autoStart: item.checked }); }
    },
    { type: "separator" },
    { label: "Exit", click: () => app.quit() }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
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

const registerIpc = (): void => {
  ipcMain.handle("agent:snapshot", () => service!.snapshot(100));
  ipcMain.handle("agent:choose-parent-folder", chooseParentFolder);
  ipcMain.handle("agent:choose-machine-profile", chooseMachineProfile);
  ipcMain.handle("agent:update-configuration", (_event, changes: Partial<AgentConfiguration>) => updateConfiguration(changes));
  ipcMain.handle("agent:set-enabled", async (_event, enabled: boolean) => { await service!.setAutomationEnabled(Boolean(enabled)); await refreshTray(); });
  ipcMain.handle("agent:run-now", async () => { await service!.runCycle(); return service!.snapshot(100); });
  ipcMain.handle("agent:open-monitored-folder", async () => openPath((await service!.snapshot(1)).configuration.parentProjectsFolder));
  ipcMain.handle("agent:open-data-folder", () => openPath(app.getPath("userData")));
  ipcMain.handle("agent:open-opencnc", () => openOpenCnc());
};

app.on("second-instance", () => showAgentWindow("status"));
app.on("window-all-closed", () => undefined);
app.on("before-quit", event => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void (async () => {
    await service?.stop();
    await logger?.flush();
    store?.close();
    app.quit();
  })();
});

if (gotLock) void app.whenReady().then(async () => {
  app.setAppUserModelId("com.opencnc.localagent");
  logger = new AgentFileLogger(dataPath("opencnc-agent.log"));
  store = new SqliteAgentStore(dataPath("opencnc-agent.sqlite"));
  service = new LocalAgentService(store, {
    onState: state => {
      void logger?.write(state.mode === "error" ? "error" : state.mode === "warning" ? "warning" : "info", state.message, state);
      agentWindow?.webContents.send("agent:state", state);
      void refreshTray(state);
    },
    onNotification: notify
  });
  registerIpc();
  tray = new Tray(trayIcon("setup"));
  tray.on("click", () => showAgentWindow("status"));
  await service.start();
  const snapshot = await service.snapshot(1);
  applyAutoStart(snapshot.configuration.autoStart);
  await refreshTray(snapshot.state);
  if (!process.argv.includes("--hidden") || !snapshot.configuration.parentProjectsFolder) showAgentWindow(snapshot.configuration.parentProjectsFolder ? "status" : "settings");
}).catch(error => {
  void dialog.showErrorBox("OpenCNC Local Agent could not start", error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});
