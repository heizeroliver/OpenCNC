import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { AgentJobHistoryRecord } from "../../../packages/agent-core/src/index.js";

export interface BiesseWorksOpenResult {
  jobId: string;
  projectName: string;
  openedCount: number;
  outputNames: string[];
}

export interface VerifiedBppOutput {
  name: string;
  path: string;
  checksum: string;
}

export interface BiesseWorksFileDependencies {
  platform: NodeJS.Platform;
  inspect(path: string): Promise<{ isFile(): boolean }>;
  read(path: string): Promise<Uint8Array>;
}

const defaultFileDependencies = {
  inspect: (path: string) => stat(path),
  read: (path: string) => readFile(path)
};

const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const resolveVerifiedBppOutputs = (job: AgentJobHistoryRecord): VerifiedBppOutput[] => {
  if (job.status !== "completed" || job.verified !== true || job.reverseVerified !== true) {
    throw new Error("Only a completed, fully verified conversion can be opened in BiesseWorks");
  }
  if (!job.outputDirectory || !isAbsolute(job.outputDirectory)) {
    throw new Error("This conversion predates BiesseWorks launch tracking; convert the project again first");
  }
  if (!job.outputNames.length) throw new Error("The conversion did not record any BPP outputs");

  const outputDirectory = resolve(job.outputDirectory);
  const seen = new Set<string>();
  return job.outputNames.map(name => {
    const normalizedName = name.normalize("NFC").toLowerCase();
    if (!name || name !== basename(name) || name.includes("/") || name.includes("\\") || extname(name).toLowerCase() !== ".bpp") {
      throw new Error(`Unsafe BPP output name in job history: ${name || "(empty)"}`);
    }
    if (seen.has(normalizedName)) throw new Error(`Duplicate Windows-equivalent BPP output in job history: ${name}`);
    seen.add(normalizedName);
    const path = resolve(outputDirectory, name);
    if (dirname(path).toLowerCase() !== outputDirectory.toLowerCase()) throw new Error(`BPP output escaped its recorded directory: ${name}`);
    const checksum = job.outputChecksums[name];
    if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum)) throw new Error(`No valid recorded checksum exists for ${name}`);
    return { name, path, checksum: checksum.toLowerCase() };
  });
};

export const resolveVerifiedBppOutputDirectory = (job: AgentJobHistoryRecord): string => dirname(resolveVerifiedBppOutputs(job)[0]!.path);

export async function openVerifiedBppOutputs(
  job: AgentJobHistoryRecord,
  openBatch: (outputs: VerifiedBppOutput[]) => Promise<number>,
  dependencies: Partial<BiesseWorksFileDependencies> = {}
): Promise<BiesseWorksOpenResult> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") throw new Error("Opening BPP files in BiesseWorks is available only in the Windows Local Agent");
  const inspect = dependencies.inspect ?? defaultFileDependencies.inspect;
  const read = dependencies.read ?? defaultFileDependencies.read;
  const outputs = resolveVerifiedBppOutputs(job);

  for (const output of outputs) {
    let information: { isFile(): boolean };
    try { information = await inspect(output.path); }
    catch (error) { throw new Error(`${output.name} is no longer available: ${error instanceof Error ? error.message : String(error)}`); }
    if (!information.isFile()) throw new Error(`${output.name} is not a regular file`);
    if (sha256(await read(output.path)) !== output.checksum) {
      throw new Error(`${output.name} changed after its verified conversion; OpenCNC did not launch the batch`);
    }
  }

  const openedCount = await openBatch(outputs);
  if (!Number.isInteger(openedCount) || openedCount < 0 || openedCount > outputs.length) throw new Error("BiesseWorks bridge returned an invalid opened-file count");
  if (openedCount !== outputs.length) throw new Error(`BiesseWorks opened ${openedCount}/${outputs.length} verified BPP file(s)`);
  return { jobId: job.id, projectName: job.projectName, openedCount, outputNames: outputs.map(output => output.name) };
}
