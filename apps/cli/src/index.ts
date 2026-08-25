#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { extname, basename } from "node:path";
import { parseBpp } from "../../../packages/parser-bpp/src/index.js";
import { parseCix } from "../../../packages/parser-cix/src/index.js";
import { validateDocument } from "../../../packages/core/src/index.js";
import { renderSvg } from "../../../packages/svg/src/index.js";

const [command, file, ...args] = process.argv.slice(2);
if (!command || !file || !["inspect", "svg", "validate"].includes(command)) {
  console.error("Usage: opencnc <inspect|validate|svg> <file.bpp|file.cix> [--out preview.svg]");
  process.exit(1);
}
const input = await readFile(file, "utf8");
const extension = extname(file).toLowerCase();
if (extension !== ".bpp" && extension !== ".cix") throw new Error("Only .bpp and .cix inputs are accepted");
const document = extension === ".bpp" ? parseBpp(input, basename(file)) : parseCix(input, basename(file));
document.diagnostics.push(...validateDocument(document));

if (command === "inspect") console.log(JSON.stringify(document, null, 2));
if (command === "validate") {
  console.log(JSON.stringify(document.diagnostics, null, 2));
  if (document.diagnostics.some(d => d.severity === "error")) process.exitCode = 2;
}
if (command === "svg") {
  const outIndex = args.indexOf("--out");
  const output = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (!output) throw new Error("svg requires --out <preview.svg>");
  await writeFile(output, renderSvg(document), "utf8");
  console.log(`Wrote ${output}`);
}

