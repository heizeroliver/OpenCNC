import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const git = (...arguments_) => {
  try {
    return execFileSync("git", arguments_, { cwd: repositoryRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};
const commit = git("rev-parse", "HEAD");
const branch = process.env.GITHUB_REF_NAME || git("branch", "--show-current") || "detached";
const dirty = git("status", "--porcelain") !== "";
const output = join(repositoryRoot, "dist", "build-info.json");
const buildInfo = {
  schemaVersion: 1,
  version: packageJson.version,
  commit,
  shortCommit: commit === "unknown" ? commit : commit.slice(0, 12),
  ref: branch,
  commitTime: git("show", "-s", "--format=%cI", "HEAD"),
  dirty
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
