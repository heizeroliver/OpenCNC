import { extractFile, listPackage } from "@electron/asar";

const [archivePath, expectedCommit] = process.argv.slice(2);
if (!archivePath || !expectedCommit) throw new Error("Usage: node scripts/verify-packaged-asar.mjs <app.asar> <expected-commit>");

const files = new Set(listPackage(archivePath, { isPack: false }).map(path => path.replaceAll("\\", "/")));
const required = [
  "/apps/viewer/dist/index.html",
  "/apps/windows-agent/preload.cjs",
  "/apps/windows-agent/ui/index.html",
  "/dist/apps/windows-agent/src/main.js",
  "/dist/build-info.json"
];
for (const path of required) if (!files.has(path)) throw new Error(`Packaged ASAR is missing ${path}`);
if (![...files].some(path => path.startsWith("/apps/viewer/dist/assets/") && path.endsWith(".js"))) throw new Error("Packaged ASAR is missing the viewer JavaScript assets");
if (![...files].some(path => path.startsWith("/apps/viewer/dist/assets/") && path.endsWith(".css"))) throw new Error("Packaged ASAR is missing the viewer stylesheet");

const viewerHtml = extractFile(archivePath, "apps/viewer/dist/index.html").toString("utf8");
if (!viewerHtml.includes('src="./assets/') || !viewerHtml.includes('href="./assets/')) {
  throw new Error("Packaged viewer assets are not relative to index.html and will fail when loaded through file://");
}

const buildInfo = JSON.parse(extractFile(archivePath, "dist/build-info.json").toString("utf8"));
if (buildInfo.commit !== expectedCommit) throw new Error(`Packaged ASAR commit ${String(buildInfo.commit)} does not match ${expectedCommit}`);
if (buildInfo.dirty !== false) throw new Error("Packaged ASAR reports a dirty source checkout");
