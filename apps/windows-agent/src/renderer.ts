import type { AgentConfiguration, AgentJobHistoryRecord, AgentLanguage } from "../../../packages/agent-core/src/index.js";
import type { LocalAgentProjectFolder, LocalAgentProjectFolderStatus, LocalAgentSnapshot, LocalAgentState } from "./service.js";

interface AgentBuildInfo { version: string; commit: string; shortCommit: string; ref: string; dirty: boolean; }
interface BiesseWorksOpenResult { jobId: string; projectName: string; openedCount: number; outputNames: string[]; }
interface BiesseWorksProgress { jobId: string; projectName: string; state: "waiting_permission" | "starting" | "opening" | "completed" | "failed"; current: number; total: number; fileName?: string; message?: string; }
interface OpenCncAgentApi {
  snapshot(): Promise<LocalAgentSnapshot>;
  about(): Promise<AgentBuildInfo>;
  chooseParentFolder(): Promise<string | undefined>;
  chooseMachineProfile(): Promise<string | undefined>;
  updateConfiguration(configuration: Partial<AgentConfiguration>): Promise<AgentConfiguration>;
  setAutomationEnabled(enabled: boolean): Promise<void>;
  runNow(): Promise<LocalAgentSnapshot>;
  openBppInBiesseWorks(jobId: string): Promise<BiesseWorksOpenResult>;
  openProjectFolder(directory: string): Promise<void>;
  openProjectOutputFolder(directory: string): Promise<void>;
  openMonitoredFolder(): Promise<void>;
  openDataFolder(): Promise<void>;
  openOpenCnc(): Promise<void>;
  onState(callback: (state: LocalAgentState) => void): () => void;
  onBiesseWorksProgress(callback: (progress: BiesseWorksProgress) => void): () => void;
  onNavigate(callback: (view: "status" | "jobs" | "errors" | "settings") => void): () => void;
}
declare global { interface Window { opencncAgent: OpenCncAgentApi } }

const translations = {
  en: {
    localAgent: "Local Agent", navStatus: "Status", navJobs: "Recent jobs", navErrors: "Errors", navSettings: "Settings",
    openOpenCnc: "Open OpenCNC", automationStatus: "AUTOMATION STATUS", projectsMonitored: "Projects monitored", nextScan: "Next scan",
    scanNow: "Scan and convert now", openBppFolder: "Open latest BPP folder", openMonitoredFolder: "Open monitored folder",
    guardedOutput: "Guarded production output", guardedOutputDetail: "OpenCNC treats CIX inputs as read-only and writes only fully verified conversions into the configured output subfolder. Existing BPP files are updated only when their checksum still matches the previous OpenCNC manifest. Vendor simulation remains required before machining.",
    localHistory: "LOCAL SQLITE HISTORY", recentJobs: "Recent jobs", project: "Project", status: "Status", sources: "Sources", outputs: "Outputs", checksums: "Checksums", time: "Time", message: "Message", noJobs: "No matching jobs yet.",
    localConfiguration: "LOCAL WINDOWS CONFIGURATION", settings: "Settings", workspace: "Workspace", parentFolder: "Parent projects folder", choose: "Choose…", outputFolderName: "Output folder name pattern", outputPatternHint: "Use {projectName} for the project folder name. Default: {projectName}_bpp",
    monitoringRetry: "Monitoring and retry", scanInterval: "Scan interval (seconds)", stableScans: "Stable scans required", firstRetry: "First retry (seconds)", maximumRetry: "Maximum retry (seconds)",
    verification: "Verification", machineProfile: "Machine profile", noProfile: "No profile selected", clear: "Clear", generateQa: "Generate QA PDF job sheets",
    agentBehavior: "Agent behavior", language: "Language", automationRunning: "Automation running", startWindows: "Start after Windows login", notifySuccess: "Notify for ordinary successful conversions", saveSettings: "Save settings", openData: "Open data and logs folder",
    projectFolders: "PROJECT FOLDERS", folderOverview: "Folder overview", folder: "Folder", noFolders: "No project folders found.", openSelectedBpp: "Open selected BPPs in BiesseWorks", openSelectedOutput: "Open selected output folder", openSelectedProject: "Open selected project folder",
    biesseWorksHint: "Opens verified BPPs one by one through BiesseWorks File → Open. Approve the Windows permission request once, then avoid using BiesseWorks until the batch finishes."
  },
  hu: {
    localAgent: "Helyi ügynök", navStatus: "Állapot", navJobs: "Legutóbbi feladatok", navErrors: "Hibák", navSettings: "Beállítások",
    openOpenCnc: "OpenCNC megnyitása", automationStatus: "AUTOMATIZÁLÁS ÁLLAPOTA", projectsMonitored: "Figyelt projektek", nextScan: "Következő ellenőrzés",
    scanNow: "Ellenőrzés és konvertálás most", openBppFolder: "Legutóbbi BPP-mappa megnyitása", openMonitoredFolder: "Figyelt mappa megnyitása",
    guardedOutput: "Védett gyártási kimenet", guardedOutputDetail: "Az OpenCNC a CIX-bemeneteket csak olvassa, és kizárólag teljesen ellenőrzött konverziókat ír a beállított kimeneti almappába. Meglévő BPP-fájlt csak akkor frissít, ha annak ellenőrzőösszege még megegyezik az előző OpenCNC-jegyzékkel. A megmunkálás előtt továbbra is szükséges a gyártói szimuláció.",
    localHistory: "HELYI SQLITE ELŐZMÉNYEK", recentJobs: "Legutóbbi feladatok", project: "Projekt", status: "Állapot", sources: "Források", outputs: "Kimenetek", checksums: "Ellenőrzőösszegek", time: "Idő", message: "Üzenet", noJobs: "Még nincs megfelelő feladat.",
    localConfiguration: "HELYI WINDOWS-BEÁLLÍTÁSOK", settings: "Beállítások", workspace: "Munkaterület", parentFolder: "Projektek szülőmappája", choose: "Kiválasztás…", outputFolderName: "Kimeneti mappa névmintája", outputPatternHint: "A projektmappa nevéhez használja a {projectName} helyőrzőt. Alapérték: {projectName}_bpp",
    monitoringRetry: "Figyelés és újrapróbálkozás", scanInterval: "Ellenőrzési időköz (másodperc)", stableScans: "Szükséges stabil ellenőrzések", firstRetry: "Első újrapróbálkozás (másodperc)", maximumRetry: "Legnagyobb újrapróbálkozási idő (másodperc)",
    verification: "Ellenőrzés", machineProfile: "Gépprofil", noProfile: "Nincs profil kiválasztva", clear: "Törlés", generateQa: "QA PDF munkalapok készítése",
    agentBehavior: "Ügynök működése", language: "Nyelv", automationRunning: "Automatizálás fut", startWindows: "Indítás Windows-bejelentkezés után", notifySuccess: "Értesítés a szokásos sikeres konverziókról", saveSettings: "Beállítások mentése", openData: "Adat- és naplómappa megnyitása",
    projectFolders: "PROJEKTMAPPÁK", folderOverview: "Mappák áttekintése", folder: "Mappa", noFolders: "Nem található projektmappa.", openSelectedBpp: "Kijelölt BPP-k megnyitása a BiesseWorksben", openSelectedOutput: "Kijelölt kimeneti mappa megnyitása", openSelectedProject: "Kijelölt projektmappa megnyitása",
    biesseWorksHint: "Az ellenőrzött BPP-ket egyenként nyitja meg a BiesseWorks Fájl → Megnyitás funkciójával. Egyszer engedélyezze a Windows-kérést, majd a folyamat végéig ne használja a BiesseWorksöt."
  }
} as const;
type TranslationKey = keyof typeof translations.en;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element ${id}`);
  return element as T;
};
const form = byId<HTMLFormElement>("settings-form");
const statusDot = byId<HTMLElement>("status-dot");
const statusMode = byId<HTMLElement>("status-mode");
const statusMessage = byId<HTMLElement>("status-message");
const statusProjects = byId<HTMLElement>("status-projects");
const statusNext = byId<HTMLElement>("status-next");
const jobsBody = byId<HTMLTableSectionElement>("jobs-body");
const emptyJobs = byId<HTMLElement>("empty-jobs");
const errorBanner = byId<HTMLElement>("error-banner");
let snapshot: LocalAgentSnapshot;
let currentView: "status" | "jobs" | "errors" | "settings" = "status";
let selectedProjectDirectory: string | undefined;
let biesseWorksBusy = false;
let biesseWorksToastTimer: ReturnType<typeof setTimeout> | undefined;

const language = (): AgentLanguage => snapshot?.configuration.language ?? "en";
const t = (key: TranslationKey): string => translations[language()][key];
const dateTime = (value: string | undefined): string => value ? new Date(value).toLocaleString(language() === "hu" ? "hu-HU" : "en-GB") : "—";
const compactChecksum = (value: string): string => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "—";
const applyTranslations = (): void => {
  document.documentElement.lang = language();
  document.title = language() === "hu" ? "OpenCNC helyi ügynök" : "OpenCNC Local Agent";
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]")) element.textContent = t(element.dataset.i18n as TranslationKey);
  for (const element of document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) element.placeholder = t(element.dataset.i18nPlaceholder as TranslationKey);
};
const modeText = (mode: LocalAgentState["mode"]): string => language() === "en" ? mode.replaceAll("_", " ") : ({ setup: "beállítás szükséges", running: "fut", paused: "szünetel", processing: "feldolgozás", warning: "figyelmeztetés", error: "hiba", stopped: "leállítva" } as const)[mode];
const statusText = (status: AgentJobHistoryRecord["status"]): string => language() === "en" ? status.replaceAll("_", " ") : ({ detected: "észlelve", waiting_for_stability: "stabilitásra vár", queued: "sorban áll", converting: "konvertálás", completed: "kész", retrying: "újrapróbálás", blocked: "blokkolva", conflicted: "ütközés", failed: "sikertelen" } as const)[status];
const stateMessageText = (state: LocalAgentState): string => {
  if (language() === "en" || /[áéíóöőúüű]/i.test(state.message)) return state.message;
  const exact: Record<string, string> = {
    "OpenCNC Local Agent is stopped": "Az OpenCNC helyi ügynök leállítva",
    "Choose the parent projects folder to begin monitoring": "A figyelés megkezdéséhez válassza ki a projektek szülőmappáját",
    "Automation is paused": "Az automatizálás szünetel",
    "Scanning projects and processing eligible exports": "Projektek ellenőrzése és a megfelelő exportok feldolgozása",
    "One or more projects will retry after a temporary failure": "Egy vagy több projekt átmeneti hiba után újra lesz próbálva",
    "One or more projects require attention": "Egy vagy több projekt figyelmet igényel"
  };
  if (exact[state.message]) return exact[state.message]!;
  const monitored = /^(\d+) project\(s\) monitored$/.exec(state.message);
  if (monitored) return `${monitored[1]} projekt figyelve`;
  return state.message;
};
const folderStatusText = (status: LocalAgentProjectFolderStatus): string => {
  const english: Record<LocalAgentProjectFolderStatus, string> = { converted: "Converted", ready: "Ready", waiting: "In progress", attention: "Needs attention", ignored_existing: "Existing · not enrolled", no_cix: "No CIX" };
  const hungarian: Record<LocalAgentProjectFolderStatus, string> = { converted: "Konvertálva", ready: "Kész a konvertálásra", waiting: "Folyamatban", attention: "Figyelmet igényel", ignored_existing: "Meglévő · nincs bevonva", no_cix: "Nincs CIX" };
  return (language() === "hu" ? hungarian : english)[status];
};
const showError = (error: unknown): void => { errorBanner.textContent = error instanceof Error ? error.message : String(error); errorBanner.hidden = false; };
const clearError = (): void => { errorBanner.hidden = true; errorBanner.textContent = ""; };

const renderState = (state: LocalAgentState): void => {
  snapshot.state = state;
  statusDot.dataset.mode = state.mode;
  statusMode.textContent = modeText(state.mode);
  statusMessage.textContent = stateMessageText(state);
  statusProjects.textContent = String(state.projectCount);
  statusNext.textContent = state.nextScanAt ? dateTime(state.nextScanAt) : "—";
  const enabled = snapshot.configuration.automationEnabled;
  byId<HTMLButtonElement>("toggle-automation").textContent = enabled ? language() === "hu" ? "Automatizálás szüneteltetése" : "Pause automation" : language() === "hu" ? "Automatizálás folytatása" : "Resume automation";
};

const renderConfiguration = (configuration: AgentConfiguration): void => {
  snapshot.configuration = configuration;
  byId<HTMLSelectElement>("language").value = configuration.language;
  byId<HTMLInputElement>("parent-folder").value = configuration.parentProjectsFolder;
  byId<HTMLInputElement>("output-folder").value = configuration.outputFolder;
  byId<HTMLInputElement>("scan-interval").value = String(configuration.scanIntervalSeconds);
  byId<HTMLInputElement>("stability-scans").value = String(configuration.stabilityScans);
  byId<HTMLInputElement>("retry-initial").value = String(configuration.retryInitialSeconds);
  byId<HTMLInputElement>("retry-maximum").value = String(configuration.retryMaximumSeconds);
  byId<HTMLInputElement>("qa-enabled").checked = configuration.qaEnabled;
  byId<HTMLInputElement>("auto-start").checked = configuration.autoStart;
  byId<HTMLInputElement>("notify-success").checked = configuration.notifyOnSuccess;
  byId<HTMLInputElement>("machine-profile").value = configuration.machineProfilePath ?? "";
  byId<HTMLInputElement>("automation-enabled").checked = configuration.automationEnabled;
  const enrollment = configuration.projectEnrollment;
  byId("enrollment-summary").textContent = enrollment ? language() === "hu"
    ? `Csak a ${dateTime(enrollment.initializedAt)} után létrehozott projektmappák automatikusak. ${enrollment.ignoredProjectDirectories.length} korábbi mappa kihagyva.`
    : `Only project folders created after ${dateTime(enrollment.initializedAt)} are automated. ${enrollment.ignoredProjectDirectories.length} earlier folder(s) ignored.`
    : language() === "hu" ? "Az első ellenőrzés rögzíti a meglévő mappákat; csak az ezután létrehozott projektek lesznek automatikusak." : "The first scan records existing folders; only projects created afterward will be automated.";
};

const checksumSummary = (job: AgentJobHistoryRecord): string => {
  const input = Object.values(job.inputChecksums)[0];
  const output = Object.values(job.outputChecksums)[0];
  return `${input ? compactChecksum(input) : "—"} → ${output ? compactChecksum(output) : "—"}`;
};
const latestOpenableJob = (jobs: AgentJobHistoryRecord[]): AgentJobHistoryRecord | undefined => jobs.filter(job => job.status === "completed" && job.verified === true && job.reverseVerified === true && Boolean(job.outputDirectory) && job.outputNames.length > 0).sort((left, right) => (right.completedAt ?? right.detectedAt).localeCompare(left.completedAt ?? left.detectedAt))[0];
const renderBiesseWorksAction = (jobs: AgentJobHistoryRecord[]): void => {
  const button = byId<HTMLButtonElement>("open-latest-bpp");
  const folderButton = byId<HTMLButtonElement>("open-latest-folder");
  const job = latestOpenableJob(jobs);
  button.disabled = !job || biesseWorksBusy;
  folderButton.disabled = !job;
  button.textContent = job ? language() === "hu" ? `Legutóbbi megnyitása a BiesseWorksben: ${job.projectName} (${job.outputNames.length} BPP)` : `Open latest in BiesseWorks: ${job.projectName} (${job.outputNames.length} BPP)` : language() === "hu" ? "Még nincs ellenőrzött BPP-fájl" : "No verified BPP files yet";
  button.title = job ? language() === "hu" ? "Az ellenőrzött fájlok egyenként nyílnak meg a BiesseWorks Fájl → Megnyitás funkciójával." : "Open each verified file through BiesseWorks File → Open." : language() === "hu" ? "Először futtasson egy új, ellenőrzött CIX → BPP konverziót" : "Run a new verified CIX to BPP conversion first";
};
const renderJobs = (jobs: AgentJobHistoryRecord[]): void => {
  const filtered = currentView === "errors" ? jobs.filter(job => ["blocked", "conflicted", "failed", "retrying"].includes(job.status)) : jobs;
  jobsBody.replaceChildren();
  emptyJobs.hidden = filtered.length > 0;
  for (const job of filtered) {
    const row = document.createElement("tr");
    for (const value of [job.projectName, statusText(job.status), job.sourceNames.join(", "), job.outputNames.join(", ") || "—", checksumSummary(job), dateTime(job.completedAt ?? job.startedAt ?? job.detectedAt), job.message ?? "—"]) {
      const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
    }
    row.dataset.status = job.status; jobsBody.append(row);
  }
  renderBiesseWorksAction(jobs);
};

const selectedProject = (): LocalAgentProjectFolder | undefined => snapshot.projectFolders.find(folder => folder.directory === selectedProjectDirectory);
const renderProjectFolders = (): void => {
  const folders = snapshot.projectFolders;
  if (selectedProjectDirectory && !folders.some(folder => folder.directory === selectedProjectDirectory)) selectedProjectDirectory = undefined;
  const list = byId<HTMLElement>("project-folder-list"); list.replaceChildren();
  byId("empty-folders").hidden = folders.length > 0;
  byId("folder-count").textContent = language() === "hu" ? `${folders.length} mappa` : `${folders.length} folder${folders.length === 1 ? "" : "s"}`;
  for (const folder of folders) {
    const row = document.createElement("button"); row.type = "button"; row.className = `project-row${folder.directory === selectedProjectDirectory ? " selected" : ""}`;
    row.addEventListener("click", () => { selectedProjectDirectory = folder.directory; renderProjectFolders(); });
    const name = document.createElement("span"); name.className = "folder-name";
    const strong = document.createElement("strong"); strong.textContent = folder.name;
    name.style.paddingLeft = `${Math.min(folder.depth, 8) * 14}px`;
    const path = document.createElement("small"); path.textContent = folder.relativePath; path.title = folder.outputDirectory;
    name.append(strong, path);
    const cix = document.createElement("span"); cix.textContent = String(folder.cixCount);
    const bpp = document.createElement("span"); bpp.textContent = String(folder.bppCount);
    const status = document.createElement("span"); status.className = "folder-status"; status.dataset.status = folder.status; status.textContent = folderStatusText(folder.status);
    row.append(name, cix, bpp, status); list.append(row);
  }
  const selected = selectedProject();
  byId<HTMLButtonElement>("open-selected-project").disabled = !selected;
  byId<HTMLButtonElement>("open-selected-output").disabled = !selected || selected.bppCount === 0;
  byId<HTMLButtonElement>("open-selected-bpp").disabled = !selected?.latestJobId || biesseWorksBusy;
};

const navigate = (view: typeof currentView): void => {
  currentView = view;
  for (const section of document.querySelectorAll<HTMLElement>("[data-view]")) section.hidden = section.dataset.view !== view && !(view === "errors" && section.dataset.view === "jobs");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-nav]")) button.classList.toggle("active", button.dataset.nav === view);
  renderJobs(snapshot.recentJobs);
};
const renderAll = (): void => { applyTranslations(); renderConfiguration(snapshot.configuration); renderState(snapshot.state); renderJobs(snapshot.recentJobs); renderProjectFolders(); };
const refresh = async (): Promise<void> => { snapshot = await window.opencncAgent.snapshot(); renderAll(); };
const renderBuildInfo = (value: AgentBuildInfo): void => {
  byId("build-version").textContent = `${language() === "hu" ? "Verzió" : "Version"} ${value.version}`;
  byId("build-commit").textContent = `Commit ${value.shortCommit}${value.dirty ? " (dirty)" : ""}`;
  byId("build-commit").title = `${value.commit} · ${value.ref}`;
};
const showBiesseWorksComplete = (result: BiesseWorksOpenResult): void => {
  const toast = byId<HTMLElement>("biesseworks-complete-toast");
  toast.textContent = language() === "hu"
    ? `${result.openedCount}/${result.outputNames.length} BPP megnyitási művelet befejeződött a BiesseWorksben.`
    : `${result.openedCount}/${result.outputNames.length} BPP open operations completed in BiesseWorks.`;
  toast.hidden = false;
  if (biesseWorksToastTimer) clearTimeout(biesseWorksToastTimer);
  biesseWorksToastTimer = setTimeout(() => { toast.hidden = true; }, 8_000);
};
const openJobInBiesseWorks = async (jobId: string): Promise<void> => {
  const confirmation = byId<HTMLElement>("biesseworks-confirmation");
  biesseWorksBusy = true;
  renderBiesseWorksAction(snapshot.recentJobs);
  renderProjectFolders();
  confirmation.textContent = language() === "hu" ? "Rendszergazdai engedélyre vár…" : "Waiting for Windows administrator permission…";
  try {
    const result = await window.opencncAgent.openBppInBiesseWorks(jobId);
    confirmation.textContent = language() === "hu" ? `${result.openedCount}/${result.outputNames.length} BPP megnyitva a BiesseWorksben (${result.projectName}).` : `${result.openedCount}/${result.outputNames.length} BPP file(s) opened in BiesseWorks (${result.projectName}).`;
    showBiesseWorksComplete(result);
  } finally {
    biesseWorksBusy = false;
    renderBiesseWorksAction(snapshot.recentJobs);
    renderProjectFolders();
  }
};

document.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.nav as typeof currentView)));
byId("choose-folder").addEventListener("click", async () => { const value = await window.opencncAgent.chooseParentFolder(); if (value) byId<HTMLInputElement>("parent-folder").value = value; await refresh(); });
byId("choose-profile").addEventListener("click", async () => { const value = await window.opencncAgent.chooseMachineProfile(); if (value) byId<HTMLInputElement>("machine-profile").value = value; });
byId("clear-profile").addEventListener("click", () => { byId<HTMLInputElement>("machine-profile").value = ""; });
byId("open-folder").addEventListener("click", () => { void window.opencncAgent.openMonitoredFolder(); });
byId("open-data").addEventListener("click", () => { void window.opencncAgent.openDataFolder(); });
byId("open-opencnc").addEventListener("click", () => { void window.opencncAgent.openOpenCnc(); });
byId("run-now").addEventListener("click", async () => { clearError(); try { snapshot = await window.opencncAgent.runNow(); renderAll(); } catch (error) { showError(error); } });
byId("open-latest-bpp").addEventListener("click", async () => { clearError(); const job = latestOpenableJob(snapshot.recentJobs); if (!job) return; try { await openJobInBiesseWorks(job.id); } catch (error) { byId("biesseworks-confirmation").textContent = ""; showError(error); } });
byId("open-latest-folder").addEventListener("click", () => { const job = latestOpenableJob(snapshot.recentJobs); if (job) void window.opencncAgent.openProjectOutputFolder(job.projectKey).catch(showError); });
byId("open-selected-project").addEventListener("click", () => { const folder = selectedProject(); if (folder) void window.opencncAgent.openProjectFolder(folder.directory).catch(showError); });
byId("open-selected-output").addEventListener("click", () => { const folder = selectedProject(); if (folder) void window.opencncAgent.openProjectOutputFolder(folder.directory).catch(showError); });
byId("open-selected-bpp").addEventListener("click", async () => { const jobId = selectedProject()?.latestJobId; if (!jobId) return; clearError(); try { await openJobInBiesseWorks(jobId); } catch (error) { byId("biesseworks-confirmation").textContent = ""; showError(error); } });
byId("toggle-automation").addEventListener("click", async () => { clearError(); try { await window.opencncAgent.setAutomationEnabled(!snapshot.configuration.automationEnabled); await refresh(); } catch (error) { showError(error); } });
byId<HTMLSelectElement>("language").addEventListener("change", async event => {
  clearError();
  try { snapshot.configuration = await window.opencncAgent.updateConfiguration({ language: (event.currentTarget as HTMLSelectElement).value as AgentLanguage }); renderAll(); renderBuildInfo(await window.opencncAgent.about()); }
  catch (error) { showError(error); }
});
form.addEventListener("submit", async event => {
  event.preventDefault(); clearError(); const machineProfilePath = byId<HTMLInputElement>("machine-profile").value.trim();
  try {
    const configuration = await window.opencncAgent.updateConfiguration({
      language: byId<HTMLSelectElement>("language").value as AgentLanguage,
      automationEnabled: byId<HTMLInputElement>("automation-enabled").checked,
      parentProjectsFolder: byId<HTMLInputElement>("parent-folder").value,
      outputFolder: byId<HTMLInputElement>("output-folder").value,
      scanIntervalSeconds: Number(byId<HTMLInputElement>("scan-interval").value),
      stabilityScans: Number(byId<HTMLInputElement>("stability-scans").value),
      retryInitialSeconds: Number(byId<HTMLInputElement>("retry-initial").value),
      retryMaximumSeconds: Number(byId<HTMLInputElement>("retry-maximum").value),
      qaEnabled: byId<HTMLInputElement>("qa-enabled").checked,
      autoStart: byId<HTMLInputElement>("auto-start").checked,
      notifyOnSuccess: byId<HTMLInputElement>("notify-success").checked,
      ...(machineProfilePath ? { machineProfilePath } : { machineProfilePath: undefined })
    });
    renderConfiguration(configuration);
    byId("save-confirmation").textContent = language() === "hu" ? "Beállítások mentve" : "Settings saved";
    setTimeout(() => { byId("save-confirmation").textContent = ""; }, 2_000);
  } catch (error) { showError(error); }
});

window.opencncAgent.onState(state => { if (snapshot) renderState(state); void refresh(); });
window.opencncAgent.onBiesseWorksProgress(progress => {
  const confirmation = byId<HTMLElement>("biesseworks-confirmation");
  if (progress.state === "waiting_permission") confirmation.textContent = language() === "hu" ? "Rendszergazdai engedélyre vár…" : "Waiting for Windows administrator permission…";
  else if (progress.state === "starting") confirmation.textContent = language() === "hu" ? "BiesseWorks indítása…" : "Starting BiesseWorks…";
  else if (progress.state === "opening") confirmation.textContent = language() === "hu" ? `Megnyitás ${progress.current}/${progress.total}: ${progress.fileName ?? "BPP"}` : `Opening ${progress.current}/${progress.total}: ${progress.fileName ?? "BPP"}`;
});
window.opencncAgent.onNavigate(view => navigate(view));
void Promise.all([window.opencncAgent.snapshot(), window.opencncAgent.about()]).then(([initialSnapshot, info]) => {
  snapshot = initialSnapshot;
  renderAll();
  renderBuildInfo(info);
  navigate(currentView);
}).catch(showError);
