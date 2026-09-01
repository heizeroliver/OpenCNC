import type { AgentConfiguration, AgentJobHistoryRecord } from "../../../packages/agent-core/src/index.js";
import type { LocalAgentSnapshot, LocalAgentState } from "./service.js";

interface AgentBuildInfo {
  version: string;
  commit: string;
  shortCommit: string;
  ref: string;
  dirty: boolean;
}

interface BiesseWorksOpenResult {
  jobId: string;
  projectName: string;
  openedCount: number;
  outputNames: string[];
}

interface OpenCncAgentApi {
  snapshot(): Promise<LocalAgentSnapshot>;
  about(): Promise<AgentBuildInfo>;
  chooseParentFolder(): Promise<string | undefined>;
  chooseMachineProfile(): Promise<string | undefined>;
  updateConfiguration(configuration: Partial<AgentConfiguration>): Promise<AgentConfiguration>;
  setAutomationEnabled(enabled: boolean): Promise<void>;
  runNow(): Promise<LocalAgentSnapshot>;
  openBppInBiesseWorks(jobId: string): Promise<BiesseWorksOpenResult>;
  openMonitoredFolder(): Promise<void>;
  openDataFolder(): Promise<void>;
  openOpenCnc(): Promise<void>;
  onState(callback: (state: LocalAgentState) => void): () => void;
  onNavigate(callback: (view: "status" | "jobs" | "errors" | "settings") => void): () => void;
}

declare global { interface Window { opencncAgent: OpenCncAgentApi } }

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

const dateTime = (value: string | undefined): string => value ? new Date(value).toLocaleString() : "—";
const compactChecksum = (value: string): string => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "—";

const showError = (error: unknown): void => {
  errorBanner.textContent = error instanceof Error ? error.message : String(error);
  errorBanner.hidden = false;
};

const clearError = (): void => { errorBanner.hidden = true; errorBanner.textContent = ""; };

const renderState = (state: LocalAgentState): void => {
  snapshot.state = state;
  statusDot.dataset.mode = state.mode;
  statusMode.textContent = state.mode.replaceAll("_", " ");
  statusMessage.textContent = state.message;
  statusProjects.textContent = String(state.projectCount);
  statusNext.textContent = state.nextScanAt ? dateTime(state.nextScanAt) : "—";
  const enabled = snapshot.configuration.automationEnabled;
  byId<HTMLButtonElement>("toggle-automation").textContent = enabled ? "Pause automation" : "Resume automation";
};

const renderConfiguration = (configuration: AgentConfiguration): void => {
  snapshot.configuration = configuration;
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
};

const checksumSummary = (job: AgentJobHistoryRecord): string => {
  const input = Object.values(job.inputChecksums)[0];
  const output = Object.values(job.outputChecksums)[0];
  return `${input ? compactChecksum(input) : "—"} → ${output ? compactChecksum(output) : "—"}`;
};

const latestOpenableJob = (jobs: AgentJobHistoryRecord[]): AgentJobHistoryRecord | undefined => jobs
  .filter(job => job.status === "completed" && job.verified === true && job.reverseVerified === true && Boolean(job.outputDirectory) && job.outputNames.length > 0)
  .sort((left, right) => (right.completedAt ?? right.detectedAt).localeCompare(left.completedAt ?? left.detectedAt))[0];

const renderBiesseWorksAction = (jobs: AgentJobHistoryRecord[]): void => {
  const button = byId<HTMLButtonElement>("open-latest-bpp");
  const job = latestOpenableJob(jobs);
  button.disabled = !job;
  button.textContent = job ? `Open in BiesseWorks: ${job.projectName} (${job.outputNames.length} BPP)` : "No verified BPP files yet";
  button.title = job ? `Open the verified outputs from ${job.projectName}` : "Run a new verified CIX to BPP conversion first";
};

const renderJobs = (jobs: AgentJobHistoryRecord[]): void => {
  const filtered = currentView === "errors" ? jobs.filter(job => ["blocked", "conflicted", "failed", "retrying"].includes(job.status)) : jobs;
  jobsBody.replaceChildren();
  emptyJobs.hidden = filtered.length > 0;
  for (const job of filtered) {
    const row = document.createElement("tr");
    for (const value of [job.projectName, job.status, job.sourceNames.join(", "), job.outputNames.join(", ") || "—", checksumSummary(job), dateTime(job.completedAt ?? job.startedAt ?? job.detectedAt), job.message ?? "—"]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    row.dataset.status = job.status;
    jobsBody.append(row);
  }
  renderBiesseWorksAction(jobs);
};

const navigate = (view: typeof currentView): void => {
  currentView = view;
  for (const section of document.querySelectorAll<HTMLElement>("[data-view]")) section.hidden = section.dataset.view !== view && !(view === "errors" && section.dataset.view === "jobs");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-nav]")) button.classList.toggle("active", button.dataset.nav === view);
  renderJobs(snapshot.recentJobs);
};

const refresh = async (): Promise<void> => {
  snapshot = await window.opencncAgent.snapshot();
  renderConfiguration(snapshot.configuration);
  renderState(snapshot.state);
  renderJobs(snapshot.recentJobs);
};

const renderBuildInfo = (value: AgentBuildInfo): void => {
  byId("build-version").textContent = `Version ${value.version}`;
  byId("build-commit").textContent = `Commit ${value.shortCommit}${value.dirty ? " (dirty)" : ""}`;
  byId("build-commit").title = `${value.commit} · ${value.ref}`;
};

document.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.nav as typeof currentView)));
byId("choose-folder").addEventListener("click", async () => { const value = await window.opencncAgent.chooseParentFolder(); if (value) byId<HTMLInputElement>("parent-folder").value = value; await refresh(); });
byId("choose-profile").addEventListener("click", async () => { const value = await window.opencncAgent.chooseMachineProfile(); if (value) byId<HTMLInputElement>("machine-profile").value = value; });
byId("clear-profile").addEventListener("click", () => { byId<HTMLInputElement>("machine-profile").value = ""; });
byId("open-folder").addEventListener("click", () => { void window.opencncAgent.openMonitoredFolder(); });
byId("open-data").addEventListener("click", () => { void window.opencncAgent.openDataFolder(); });
byId("open-opencnc").addEventListener("click", () => { void window.opencncAgent.openOpenCnc(); });
byId("run-now").addEventListener("click", async () => { clearError(); try { snapshot = await window.opencncAgent.runNow(); renderState(snapshot.state); renderJobs(snapshot.recentJobs); } catch (error) { showError(error); } });
byId("open-latest-bpp").addEventListener("click", async () => {
  clearError();
  const job = latestOpenableJob(snapshot.recentJobs);
  if (!job) return;
  const button = byId<HTMLButtonElement>("open-latest-bpp");
  const confirmation = byId<HTMLElement>("biesseworks-confirmation");
  button.disabled = true;
  confirmation.textContent = "Opening BPP files…";
  try {
    const result = await window.opencncAgent.openBppInBiesseWorks(job.id);
    confirmation.textContent = `Opened ${result.openedCount} file${result.openedCount === 1 ? "" : "s"} from ${result.projectName}`;
  } catch (error) {
    confirmation.textContent = "";
    showError(error);
  } finally {
    renderBiesseWorksAction(snapshot.recentJobs);
  }
});
byId("toggle-automation").addEventListener("click", async () => { clearError(); try { await window.opencncAgent.setAutomationEnabled(!snapshot.configuration.automationEnabled); await refresh(); } catch (error) { showError(error); } });

form.addEventListener("submit", async event => {
  event.preventDefault();
  clearError();
  const machineProfilePath = byId<HTMLInputElement>("machine-profile").value.trim();
  try {
    const configuration = await window.opencncAgent.updateConfiguration({
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
    byId("save-confirmation").textContent = "Settings saved";
    setTimeout(() => { byId("save-confirmation").textContent = ""; }, 2_000);
  } catch (error) { showError(error); }
});

window.opencncAgent.onState(state => { if (snapshot) renderState(state); void refresh(); });
window.opencncAgent.onNavigate(view => navigate(view));

void Promise.all([refresh(), window.opencncAgent.about().then(renderBuildInfo)]).then(() => navigate(currentView)).catch(showError);
