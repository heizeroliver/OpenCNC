import { appendFile, rename, stat, unlink } from "node:fs/promises";

export class AgentFileLogger {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, private readonly maximumBytes = 5 * 1024 * 1024) {}

  write(level: "info" | "warning" | "error", message: string, details?: unknown): Promise<void> {
    const operation = this.pending.then(async () => {
      await this.rotateIfNeeded();
      const suffix = details === undefined ? "" : ` ${this.safeJson(details)}`;
      await appendFile(this.path, `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`, "utf8");
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  flush(): Promise<void> {
    return this.pending;
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const file = await stat(this.path);
      if (file.size < this.maximumBytes) return;
      const previous = `${this.path}.previous`;
      try { await rename(this.path, previous); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        try { await unlink(previous); }
        catch (unlinkError) { if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError; }
        await rename(this.path, previous);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private safeJson(value: unknown): string {
    try { return JSON.stringify(value); }
    catch { return JSON.stringify({ detail: String(value) }); }
  }
}
