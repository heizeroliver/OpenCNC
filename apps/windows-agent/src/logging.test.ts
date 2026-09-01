import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentFileLogger } from "./logging.js";

describe("agent file logger", () => {
  it("serializes writes and retains one rotated log", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc logger "));
    try {
      const path = join(root, "agent.log");
      const logger = new AgentFileLogger(path, 20);
      await logger.write("info", "first entry is deliberately long");
      await logger.write("warning", "second entry");
      await logger.flush();
      expect(await readFile(`${path}.previous`, "utf8")).toContain("first entry");
      expect(await readFile(path, "utf8")).toContain("second entry");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a filesystem logging failure and keeps the queue usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencnc logger failure "));
    try {
      const logger = new AgentFileLogger(root);
      await expect(logger.write("error", "cannot append to a directory")).rejects.toBeInstanceOf(Error);
      await expect(logger.write("error", "the next write also reports its failure")).rejects.toBeInstanceOf(Error);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
