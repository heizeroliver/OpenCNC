import { describe, expect, it } from "vitest";
import { AgentAttemptController, AgentAutomationCore, exponentialRetryDelay, normalizeAgentConfiguration, validateAgentConfiguration, type AgentCoreProcessResult } from "./index.js";

describe("agent automation core", () => {
  it("defaults new installs to project-named BPP folders and migrates the RC2 default", () => {
    expect(normalizeAgentConfiguration(undefined).outputFolder).toBe("{projectName}_bpp");
    expect(normalizeAgentConfiguration({ outputFolder: "BPP" }).outputFolder).toBe("{projectName}_bpp");
    expect(normalizeAgentConfiguration({ language: "en", outputFolder: "BPP" }).outputFolder).toBe("BPP");
    expect(validateAgentConfiguration(normalizeAgentConfiguration({ language: "hu", outputFolder: "{projectName}_bpp" }))).toEqual([]);
    expect(validateAgentConfiguration(normalizeAgentConfiguration({ language: "hu", outputFolder: "{unknown}_bpp" }))[0]).toContain("optional {projectName}");
  });

  it("retries unchanged transient failures, persists state, and stops after recovery", async () => {
    const project = { name: "Project A", fingerprint: "same", directory: "C:\\Project A" };
    let attempts = 0;
    const events: string[] = [];
    const persisted: Array<Record<string, unknown>> = [];
    const controller = new AgentAttemptController({ stabilityScans: 1, initialDelayMs: 100, maximumDelayMs: 250 });
    const core = new AgentAutomationCore<typeof project, AgentCoreProcessResult>(controller, {
      discover: async () => [project],
      projectKey: value => value.directory,
      process: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporarily locked");
        return { status: "unchanged", message: "current" };
      },
      onEvent: event => { events.push(event.type); },
      persistAttempts: async attemptsState => { persisted.push(attemptsState); }
    });
    await core.runCycle(0);
    await core.runCycle(99);
    await core.runCycle(100);
    await core.runCycle(299);
    await core.runCycle(300);
    await core.runCycle(1_000);
    expect(attempts).toBe(3);
    expect(events.filter(event => event === "retrying")).toHaveLength(2);
    expect(controller.snapshot(project.directory)).toMatchObject({ status: "completed", retryCount: 0 });
    expect(persisted.at(-1)?.[project.directory]).toMatchObject({ status: "completed", retryCount: 0 });
  });

  it("hydrates retry state across process reinitialization", () => {
    const first = new AgentAttemptController({ stabilityScans: 1, initialDelayMs: 100, maximumDelayMs: 500 });
    first.observe("project", "fingerprint", 0);
    first.recordTransientFailure("project", new Error("locked"), 0);
    const restored = new AgentAttemptController({ stabilityScans: 1, initialDelayMs: 100, maximumDelayMs: 500 }, first.exportState());
    expect(restored.observe("project", "fingerprint", 99).attempt).toBe(false);
    expect(restored.observe("project", "fingerprint", 100)).toMatchObject({ attempt: true, retryCount: 1 });
  });

  it("emits one terminal event for a conflicted project", async () => {
    const project = { name: "Project A", fingerprint: "same", directory: "C:\\Project A" };
    const events: string[] = [];
    const core = new AgentAutomationCore<typeof project, AgentCoreProcessResult>(
      new AgentAttemptController({ stabilityScans: 1 }),
      {
        discover: async () => [project],
        projectKey: value => value.directory,
        process: async () => ({ status: "conflict", message: "existing output was edited" }),
        onEvent: event => { events.push(event.type); }
      }
    );

    await core.runCycle(0);

    expect(events).toEqual(["processing", "conflicted"]);
  });

  it("caps exponential backoff", () => {
    expect([1, 2, 3, 4].map(retry => exponentialRetryDelay(retry, 100, 250))).toEqual([100, 200, 250, 250]);
  });
});
