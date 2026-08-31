import { resolve } from "node:path";
import {
  AgentAttemptController as WatchAttemptController,
  AgentAutomationCore,
  type AgentAttemptDecision,
  type AgentAttemptSnapshot,
  type AgentAttemptStatus,
  type AgentRetryPolicy
} from "../../../packages/agent-core/src/index.js";
import {
  convertNodeWorkspaceProject,
  discoverNodeWorkspaceProjects,
  runNodeWorkspaceOnce,
  type NodeWorkspaceOptions,
  type NodeWorkspaceProject,
  type NodeWorkspaceProjectResult,
  type NodeWorkspaceResult
} from "../../../packages/agent-core/src/node-workspace.js";

export interface WatchWorkspaceOptions extends NodeWorkspaceOptions {
  stabilityScans?: number;
  retryInitialSeconds?: number;
  retryMaxSeconds?: number;
}

export type WatchProject = NodeWorkspaceProject;
export type WatchProjectResult = NodeWorkspaceProjectResult;
export type WatchWorkspaceResult = NodeWorkspaceResult;
export type WatchAttemptStatus = AgentAttemptStatus;
export type WatchAttemptSnapshot = AgentAttemptSnapshot;
export type WatchAttemptDecision = AgentAttemptDecision;
export type WatchRetryPolicy = AgentRetryPolicy;

export { AgentAttemptController as WatchAttemptController, exponentialRetryDelay } from "../../../packages/agent-core/src/index.js";
export {
  convertNodeWorkspaceProject as convertWatchProject,
  discoverNodeWorkspaceProjects as discoverWatchProjects,
  runNodeWorkspaceOnce as runWorkspaceOnce
} from "../../../packages/agent-core/src/node-workspace.js";

export interface WatchCycleOptions extends WatchWorkspaceOptions {
  intervalSeconds: number;
  onEvent: (message: string, tone: "info" | "success" | "warning" | "error") => void;
}

export interface WatchCycleDependencies {
  discover: typeof discoverNodeWorkspaceProjects;
  convert: typeof convertNodeWorkspaceProject;
  now: () => number;
}

const retryPolicyFromOptions = (options: WatchWorkspaceOptions): Partial<WatchRetryPolicy> => ({
  ...(options.stabilityScans !== undefined ? { stabilityScans: options.stabilityScans } : {}),
  ...(options.retryInitialSeconds !== undefined ? { initialDelayMs: options.retryInitialSeconds * 1000 } : {}),
  ...(options.retryMaxSeconds !== undefined ? { maximumDelayMs: options.retryMaxSeconds * 1000 } : {})
});

export async function runWatchCycle(
  options: WatchCycleOptions,
  controller: WatchAttemptController,
  dependencies: Partial<WatchCycleDependencies> = {}
): Promise<void> {
  const discover = dependencies.discover ?? discoverNodeWorkspaceProjects;
  const convert = dependencies.convert ?? convertNodeWorkspaceProject;
  const now = dependencies.now?.() ?? Date.now();
  const core = new AgentAutomationCore<WatchProject, WatchProjectResult>(controller, {
    discover: () => discover(options.rootDirectory, options.projectFilter),
    projectKey: project => project.directory,
    process: project => convert(project, options),
    onEvent(event) {
      if (event.type === "waiting" || event.type === "processing") return;
      if (event.type === "retrying") {
        const delaySeconds = Math.max(1, Math.ceil(((event.nextAttemptAt ?? now) - now) / 1000));
        options.onEvent(`${event.project.name}: ${event.message}; transient failure, retry ${event.retryCount} in ${delaySeconds}s`, "error");
        return;
      }
      const result = event.result!;
      options.onEvent(`${event.project.name}: ${result.message}`, event.type === "completed" ? "success" : event.type === "conflicted" ? "warning" : "error");
    }
  });
  await core.runCycle(now);
}

export async function watchWorkspace(options: WatchCycleOptions): Promise<never> {
  const controller = new WatchAttemptController(retryPolicyFromOptions(options));
  options.onEvent(`Watching ${resolve(options.rootDirectory)} every ${options.intervalSeconds}s; waiting for exports to settle`, "info");
  for (;;) {
    try {
      await runWatchCycle(options, controller);
    } catch (error) {
      options.onEvent(error instanceof Error ? error.message : String(error), "error");
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, options.intervalSeconds * 1000));
  }
}
