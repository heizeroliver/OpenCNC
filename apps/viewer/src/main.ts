import "./styles.css";
import { validateDocument, type OpenCncDocument } from "../../../packages/core/src/index.js";
import { parseBpp } from "../../../packages/parser-bpp/src/index.js";
import { parseCix } from "../../../packages/parser-cix/src/index.js";
import { bulkConvertAndVerify, type BulkConversionItem, type BulkConversionReport, type BulkConversionResult, type FidelityStatus } from "../../../packages/converter/src/index.js";
import { compareCorpusReports, publicCorpusReport, runCorpusLab, type CorpusLabReport, type CorpusReportComparison } from "../../../packages/corpus/src/index.js";
import { renderSvg } from "../../../packages/svg/src/index.js";
import { checkDocumentAgainstMachine, detectDialect, validateMachineProfile, type MachineProfile } from "../../../packages/profiles/src/index.js";
import { DEMO_CIX, DEMO_NAME } from "./demo.js";
import {
  compareDocuments,
  filterPreviewOperations,
  groupDrills,
  groupRoutes,
  jobStem,
  previewLayer,
  summarizeDocument,
  type OperationReference,
  type PreviewFilters,
  type PreviewLayer
} from "./workshop.js";
import { createZip, zipFilename, type ZipEntry } from "./zip.js";
import { conflictingKeys, outputNameFromTemplate, sanitizeOutputName, type OutputNameTemplate } from "./preflight.js";
import { compareProjectFiles, createIndexedDbProjectStore, createProjectSession, type ProjectSession, type SessionComparisonSnapshot, type SessionSummary, type SimulationStatus } from "./history.js";
import {
  chooseWorkspaceFolder,
  convertWorkspaceProject,
  folderWorkspaceSupported,
  loadSavedWorkspace,
  loadWorkspaceProject,
  saveWorkspace,
  scanWorkspace,
  workspacePermission,
  type WorkspaceConversionResult,
  type WorkspaceProject
} from "./folder-workspace.js";

type Language = "hu" | "en";

interface ParsedItem {
  name: string;
  size: number;
  sourceText: string;
  document: OpenCncDocument;
}

interface PreflightRow {
  key: string;
  included: boolean;
  outputName: string;
}

interface PreflightState {
  mode: "single" | "bulk";
  result: BulkConversionResult;
  rows: PreflightRow[];
  template: OutputNameTemplate;
  includeQaPdf: boolean;
  detailKey?: string;
}

type ProjectModal = "save" | "history";

const text = {
  hu: {
    workshop: "Műhelynézet", local: "Helyben fut · nincs feltöltés", eyebrow: "BPP + CIX ELLENŐRZÉS",
    headline: "Lásd a munkadarabot mielőtt a géphez kerül.",
    lead: "Húzd ide a CNC-fájlokat. Az OpenCNC megmutatja a méreteket, furatokat, marásokat és az eltéréseket.",
    add: "Fájlok hozzáadása", drop: "Húzd ide, vagy kattints a kiválasztáshoz", types: ".bpp és .cix · egyszerre több fájl is lehet",
    demo: "Példa megnyitása", pieces: "Munkadarab", drills: "Furat", routes: "Marás", alerts: "Figyelmeztetés",
    dashboard: "Műhely áttekintés", clear: "Összes törlése", files: "Fájlok", private: "A fájlok ezen a gépen maradnak.",
    print: "Nyomtatás", json: "JSON mentése", svg: "SVG mentése", dimensions: "Méretek", thickness: "vastagság",
    visual: "Munkadarab-nézet", topDrill: "felső furat", sideDrill: "oldal/él furat", route: "marás",
    drillList: "Furatlista", quantity: "Darab", diameter: "Átmérő", depth: "Mélység", face: "Oldal", span: "Első → utolsó",
    routeList: "Marási útvonalak", length: "Teljes hossz", none: "Nincs ilyen művelet ebben a fájlban.",
    comparison: "BPP–CIX összehasonlítás", noPair: "Ehhez a munkadarabhoz nincs azonos nevű pár betöltve.",
    geometryMatch: "A geometria megegyezik", dimensionsMatch: "A méretek egyeznek, a műveletek eltérnek", dimensionsDiffer: "A panelméretek eltérnek",
    comparedWith: "Összehasonlítva", checks: "Ellenőrzések", noIssues: "Nincs hiba vagy figyelmeztetés.",
    through: "Lehetséges átmenő művelet", footer: "Csak ellenőrzéshez és dokumentáláshoz · Nem vezérel gépet",
    invalidFiles: "Néhány fájlt nem lehetett megnyitni. Csak BPP és CIX fájl használható.", batchStatus: "Feldolgozás kész",
    sourceDifference: "A BPP és CIX export eltérhet akkor is, ha ugyanahhoz a munkadarabhoz tartozik. Ellenőrizd a kiemelt adatokat.",
    selected: "kiválasztva", addMore: "További fájlok", source: "Forrás", line: "sor", lines: "sorok", operations: "művelet",
    visible: "látható", layers: "Előnézeti rétegek", traceHint: "Kattints egy forrásra vagy műveletre a kiemeléshez.",
    saveBpp: "BPP konvertálás", saveCix: "CIX konvertálás", conversionFailed: "A fájl nem konvertálható veszteség nélkül",
    conversionReady: "Az ellenőrzött konverziós vázlat letöltve. Használat előtt ellenőrizd és szimuláld a gyártói szoftverben.",
    waitPreserved: "A WAIT rekord nem végrehajtott metaadatként maradt meg; a CIX-ben nem fut le.",
    bulkConvert: "Összes konvertálása (.zip)", zipName: "ZIP fájlnév", bulkReady: "A tömeges konverzió elkészült", bulkFailed: "fájl nem volt biztonságosan konvertálható",
    bulkVerified: "kétirányú szemantikai és geometriai ellenőrzés sikeres", normalized: "A forrásszöveg normalizált, nem bájtpontos másolat.",
    preflightTitle: "Tömeges konverzió előellenőrzése", diffTitle: "Konverziós eltérésközpont", preflightLead: "Válaszd ki a letöltendő fájlokat, ellenőrizd a neveket és nézd át a kétirányú hűségjelentést.",
    ready: "Kész", failed: "Sikertelen", selectedFiles: "Kiválasztva", warnings: "Figyelmeztetés", naming: "Kimeneti elnevezés", oppositeName: "Eredeti név", convertedName: "-converted utótag", directionName: "Irány azonosító",
    include: "Letöltés", outputFile: "Kimeneti fájl", direction: "Irány", verification: "Ellenőrzés", details: "Részletek", close: "Bezárás", downloadSelected: "Kiválasztottak letöltése", downloadFile: "Ellenőrzött fájl letöltése",
    conflict: "Névütközés", resolveConflicts: "Oldd fel a kimeneti fájlnevek ütközését.", chooseFile: "Válassz legalább egy sikeresen konvertált fájlt.", reversePassed: "Oda-vissza ellenőrizve", reverseFailed: "Az oda-vissza ellenőrzés sikertelen",
    sourceCol: "Forrás", targetCol: "Cél", reverseCol: "Visszakonvertált", fieldCol: "Mező", statusCol: "Állapot", exact: "Pontos", equivalent: "Egyenértékű", normalizedStatus: "Normalizált", metadata: "Metaadat", unsupported: "Nem támogatott", machineDependent: "Gépfüggő", changed: "Eltérés",
    matches: "egyező", equivalents: "egyenértékű", differences: "eltérő", missing: "hiányzó", tolerance: "Tűrés",
    profile: "Dialektusprofil", confidence: "Bizonyosság", advanced: "haladó művelet", advancedList: "Haladó műveletek", stage: "Támogatási szint", previewOnly: "Előnézet és ellenőrzés; konverzió tiltva",
    machineProfile: "Gépprofil", configureMachine: "Gépprofil beállítása", noMachine: "Nincs aktív gépprofil", advisory: "Tájékoztató ellenőrzés — nem helyettesíti a gyártói szimulációt.",
    saveProfile: "Profil mentése helyben", disableProfile: "Profil kikapcsolása", profileName: "Profil neve", travel: "Tengelyutak", supportedFaces: "Támogatott oldalak", maxDepths: "Max. mélységek", toolDiameters: "Szerszámátmérők", machineWarnings: "Gépfigyelmeztetés",
    qaPackage: "Gyártási QA csomag", includeQa: "PDF munkalapok és ellenőrzőösszegek", qaDownload: "QA csomag letöltése",
    projectHistory: "Helyi projektek", saveProject: "Projekt mentése", sessionName: "Projekt neve", operatorNotes: "Kezelői jegyzetek", simulationStatus: "Szimuláció állapota", notReviewed: "Nincs ellenőrizve", pending: "Függőben", approved: "Jóváhagyva", rejected: "Elutasítva", openProject: "Megnyitás", saveSession: "Mentés helyben", historyEmpty: "Még nincs mentett projekt ezen a gépen.", previousComparison: "Előző–jelenlegi összehasonlítás", sessionSaved: "A projekt helyben elmentve.", sessionLoaded: "A helyi projekt betöltve.", localOnly: "IndexedDB-ben, ezen a böngészőn — felhő nélkül.",
    corpusLab: "Regression Corpus Lab", corpusLead: "Anonimizálás, parser/renderer/konverter ellenőrzés, robusztussági mutációk és verzió-összehasonlítás.", runCorpus: "Lab futtatása", exportCorpus: "Anonimizált korpusz ZIP", corpusRunning: "A teljes helyi korpusz ellenőrzése…", privacyRedactions: "Adatvédelmi törlés", robustChecks: "Robusztussági teszt", reducedFixtures: "Csökkentett hibafixture", regressions: "Regresszió", noPreviousCorpus: "Nincs korábbi helyi futás az összehasonlításhoz.",
    folderWorkspace: "Mappa automatizálás", folderLead: "Válassz egy szülőmappát. Az OpenCNC felsorolja a projektmappákat, figyeli a CIX exportokat, és ellenőrzött BPP fájlokat ír a projekt BPP almappájába.", chooseParent: "Szülőmappa kiválasztása", reconnectFolder: "Mappahozzáférés újraengedélyezése", folderUnsupported: "A közvetlen mappaíráshoz Chrome vagy Edge szükséges. Mappát továbbra is beolvashatsz, majd ZIP-et tölthetsz le.", importFolder: "Mappa importálása", refreshFolders: "Frissítés", projectFolder: "Projektmappa", cixFiles: "CIX fájlok", bppOutput: "BPP kimenet", upToDate: "Naprakész", pendingConversion: "Konvertálásra vár", loadProjectFiles: "CIX fájlok megnyitása", convertToFolder: "Konvertálás a BPP mappába", autoConvert: "Automatikus konvertálás 10 másodpercenként", autoHint: "Az automatikus mód két változatlan ellenőrzést vár, így nem olvas félkész exportot. A böngészőlapnak nyitva kell maradnia.", includeFolderQa: "QA PDF-ek írása a BPP/QA mappába", folderActivity: "Tevékenység", folderIdle: "Nincs mappatevékenység.", permissionGranted: "Írási hozzáférés aktív", permissionNeeded: "Újracsatlakozás szükséges", scanning: "Mappák ellenőrzése…", lastScan: "Utolsó ellenőrzés", noProjects: "Nem található CIX-et tartalmazó projektmappa.", safeOverwrite: "A kézzel módosított vagy ismeretlen BPP fájlokat az OpenCNC nem írja felül.", conversionBlockedFolder: "A mappakonverzió biztonsági ellenőrzés miatt leállt."
  },
  en: {
    workshop: "Workshop view", local: "Runs locally · no uploads", eyebrow: "BPP + CIX CHECK",
    headline: "See the workpiece before it reaches the machine.",
    lead: "Drop in CNC files. OpenCNC shows dimensions, drilling, routes, and differences in a clear job sheet.",
    add: "Add files", drop: "Drop files here, or click to choose", types: ".bpp and .cix · multiple files are supported",
    demo: "Open example", pieces: "Workpieces", drills: "Drills", routes: "Routes", alerts: "Warnings",
    dashboard: "Workshop overview", clear: "Clear all", files: "Files", private: "Files stay on this computer.",
    print: "Print", json: "Save JSON", svg: "Save SVG", dimensions: "Dimensions", thickness: "thickness",
    visual: "Workpiece view", topDrill: "top drill", sideDrill: "side/edge drill", route: "route",
    drillList: "Drill list", quantity: "Qty", diameter: "Diameter", depth: "Depth", face: "Side", span: "First → last",
    routeList: "Routing paths", length: "Total length", none: "No operations of this type in this file.",
    comparison: "BPP–CIX comparison", noPair: "No matching filename pair is currently loaded.",
    geometryMatch: "Geometry matches", dimensionsMatch: "Dimensions match, operations differ", dimensionsDiffer: "Panel dimensions differ",
    comparedWith: "Compared with", checks: "Checks", noIssues: "No errors or warnings.",
    through: "Possible through operation", footer: "For inspection and documentation only · Does not control machinery",
    invalidFiles: "Some files could not be opened. Only BPP and CIX files are supported.", batchStatus: "Processing complete",
    sourceDifference: "BPP and CIX exports may differ even when they describe the same workpiece. Review the highlighted data.",
    selected: "selected", addMore: "Add more files", source: "Source", line: "line", lines: "lines", operations: "operations",
    visible: "shown", layers: "Preview layers", traceHint: "Select a source or shape to highlight it.",
    saveBpp: "Convert to BPP", saveCix: "Convert to CIX", conversionFailed: "This file cannot be converted without losing supported semantics",
    conversionReady: "Verified conversion draft downloaded. Inspect and simulate it in the vendor software before use.",
    waitPreserved: "The WAIT record was preserved as non-executing metadata; it will not run in CIX.",
    bulkConvert: "Convert all (.zip)", zipName: "ZIP filename", bulkReady: "Bulk conversion complete", bulkFailed: "file(s) could not be converted safely",
    bulkVerified: "passed two-way semantic and geometry verification", normalized: "Source text is normalized, not byte-identical.",
    preflightTitle: "Bulk conversion preflight", diffTitle: "Conversion Diff Center", preflightLead: "Choose what to download, resolve output names, and review the two-way fidelity report before creating files.",
    ready: "Ready", failed: "Failed", selectedFiles: "Selected", warnings: "Warnings", naming: "Output naming", oppositeName: "Original name", convertedName: "-converted suffix", directionName: "Direction suffix",
    include: "Include", outputFile: "Output file", direction: "Direction", verification: "Verification", details: "Details", close: "Close", downloadSelected: "Download selected", downloadFile: "Download verified file",
    conflict: "Name conflict", resolveConflicts: "Resolve conflicting output filenames.", chooseFile: "Select at least one successfully converted file.", reversePassed: "Two-way verified", reverseFailed: "Two-way verification failed",
    sourceCol: "Source", targetCol: "Target", reverseCol: "Converted back", fieldCol: "Field", statusCol: "Status", exact: "Exact", equivalent: "Equivalent", normalizedStatus: "Normalized", metadata: "Metadata", unsupported: "Unsupported", machineDependent: "Machine-dependent", changed: "Changed",
    matches: "exact", equivalents: "equivalent", differences: "changed", missing: "missing", tolerance: "Tolerance",
    profile: "Dialect profile", confidence: "Confidence", advanced: "advanced operation", advancedList: "Advanced operations", stage: "Support stage", previewOnly: "Preview and validation only; conversion disabled",
    machineProfile: "Machine profile", configureMachine: "Configure machine profile", noMachine: "No active machine profile", advisory: "Advisory checks only — not a replacement for vendor simulation.",
    saveProfile: "Save profile locally", disableProfile: "Disable profile", profileName: "Profile name", travel: "Axis travel", supportedFaces: "Supported faces", maxDepths: "Maximum depths", toolDiameters: "Tool diameters", machineWarnings: "Machine warnings",
    qaPackage: "Production QA package", includeQa: "PDF job sheets and checksums", qaDownload: "Download QA package",
    projectHistory: "Local projects", saveProject: "Save project", sessionName: "Project name", operatorNotes: "Operator notes", simulationStatus: "Simulation status", notReviewed: "Not reviewed", pending: "Pending", approved: "Approved", rejected: "Rejected", openProject: "Open", saveSession: "Save locally", historyEmpty: "No projects have been saved on this computer yet.", previousComparison: "Previous–current comparison", sessionSaved: "Project saved locally.", sessionLoaded: "Local project loaded.", localOnly: "Stored in IndexedDB in this browser — no cloud.",
    corpusLab: "Regression Corpus Lab", corpusLead: "Anonymization, parser/renderer/converter checks, robustness mutations, and version-to-version comparison.", runCorpus: "Run lab", exportCorpus: "Anonymized corpus ZIP", corpusRunning: "Testing the complete local corpus…", privacyRedactions: "Privacy redactions", robustChecks: "Robustness checks", reducedFixtures: "Reduced failure fixtures", regressions: "Regressions", noPreviousCorpus: "No previous local run is available for comparison.",
    folderWorkspace: "Folder automation", folderLead: "Choose one parent folder. OpenCNC lists its project folders, watches CIX exports, and writes verified BPP files into each project's BPP subfolder.", chooseParent: "Choose parent folder", reconnectFolder: "Reconnect folder access", folderUnsupported: "Direct folder writing requires Chrome or Edge. You can still import a folder and download the converted ZIP.", importFolder: "Import folder", refreshFolders: "Refresh", projectFolder: "Project folder", cixFiles: "CIX files", bppOutput: "BPP output", upToDate: "Up to date", pendingConversion: "Conversion pending", loadProjectFiles: "Open CIX files", convertToFolder: "Convert into BPP folder", autoConvert: "Auto-convert every 10 seconds", autoHint: "Automatic mode waits for two unchanged scans so it does not read a half-written export. The browser tab must remain open.", includeFolderQa: "Write QA PDFs into BPP/QA", folderActivity: "Activity", folderIdle: "No folder activity yet.", permissionGranted: "Write access active", permissionNeeded: "Reconnect required", scanning: "Checking folders…", lastScan: "Last checked", noProjects: "No project folder containing CIX files was found.", safeOverwrite: "OpenCNC never overwrites manually edited or unknown BPP files.", conversionBlockedFolder: "Folder conversion stopped at the safety gate."
  }
} as const;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Application root not found");

let language: Language = localStorage.getItem("opencnc-language") === "en" ? "en" : "hu";
let items: ParsedItem[] = [];
let selectedName = "";
let notice = "";
let bulkArchiveName = "opencnc-bulk-conversion";
let previewFilters: PreviewFilters = { topDrill: true, sideDrill: true, route: true, advanced: true };
let tracedOperationIds: string[] = [];
let preflight: PreflightState | undefined;
let machineEditorOpen = false;
let projectModal: ProjectModal | undefined;
let projectSessions: SessionSummary[] = [];
let projectHistoryError = "";
let activeSessionId: string | undefined;
let projectName = "";
let operatorNotes = "";
let simulationStatus: SimulationStatus = "not-reviewed";
let lastSessionComparison: SessionComparisonSnapshot | undefined;
let lastConversionReport: BulkConversionReport | undefined;
let corpusOpen = false;
let corpusRunning = false;
let corpusReport: CorpusLabReport | undefined;
let corpusComparison: CorpusReportComparison | undefined;
let corpusError = "";
let workspaceOpen = false;
let workspaceRoot: FileSystemDirectoryHandle | undefined;
let workspacePermissionState: PermissionState = "prompt";
let workspaceProjects: WorkspaceProject[] = [];
let workspaceSelectedProjectName = "";
let workspaceAutoConvert = false;
let workspaceIncludeQa = true;
let workspaceBusy = false;
let workspaceError = "";
let workspaceLastScan = "";
let workspaceLastResult: WorkspaceConversionResult | undefined;
let workspaceLastAttemptFingerprint = "";
let workspaceStableFingerprints = new Map<string, string>();
let workspaceActivity: Array<{ time: string; tone: "info" | "success" | "warning" | "error"; message: string }> = [];
const projectStore = createIndexedDbProjectStore();

const loadMachineProfile = (): MachineProfile | undefined => {
  try {
    const raw = localStorage.getItem("opencnc-machine-profile");
    if (!raw) return undefined;
    const profile = JSON.parse(raw) as MachineProfile;
    return validateMachineProfile(profile).length ? undefined : profile;
  } catch { return undefined; }
};
let machineProfile = loadMachineProfile();

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const number = (value: number | undefined): string => value === undefined ? "—" : new Intl.NumberFormat(language === "hu" ? "hu-HU" : "en-GB", { maximumFractionDigits: 2 }).format(value);
const coordinate = (point: { x: number; y: number } | undefined): string => point ? `${number(point.x)}, ${number(point.y)}` : "—";
const selectedItem = (): ParsedItem | undefined => items.find(item => item.name === selectedName) ?? items[0];

const sourceReference = (references: OperationReference[]): string => {
  const c = text[language];
  const types = [...new Set(references.map(reference => reference.sourceType))].join("/");
  const lines = references.flatMap(reference => reference.line === undefined ? [] : [reference.line]);
  if (references.length === 1) {
    const reference = references[0]!;
    return `${types} · ${reference.id}${reference.line === undefined ? "" : ` · ${c.line} ${reference.line}`}`;
  }
  return `${types} · ${references.length} ${c.operations}${lines.length ? ` · ${c.lines} ${lines.join(", ")}` : ""}`;
};

const traceAttribute = (references: OperationReference[]): string => references.map(reference => encodeURIComponent(reference.id)).join(",");
const isTraced = (references: OperationReference[]): boolean => references.some(reference => tracedOperationIds.includes(reference.id));

const parseInput = (name: string, input: string, size: number): ParsedItem => {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (extension !== "bpp" && extension !== "cix") throw new Error("Unsupported extension");
  const document = extension === "bpp" ? parseBpp(input, name) : parseCix(input, name);
  document.diagnostics.push(...validateDocument(document));
  return { name, size, sourceText: input, document };
};

const addFiles = async (files: File[]): Promise<void> => {
  const accepted = files.filter(file => /\.(bpp|cix)$/i.test(file.name));
  notice = accepted.length !== files.length ? text[language].invalidFiles : "";
  const incoming: ParsedItem[] = [];
  for (const file of accepted) {
    try {
      incoming.push(parseInput(file.name, await file.text(), file.size));
    } catch {
      notice = text[language].invalidFiles;
    }
  }
  const merged = new Map(items.map(item => [item.name.toLocaleLowerCase(), item]));
  for (const item of incoming) merged.set(item.name.toLocaleLowerCase(), item);
  items = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!selectedName && items[0]) selectedName = items[0].name;
  render();
};

const download = (contents: BlobPart, filename: string, type: string): void => {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const statusLabel = (status: FidelityStatus): string => {
  const c = text[language];
  return ({
    exact: c.exact,
    equivalent: c.equivalent,
    normalized: c.normalizedStatus,
    metadata: c.metadata,
    unsupported: c.unsupported,
    "machine-dependent": c.machineDependent,
    changed: c.changed
  })[status];
};

const displayValue = (value: unknown): string => {
  if (value === undefined) return "—";
  if (value === null) return "∅";
  if (typeof value === "string") return value || "∅";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
};

const openPreflight = (selectedItems: ParsedItem[], mode: PreflightState["mode"]): void => {
  const result = bulkConvertAndVerify(selectedItems.map(item => ({ name: item.name, document: item.document })), machineProfile ? { machineProfile } : {});
  preflight = {
    mode,
    result,
    template: "opposite",
    includeQaPdf: true,
    rows: result.outputs.map((output, index) => ({ key: String(index), included: output.status === "converted", outputName: output.outputName })),
    ...(mode === "single" ? { detailKey: "0" } : {})
  };
  render();
};

const preflightConflicts = (): Set<string> => preflight ? conflictingKeys(preflight.rows) : new Set();
const selectedPreflightRows = (): Array<{ row: PreflightRow; item: BulkConversionItem; index: number }> => {
  if (!preflight) return [];
  return preflight.rows.flatMap((row, index) => {
    const item = preflight!.result.outputs[index];
    return row.included && item?.status === "converted" && item.contents !== undefined ? [{ row, item, index }] : [];
  });
};

const preflightBlockedMessage = (): string => {
  if (preflightConflicts().size) return text[language].resolveConflicts;
  return selectedPreflightRows().length ? "" : text[language].chooseFile;
};

const refreshPreflightValidation = (): void => {
  if (!preflight) return;
  const conflicts = preflightConflicts();
  document.querySelectorAll<HTMLInputElement>("[data-output-key]").forEach(input => {
    const conflict = conflicts.has(input.dataset.outputKey ?? "");
    const tableRow = input.closest("tr");
    tableRow?.classList.toggle("conflict", conflict);
    let label = input.parentElement?.querySelector<HTMLElement>(".conflict-label");
    if (conflict && !label && input.parentElement) {
      label = document.createElement("small");
      label.className = "conflict-label";
      label.textContent = text[language].conflict;
      input.parentElement.append(label);
    }
    if (!conflict) label?.remove();
  });
  const message = preflightBlockedMessage();
  const downloadButton = document.querySelector<HTMLButtonElement>("#preflight-download");
  if (downloadButton) downloadButton.disabled = Boolean(message);
  const messageNode = document.querySelector<HTMLElement>(".modal-actions > span");
  if (messageNode) messageNode.textContent = message;
};

const fidelityPanel = (item: BulkConversionItem, outputName = item.outputName): string => {
  const c = text[language];
  const statusOrder: FidelityStatus[] = ["changed", "unsupported", "equivalent", "metadata", "normalized", "machine-dependent", "exact"];
  const counts = statusOrder.filter(status => item.diff.counts[status] > 0).map(status => `<span class="fidelity-count ${status}"><b>${item.diff.counts[status]}</b> ${statusLabel(status)}</span>`).join("");
  const rows = item.diff.entries.map(entry => `<tr class="fidelity-row ${entry.status}">
    <td><span class="fidelity-status ${entry.status}">${escapeHtml(statusLabel(entry.status))}</span></td>
    <td><strong>${escapeHtml(entry.label)}</strong>${entry.message ? `<small>${escapeHtml(entry.message)}</small>` : ""}</td>
    <td><code>${escapeHtml(displayValue(entry.sourceValue))}</code></td>
    <td><code>${escapeHtml(displayValue(entry.targetValue))}</code></td>
    <td><code>${escapeHtml(displayValue(entry.reverseValue))}</code></td>
  </tr>`).join("");
  const machineRows = item.machineChecks.filter(check => check.severity === "warning").map(check => `<li><strong>${escapeHtml(check.code)}</strong><span>${escapeHtml(check.message)}</span></li>`).join("");
  return `<section class="diff-center" aria-label="${c.diffTitle}">
    <div class="diff-head"><div><p class="eyebrow">${c.diffTitle.toUpperCase()}</p><h3>${escapeHtml(item.sourceNames.join(" + "))} → ${escapeHtml(outputName)}</h3></div><div class="fidelity-counts">${counts}</div></div>
    <div class="profile-strip"><span><b>${c.profile}:</b> ${escapeHtml(item.sourceProfile.profileId)} · ${escapeHtml(item.sourceProfile.confidence)}</span><span><b>${c.direction}:</b> ${escapeHtml(item.targetProfile.label)}</span></div>
    <div class="comparison-summary"><span>${item.diff.targetComparison?.exact ?? 0} ${c.matches}</span><span>${item.diff.targetComparison?.equivalent ?? 0} ${c.equivalents}</span><span>${item.diff.targetComparison?.changed ?? 0} ${c.differences}</span><span>${(item.diff.targetComparison?.leftOnly ?? 0) + (item.diff.targetComparison?.rightOnly ?? 0)} ${c.missing}</span><span>${c.tolerance}: ${item.diff.targetComparison?.tolerance ?? 0.001} mm</span></div>
    <div class="diff-table-scroll"><table class="diff-table"><thead><tr><th>${c.statusCol}</th><th>${c.fieldCol}</th><th>${c.sourceCol}</th><th>${c.targetCol}</th><th>${c.reverseCol}</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${item.machineProfileId ? `<div class="machine-advisory"><strong>${c.machineProfile}: ${escapeHtml(item.machineProfileId)}</strong><p>${c.advisory}</p>${machineRows ? `<ul>${machineRows}</ul>` : `<span>✓ ${c.noIssues}</span>`}</div>` : ""}
  </section>`;
};

const preflightModal = (): string => {
  if (!preflight) return "";
  const c = text[language];
  const conflicts = preflightConflicts();
  const selected = selectedPreflightRows();
  const ready = preflight.result.outputs.filter(item => item.status === "converted").length;
  const failed = preflight.result.outputs.length - ready;
  const warnings = preflight.result.outputs.reduce((total, item) => total + item.diagnostics.filter(diagnostic => diagnostic.severity === "warning").length + item.machineChecks.filter(check => check.severity === "warning").length, 0);
  const tableRows = preflight.result.outputs.map((item, index) => {
    const row = preflight!.rows[index]!;
    const conflict = conflicts.has(row.key);
    return `<tr class="preflight-row${item.status === "failed" ? " failed" : ""}${conflict ? " conflict" : ""}">
      <td><input type="checkbox" data-include-key="${row.key}" ${row.included ? "checked" : ""} ${item.status === "failed" ? "disabled" : ""} aria-label="${c.include} ${escapeHtml(item.name)}" /></td>
      <td><strong>${escapeHtml(item.sourceNames.join(" + "))}</strong><small>${item.sourceNames.length === 2 ? "2-SIDED · f0 → WAIT → f1 · " : ""}${item.sourceFormat.toUpperCase()} → ${item.targetFormat.toUpperCase()}</small></td>
      <td><input class="output-name" data-output-key="${row.key}" value="${escapeHtml(row.outputName)}" ${item.status === "failed" ? "disabled" : ""} aria-label="${c.outputFile}" />${conflict ? `<small class="conflict-label">${c.conflict}</small>` : ""}</td>
      <td><span class="preflight-status ${item.status}">${item.status === "converted" ? `✓ ${c.reversePassed}` : `! ${c.reverseFailed}`}</span></td>
      <td><span class="mini-fidelity"><b>${item.diff.counts.exact}</b> ${c.exact.toLocaleLowerCase()} · <b>${item.diff.counts.equivalent}</b> ${c.equivalent.toLocaleLowerCase()}${item.diff.counts.changed || item.diff.counts.unsupported ? ` · <em>${item.diff.counts.changed + item.diff.counts.unsupported} ${c.changed.toLocaleLowerCase()}</em>` : ""}${item.machineChecks.some(check => check.severity === "warning") ? ` · <em>${item.machineChecks.filter(check => check.severity === "warning").length} ${c.machineWarnings.toLocaleLowerCase()}</em>` : ""}</span></td>
      <td><button class="secondary compact-button" data-detail-key="${row.key}">${c.details}</button></td>
    </tr>`;
  }).join("");
  const detailIndex = preflight.detailKey === undefined ? -1 : Number(preflight.detailKey);
  const detail = detailIndex >= 0 ? preflight.result.outputs[detailIndex] : undefined;
  const blockedMessage = conflicts.size ? c.resolveConflicts : selected.length === 0 ? c.chooseFile : "";
  return `<div class="modal-backdrop"><section class="preflight-modal" role="dialog" aria-modal="true" aria-labelledby="preflight-title">
    <header class="modal-head"><div><p class="eyebrow">OPENCNC</p><h2 id="preflight-title">${preflight.mode === "single" ? c.diffTitle : c.preflightTitle}</h2><p>${c.preflightLead}</p></div><button class="modal-close" id="preflight-close" aria-label="${c.close}">×</button></header>
    <div class="preflight-stats"><span><b>${ready}</b>${c.ready}</span><span class="${failed ? "danger" : ""}"><b>${failed}</b>${c.failed}</span><span><b>${selected.length}</b>${c.selectedFiles}</span><span><b>${warnings}</b>${c.warnings}</span></div>
    <div class="preflight-controls">
      <label><span>${c.naming}</span><select id="preflight-template"><option value="opposite" ${preflight.template === "opposite" ? "selected" : ""}>${c.oppositeName}</option><option value="converted" ${preflight.template === "converted" ? "selected" : ""}>${c.convertedName}</option><option value="direction" ${preflight.template === "direction" ? "selected" : ""}>${c.directionName}</option></select></label>
      ${preflight.mode === "bulk" ? `<label><span>${c.zipName}</span><span class="archive-input modal-archive"><input id="preflight-archive-name" value="${escapeHtml(bulkArchiveName)}" maxlength="124" autocomplete="off" spellcheck="false" /><b>.zip</b></span></label>` : ""}
      <label class="qa-toggle"><span>${c.qaPackage}</span><span><input id="preflight-qa" type="checkbox" ${preflight.includeQaPdf ? "checked" : ""} /> ${c.includeQa}</span></label>
    </div>
    <div class="preflight-table-scroll"><table class="preflight-table"><thead><tr><th>${c.include}</th><th>${c.source}</th><th>${c.outputFile}</th><th>${c.verification}</th><th>${c.statusCol}</th><th></th></tr></thead><tbody>${tableRows}</tbody></table></div>
    ${detail ? fidelityPanel(detail, preflight.rows[detailIndex]?.outputName ?? detail.outputName) : ""}
    <footer class="modal-actions"><span>${escapeHtml(blockedMessage)}</span><div><button class="secondary" id="preflight-cancel">${c.close}</button><button class="primary" id="preflight-download" ${blockedMessage ? "disabled" : ""}>${preflight.includeQaPdf ? c.qaDownload : preflight.mode === "single" ? c.downloadFile : c.downloadSelected}</button></div></footer>
  </section></div>`;
};

const simulationLabel = (status: SimulationStatus): string => ({
  "not-reviewed": text[language].notReviewed,
  pending: text[language].pending,
  approved: text[language].approved,
  rejected: text[language].rejected
})[status];

const comparisonSummary = (comparison: SessionComparisonSnapshot | undefined): string => {
  if (!comparison) return "";
  const c = text[language];
  return `<div class="session-comparison"><strong>${c.previousComparison}</strong><span>${comparison.comparableFiles} ${c.files.toLocaleLowerCase()} · ${comparison.semanticMatches} ${c.matches} · ${comparison.geometryMatches} ${c.geometryMatch.toLocaleLowerCase()}</span><span>${comparison.addedFiles.length} + / ${comparison.removedFiles.length} − / ${comparison.changedFiles.length} ${c.differences}</span></div>`;
};

const projectHistoryModal = (): string => {
  if (!projectModal) return "";
  const c = text[language];
  const list = projectSessions.length ? projectSessions.map(session => `<article class="session-row">
    <div><strong>${escapeHtml(session.name)}</strong><span>${new Date(session.updatedAt).toLocaleString(language === "hu" ? "hu-HU" : "en-GB")} · ${session.fileCount} ${c.files.toLocaleLowerCase()}</span><span class="session-status ${session.simulationStatus}">${escapeHtml(simulationLabel(session.simulationStatus))}</span></div>
    ${comparisonSummary(session.previousComparison)}
    <button class="secondary compact-button" data-open-session="${escapeHtml(session.id)}">${c.openProject}</button>
  </article>`).join("") : `<p class="empty-note">${c.historyEmpty}</p>`;
  return `<div class="modal-backdrop"><section class="project-modal" role="dialog" aria-modal="true" aria-labelledby="project-title">
    <header class="modal-head"><div><p class="eyebrow">LOCAL · NO CLOUD</p><h2 id="project-title">${c.projectHistory}</h2><p>${c.localOnly}</p></div><button class="modal-close" id="project-close" aria-label="${c.close}">×</button></header>
    <div class="project-layout">
      <section class="session-list"><div class="section-heading"><h3>${c.projectHistory}</h3><span>${projectSessions.length}</span></div>${list}</section>
      <section class="session-form"><h3>${c.saveProject}</h3>
        <label><span>${c.sessionName}</span><input id="session-name" value="${escapeHtml(projectName || selectedItem()?.name.replace(/\.(bpp|cix)$/i, "") || "OpenCNC project")}" /></label>
        <label><span>${c.simulationStatus}</span><select id="session-simulation"><option value="not-reviewed" ${simulationStatus === "not-reviewed" ? "selected" : ""}>${c.notReviewed}</option><option value="pending" ${simulationStatus === "pending" ? "selected" : ""}>${c.pending}</option><option value="approved" ${simulationStatus === "approved" ? "selected" : ""}>${c.approved}</option><option value="rejected" ${simulationStatus === "rejected" ? "selected" : ""}>${c.rejected}</option></select></label>
        <label><span>${c.operatorNotes}</span><textarea id="session-notes" rows="7">${escapeHtml(operatorNotes)}</textarea></label>
        ${comparisonSummary(lastSessionComparison)}
        <p class="form-error">${escapeHtml(projectHistoryError)}</p>
        <button class="primary" id="session-save" ${items.length ? "" : "disabled"}>${c.saveSession}</button>
      </section>
    </div>
  </section></div>`;
};

const corpusLabModal = (): string => {
  if (!corpusOpen) return "";
  const c = text[language];
  const summary = corpusReport?.summary;
  const metrics = summary ? `<div class="corpus-metrics">
    <span><b>${summary.parserPassed}/${summary.files}</b>Parser</span><span><b>${summary.rendererPassed}/${summary.files}</b>Renderer</span><span><b>${summary.conversionsVerified}/${summary.files}</b>Convert</span><span><b>${summary.semanticRoundTrips}/${summary.files}</b>Round trip</span>
    <span><b>${summary.robustnessPassed}/${summary.robustnessTotal}</b>${c.robustChecks}</span><span><b>${summary.privacyRedactions}</b>${c.privacyRedactions}</span><span><b>${summary.novelSignatureCount}</b>Novel signatures</span><span><b>${summary.reducedFailureFixtures}</b>${c.reducedFixtures}</span>
  </div>` : "";
  const comparison = corpusComparison ? `<div class="corpus-comparison"><strong>${c.previousComparison}</strong><span>${corpusComparison.comparableFiles} comparable · ${corpusComparison.improvedFiles} improved · <b class="${corpusComparison.regressedFiles ? "danger-text" : ""}">${corpusComparison.regressedFiles} ${c.regressions.toLocaleLowerCase()}</b> · ${corpusComparison.addedFiles} added</span></div>` : corpusReport ? `<p class="empty-note">${c.noPreviousCorpus}</p>` : "";
  const rows = corpusReport?.files.map(file => `<tr><td><strong>${escapeHtml(file.anonymousName)}</strong></td><td>${file.parserPassed ? "✓" : "!"}</td><td>${file.rendererPassed ? "✓" : "!"}</td><td><span class="preflight-status ${file.conversionStatus === "verified" ? "converted" : "failed"}">${escapeHtml(file.conversionStatus)}</span></td><td>${file.robustness.filter(value => value.passed).length}/${file.robustness.length}</td><td>${file.privacyRedactionCount}</td><td>${file.sanitizedMachiningPreserved ? "✓" : "!"}</td></tr>`).join("") ?? "";
  return `<div class="modal-backdrop"><section class="corpus-modal" role="dialog" aria-modal="true" aria-labelledby="corpus-title">
    <header class="modal-head"><div><p class="eyebrow">ENGINEERING SAFETY NET</p><h2 id="corpus-title">${c.corpusLab}</h2><p>${c.corpusLead}</p></div><button class="modal-close" id="corpus-close" aria-label="${c.close}">×</button></header>
    ${corpusRunning ? `<div class="corpus-running"><span></span>${c.corpusRunning}</div>` : ""}${metrics}${comparison}
    ${rows ? `<div class="preflight-table-scroll"><table class="corpus-table"><thead><tr><th>Fixture</th><th>Parser</th><th>Renderer</th><th>Convert</th><th>Fuzz</th><th>${c.privacyRedactions}</th><th>Geometry</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    ${corpusError ? `<p class="form-error corpus-error">${escapeHtml(corpusError)}</p>` : ""}
    <footer class="modal-actions"><span>${corpusReport ? escapeHtml(corpusReport.runId) : ""}</span><div><button class="secondary" id="corpus-run" ${corpusRunning || !items.length ? "disabled" : ""}>${c.runCorpus}</button><button class="primary" id="corpus-export" ${corpusReport && !corpusRunning ? "" : "disabled"}>${c.exportCorpus}</button></div></footer>
  </section></div>`;
};

const selectedWorkspaceProject = (): WorkspaceProject | undefined => workspaceProjects.find(project => project.name === workspaceSelectedProjectName) ?? workspaceProjects[0];

const folderWorkspaceModal = (): string => {
  if (!workspaceOpen) return "";
  const c = text[language];
  const supported = folderWorkspaceSupported();
  const selected = selectedWorkspaceProject();
  const projectRows = workspaceProjects.map(project => `<button class="workspace-project-row${project.name === selected?.name ? " active" : ""}" data-workspace-project="${escapeHtml(project.name)}">
    <span class="folder-icon">▰</span><span><strong>${escapeHtml(project.name)}</strong><small>${project.cixFiles.length} ${c.cixFiles.toLocaleLowerCase()} · ${project.bppFiles.length} BPP</small></span><span class="workspace-state ${project.needsConversion ? "pending" : "current"}">${project.needsConversion ? c.pendingConversion : c.upToDate}</span>
  </button>`).join("");
  const sourceRows = selected?.cixFiles.map(file => `<li><span><strong>${escapeHtml(file.name)}</strong><small>${new Intl.NumberFormat(language === "hu" ? "hu-HU" : "en-GB").format(file.size)} bytes</small></span><time>${new Date(file.lastModified).toLocaleString(language === "hu" ? "hu-HU" : "en-GB")}</time></li>`).join("") ?? "";
  const activity = workspaceActivity.length ? workspaceActivity.slice(0, 8).map(entry => `<li class="${entry.tone}"><time>${new Date(entry.time).toLocaleTimeString(language === "hu" ? "hu-HU" : "en-GB")}</time><span>${escapeHtml(entry.message)}</span></li>`).join("") : `<li class="empty">${c.folderIdle}</li>`;
  const permissionReady = workspaceRoot && workspacePermissionState === "granted";
  const rootControls = !supported ? `<div class="workspace-unsupported"><p>${c.folderUnsupported}</p><label class="primary folder-fallback">${c.importFolder}<input id="folder-fallback-input" type="file" accept=".cix" multiple webkitdirectory /></label></div>`
    : !workspaceRoot ? `<div class="workspace-connect"><span class="folder-large">▰</span><h3>${c.chooseParent}</h3><p>${c.folderLead}</p><button class="primary" id="workspace-choose">${c.chooseParent}</button></div>`
    : workspacePermissionState !== "granted" ? `<div class="workspace-connect"><span class="folder-large warning">!</span><h3>${c.permissionNeeded}</h3><p>${escapeHtml(workspaceRoot.name)} · ${c.safeOverwrite}</p><button class="primary" id="workspace-reconnect">${c.reconnectFolder}</button></div>` : "";
  return `<div class="modal-backdrop"><section class="workspace-modal" role="dialog" aria-modal="true" aria-labelledby="workspace-title">
    <header class="modal-head"><div><p class="eyebrow">LOCAL FOLDER PIPELINE</p><h2 id="workspace-title">${c.folderWorkspace}</h2><p>${c.folderLead}</p></div><button class="modal-close" id="workspace-close" aria-label="${c.close}">×</button></header>
    ${rootControls}
    ${permissionReady ? `<div class="workspace-toolbar"><div><strong>▰ ${escapeHtml(workspaceRoot!.name)}</strong><span class="workspace-permission">● ${c.permissionGranted}</span></div><div><span>${workspaceBusy ? c.scanning : workspaceLastScan ? `${c.lastScan}: ${new Date(workspaceLastScan).toLocaleTimeString(language === "hu" ? "hu-HU" : "en-GB")}` : ""}</span><button class="secondary compact-button" id="workspace-refresh" ${workspaceBusy ? "disabled" : ""}>${c.refreshFolders}</button><button class="secondary compact-button" id="workspace-change">${c.chooseParent}</button></div></div>
      <div class="workspace-grid"><aside class="workspace-projects"><div class="section-heading"><h3>${c.projectFolder}</h3><span>${workspaceProjects.length}</span></div>${projectRows || `<p class="empty-note">${c.noProjects}</p>`}</aside>
      <section class="workspace-detail">${selected ? `<div class="workspace-detail-head"><div><p class="eyebrow">${c.projectFolder.toUpperCase()}</p><h3>${escapeHtml(selected.name)}</h3><p>${selected.cixFiles.length} CIX → ${escapeHtml(selected.name)}/BPP</p></div><span class="workspace-state ${selected.needsConversion ? "pending" : "current"}">${selected.needsConversion ? c.pendingConversion : c.upToDate}</span></div>
        <ul class="workspace-files">${sourceRows}</ul>
        <div class="workspace-options"><label><input id="workspace-auto" type="checkbox" ${workspaceAutoConvert ? "checked" : ""} /> <span><strong>${c.autoConvert}</strong><small>${c.autoHint}</small></span></label><label><input id="workspace-qa" type="checkbox" ${workspaceIncludeQa ? "checked" : ""} /> <span><strong>${c.includeFolderQa}</strong><small>${c.qaPackage}</small></span></label></div>
        <div class="workspace-actions"><button class="secondary" id="workspace-load" ${workspaceBusy ? "disabled" : ""}>${c.loadProjectFiles}</button><button class="primary" id="workspace-convert" ${workspaceBusy ? "disabled" : ""}>${c.convertToFolder}</button></div><p class="workspace-safety">${c.safeOverwrite}</p>` : `<p class="empty-note">${c.noProjects}</p>`}</section></div>
      <section class="workspace-activity"><div class="section-heading"><h3>${c.folderActivity}</h3>${workspaceLastResult ? `<span>${escapeHtml(workspaceLastResult.status)}</span>` : ""}</div><ul>${activity}</ul></section>` : ""}
    ${workspaceError ? `<p class="form-error workspace-error">${escapeHtml(workspaceError)}</p>` : ""}
  </section></div>`;
};

const machineProfileModal = (): string => {
  if (!machineEditorOpen) return "";
  const c = text[language];
  const profile = machineProfile ?? {
    schemaVersion: "0.1" as const, id: "local-machine", name: "Local CNC",
    travel: { minX: 0, maxX: 3000, minY: 0, maxY: 1500, minZ: -100, maxZ: 100 }, supportedFaces: [0]
  };
  const tools = (kind: "drill" | "router" | "saw"): string => profile.availableTools?.filter(tool => tool.kind === kind).map(tool => tool.diameter).join(", ") ?? "";
  const field = (id: string, value: unknown, label: string): string => `<label><span>${label}</span><input id="${id}" value="${escapeHtml(String(value ?? ""))}" inputmode="decimal" /></label>`;
  return `<div class="modal-backdrop"><section class="machine-modal" role="dialog" aria-modal="true" aria-labelledby="machine-title">
    <header class="modal-head"><div><p class="eyebrow">OPENCNC</p><h2 id="machine-title">${c.machineProfile}</h2><p>${c.advisory}</p></div><button class="modal-close" id="machine-close" aria-label="${c.close}">×</button></header>
    <div class="machine-form">
      <label class="wide"><span>${c.profileName}</span><input id="machine-name" value="${escapeHtml(profile.name)}" /></label>
      <fieldset><legend>${c.travel} (mm)</legend>${field("machine-min-x", profile.travel.minX, "X min")}${field("machine-max-x", profile.travel.maxX, "X max")}${field("machine-min-y", profile.travel.minY, "Y min")}${field("machine-max-y", profile.travel.maxY, "Y max")}${field("machine-min-z", profile.travel.minZ, "Z min")}${field("machine-max-z", profile.travel.maxZ, "Z max")}</fieldset>
      <label><span>${c.supportedFaces}</span><input id="machine-faces" value="${escapeHtml(profile.supportedFaces.join(", "))}" placeholder="0, 1, 2" /></label>
      <fieldset><legend>${c.maxDepths} (mm)</legend>${field("machine-drill-depth", profile.maxDrillDepth, c.drills)}${field("machine-route-depth", profile.maxRouteDepth, c.routes)}${field("machine-saw-depth", profile.maxSawDepth, "Saw")}</fieldset>
      <fieldset><legend>${c.toolDiameters} (mm)</legend>${field("machine-drill-tools", tools("drill"), c.drills)}${field("machine-router-tools", tools("router"), c.routes)}${field("machine-saw-tools", tools("saw"), "Saw")}</fieldset>
      <p class="form-error" id="machine-error"></p>
    </div>
    <footer class="modal-actions"><span>${machineProfile ? machineProfile.name : c.noMachine}</span><div>${machineProfile ? `<button class="secondary" id="machine-disable">${c.disableProfile}</button>` : ""}<button class="secondary" id="machine-cancel">${c.close}</button><button class="primary" id="machine-save">${c.saveProfile}</button></div></footer>
  </section></div>`;
};

const header = (): string => {
  const c = text[language];
  return `<header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span><strong>OpenCNC</strong><small>${c.workshop}</small></span></div>
    <div class="top-actions"><button class="machine-button${workspaceRoot && workspacePermissionState === "granted" ? " active" : ""}" id="workspace-open">${c.folderWorkspace}</button><button class="machine-button" id="project-history">${c.projectHistory}</button><button class="machine-button${machineProfile ? " active" : ""}" id="machine-config">${c.machineProfile}${machineProfile ? ` · ${escapeHtml(machineProfile.name)}` : ""}</button><div class="privacy"><span></span> ${c.local}</div><button class="language" id="language" aria-label="Change language">${language === "hu" ? "EN" : "HU"}</button></div>
  </header>`;
};

const dropzone = (compact = false): string => {
  const c = text[language];
  return `<label class="dropzone${compact ? " compact" : ""}" id="dropzone">
    <input id="file-input" type="file" accept=".bpp,.cix" multiple />
    <span class="drop-icon" aria-hidden="true">＋</span>
    <span class="drop-copy"><strong>${compact ? c.addMore : c.add}</strong><span>${c.drop}</span>${compact ? "" : `<small>${c.types}</small>`}</span>
  </label>`;
};

const emptyView = (): string => {
  const c = text[language];
  return `${header()}<main class="shell empty-shell">
    <section class="hero"><p class="eyebrow">${c.eyebrow}</p><h1>${c.headline}</h1><p class="lead">${c.lead}</p></section>
    ${dropzone()}
    <button class="demo-button" id="demo">${c.demo} <span>→</span></button>
    <section class="workbench" aria-label="${c.visual}">
      <div class="metric"><small>${c.pieces.toUpperCase()}</small><strong>—</strong><span>${c.batchStatus}</span></div>
      <div class="metric"><small>${c.drills.toUpperCase()}</small><strong>—</strong><span>${c.selected}</span></div>
      <div class="metric"><small>${c.routes.toUpperCase()}</small><strong>—</strong><span>${c.route}</span></div>
      <div class="metric"><small>${c.checks.toUpperCase()}</small><strong class="ok">Kész</strong><span>${c.local}</span></div>
      <div class="preview-placeholder"><span class="panel-demo"><i></i><i></i><i></i><i></i></span><p>${c.visual}</p></div>
    </section>
  </main><footer>${c.footer}</footer>${machineProfileModal()}${projectHistoryModal()}${corpusLabModal()}${folderWorkspaceModal()}`;
};

const fileList = (): string => {
  const c = text[language];
  return items.map(item => {
    const summary = summarizeDocument(item.document);
    const issues = summary.errorCount + summary.warningCount;
    const active = item.name === selectedItem()?.name;
    return `<button class="file-row${active ? " active" : ""}" data-select="${escapeHtml(item.name)}">
      <span class="file-format ${item.document.source.format}">${item.document.source.format.toUpperCase()}</span>
      <span class="file-info"><strong>${escapeHtml(item.name.replace(/\.(bpp|cix)$/i, ""))}</strong><small>${number(item.document.panel.width)} × ${number(item.document.panel.height)} × ${number(item.document.panel.thickness)} mm</small></span>
      <span class="file-status${issues ? " warning" : ""}" title="${c.alerts}">${issues || "✓"}</span>
    </button>`;
  }).join("");
};

const operationTables = (document: OpenCncDocument): string => {
  const c = text[language];
  const drillRows = groupDrills(document.operations).map(group => `<tr class="${isTraced(group.references) ? "traced" : ""}"><td><strong>${group.quantity}</strong></td><td>${number(group.diameter)} mm</td><td>${number(group.depth)} mm</td><td>${group.face ?? "—"}</td><td class="coordinate">${coordinate(group.first)} → ${coordinate(group.last)}</td><td><button class="source-link" data-trace="${traceAttribute(group.references)}">${escapeHtml(sourceReference(group.references))}</button></td></tr>`).join("");
  const routeRows = groupRoutes(document.operations).map(group => `<tr class="${isTraced(group.references) ? "traced" : ""}"><td><strong>${group.quantity}</strong></td><td>${number(group.diameter)} mm</td><td>${number(group.depth)} mm</td><td>${group.face ?? "—"}</td><td>${number(group.totalLength)} mm</td><td><button class="source-link" data-trace="${traceAttribute(group.references)}">${escapeHtml(sourceReference(group.references))}</button></td></tr>`).join("");
  const advanced = document.operations.filter(operation => !["drill", "route", "unknown"].includes(operation.kind));
  const advancedRows = advanced.map(operation => `<tr><td><strong>${escapeHtml(operation.kind)}</strong></td><td>${escapeHtml(operation.sourceType)}</td><td>${escapeHtml(operation.support?.stage ?? "preserved")}</td><td>${operation.support?.conversion ? c.ready : c.previewOnly}</td><td><button class="source-link" data-trace="${encodeURIComponent(operation.id)}">${escapeHtml(operation.id)}</button></td></tr>`).join("");
  const empty = `<p class="empty-note">${c.none}</p>`;
  return `<section class="detail-card"><div class="section-heading"><h3>${c.drillList}</h3><span>${groupDrills(document.operations).reduce((sum, group) => sum + group.quantity, 0)} ${c.quantity.toLocaleLowerCase()}</span></div>
    ${drillRows ? `<div class="table-scroll"><table><thead><tr><th>${c.quantity}</th><th>${c.diameter}</th><th>${c.depth}</th><th>${c.face}</th><th>${c.span}</th><th>${c.source}</th></tr></thead><tbody>${drillRows}</tbody></table></div>` : empty}
  </section>
  <section class="detail-card"><div class="section-heading"><h3>${c.routeList}</h3><span>${groupRoutes(document.operations).reduce((sum, group) => sum + group.quantity, 0)} ${c.quantity.toLocaleLowerCase()}</span></div>
    ${routeRows ? `<div class="table-scroll"><table><thead><tr><th>${c.quantity}</th><th>${c.diameter}</th><th>${c.depth}</th><th>${c.face}</th><th>${c.length}</th><th>${c.source}</th></tr></thead><tbody>${routeRows}</tbody></table></div>` : empty}
  </section>
  ${advancedRows ? `<section class="detail-card advanced-operations"><div class="section-heading"><h3>${c.advancedList}</h3><span>${advanced.length}</span></div><div class="table-scroll"><table><thead><tr><th>${c.operations}</th><th>${c.source}</th><th>${c.stage}</th><th>${c.verification}</th><th>ID</th></tr></thead><tbody>${advancedRows}</tbody></table></div></section>` : ""}`;
};

const previewControls = (document: OpenCncDocument): string => {
  const c = text[language];
  const renderableCount = document.operations.filter(operation => previewLayer(operation) !== undefined).length;
  const visibleCount = filterPreviewOperations(document.operations, previewFilters).length;
  const button = (layer: PreviewLayer, label: string, color: string): string => `<button class="layer-toggle ${color}${previewFilters[layer] ? " active" : ""}" data-layer="${layer}" aria-pressed="${previewFilters[layer]}"><span></span>${label}</button>`;
  return `<div class="preview-title"><h3>${c.visual}</h3><small>${visibleCount}/${renderableCount} ${c.visible} · ${c.traceHint}</small></div><div class="preview-tools" role="group" aria-label="${c.layers}">${button("topDrill", c.topDrill, "red")}${button("sideDrill", c.sideDrill, "amber")}${button("route", c.route, "blue")}${button("advanced", c.advanced, "purple")}</div>`;
};

const profileCard = (document: OpenCncDocument): string => {
  const c = text[language];
  const detected = detectDialect(document);
  return `<section class="detail-card profile-card"><div class="section-heading"><h3>${c.profile}</h3><span class="profile-confidence ${detected.confidence}">${escapeHtml(detected.confidence)}</span></div><p><strong>${escapeHtml(detected.profileId)}</strong>${detected.version ? ` · v${escapeHtml(detected.version)}` : ""}</p><ul>${detected.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>${detected.warnings.map(warning => `<p class="comparison-note">${escapeHtml(warning)}</p>`).join("")}</section>`;
};

const machineCard = (document: OpenCncDocument): string => {
  const c = text[language];
  if (!machineProfile) return `<section class="detail-card machine-card"><div class="section-heading"><h3>${c.machineProfile}</h3></div><p class="empty-note">${c.noMachine}</p><button class="secondary" id="machine-config-card">${c.configureMachine}</button></section>`;
  const checks = checkDocumentAgainstMachine(document, machineProfile);
  const warnings = checks.filter(check => check.severity === "warning");
  return `<section class="detail-card machine-card"><div class="section-heading"><h3>${escapeHtml(machineProfile.name)}</h3><span class="compare-status ${warnings.length ? "error" : "match"}">${warnings.length ? `! ${warnings.length}` : `✓ ${c.noIssues}`}</span></div><p class="comparison-note">${c.advisory}</p>${warnings.length ? `<ul>${warnings.map(check => `<li class="warning"><strong>${escapeHtml(check.code)}</strong><span>${escapeHtml(check.message)}</span></li>`).join("")}</ul>` : ""}<button class="secondary" id="machine-config-card">${c.configureMachine}</button></section>`;
};

const comparisonCard = (item: ParsedItem): string => {
  const c = text[language];
  const pair = items.find(candidate => candidate.name !== item.name && jobStem(candidate.name) === jobStem(item.name) && candidate.document.source.format !== item.document.source.format);
  if (!pair) return `<section class="detail-card comparison"><div class="section-heading"><h3>${c.comparison}</h3></div><p class="empty-note">${c.noPair}</p></section>`;
  const result = compareDocuments(item.document, pair.document);
  const status = result.geometryMatch ? "match" : result.dimensionsMatch ? "different" : "error";
  const message = result.geometryMatch ? c.geometryMatch : result.dimensionsMatch ? c.dimensionsMatch : c.dimensionsDiffer;
  const missing = result.leftOnly + result.rightOnly;
  return `<section class="detail-card comparison"><div class="section-heading"><h3>${c.comparison}</h3><span class="compare-status ${status}">${status === "match" ? "✓" : "!"} ${message}</span></div><p>${c.comparedWith}: <strong>${escapeHtml(pair.name)}</strong></p><div class="comparison-summary card-summary"><span><b>${result.exact}</b> ${c.matches}</span><span><b>${result.equivalent}</b> ${c.equivalents}</span><span><b>${result.changed}</b> ${c.differences}</span><span><b>${missing}</b> ${c.missing}</span><span>${c.tolerance}: ${result.tolerance} mm</span></div>${result.geometryMatch ? "" : `<p class="comparison-note">${c.sourceDifference}</p>`}</section>`;
};

const diagnosticsCard = (document: OpenCncDocument): string => {
  const c = text[language];
  const actionable = document.diagnostics.filter(diagnostic => diagnostic.severity === "error" || diagnostic.severity === "warning");
  const through = document.diagnostics.filter(diagnostic => diagnostic.code === "DEPTH_EXCEEDS_PANEL_THICKNESS").length;
  return `<section class="detail-card checks"><div class="section-heading"><h3>${c.checks}</h3>${actionable.length ? `<span class="compare-status error">! ${actionable.length}</span>` : `<span class="compare-status match">✓ ${c.noIssues}</span>`}</div>
    ${actionable.length ? `<ul>${actionable.map(diagnostic => `<li class="${diagnostic.severity}"><strong>${escapeHtml(diagnostic.code)}</strong><span>${escapeHtml(diagnostic.message)}</span></li>`).join("")}</ul>` : ""}
    ${through ? `<p class="through-note">↳ ${through} × ${c.through}</p>` : ""}
  </section>`;
};

const loadedView = (): string => {
  const c = text[language];
  const active = selectedItem()!;
  const summary = summarizeDocument(active.document);
  const workpieceCount = new Set(items.map(item => jobStem(item.name))).size;
  const activeAlerts = summary.errorCount + summary.warningCount;
  const panel = active.document.panel;
  const conversionTarget = active.document.source.format === "bpp" ? "cix" : "bpp";
  return `${header()}<main class="shell loaded-shell">
    <section class="dashboard-head"><div><p class="eyebrow">${c.eyebrow}</p><h1>${c.dashboard}</h1><p>${c.private}</p></div><div class="head-actions"><label class="archive-name"><span>${c.zipName}</span><span class="archive-input"><input id="bulk-archive-name" value="${escapeHtml(bulkArchiveName)}" maxlength="124" autocomplete="off" spellcheck="false" /><b>.zip</b></span></label><button class="primary" id="bulk-convert">${c.bulkConvert}</button><button class="secondary" id="workspace-open-card">${c.folderWorkspace}</button><button class="secondary" id="corpus-open">${c.corpusLab}</button><button class="secondary" id="project-save-open">${c.saveProject}</button><button class="secondary" id="clear">${c.clear}</button></div></section>
    ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
    ${dropzone(true)}
    <section class="summary-grid">
      <div class="summary-card"><small>${c.pieces.toUpperCase()}</small><strong>${workpieceCount}</strong><span>${items.length} .bpp / .cix</span></div>
      <div class="summary-card"><small>${c.drills.toUpperCase()}</small><strong>${summary.drillCount}</strong><span>${c.selected}</span></div>
      <div class="summary-card"><small>${c.routes.toUpperCase()}</small><strong>${summary.routeCount}</strong><span>${summary.advancedCount ? `+ ${summary.advancedCount} ${c.advanced}` : c.selected}</span></div>
      <div class="summary-card"><small>${c.alerts.toUpperCase()}</small><strong class="${activeAlerts ? "warn" : "good"}">${activeAlerts}</strong><span>${c.selected}</span></div>
    </section>
    <section class="workspace">
      <aside class="file-panel"><div class="panel-title"><h2>${c.files}</h2><span>${items.length}</span></div><div class="file-list">${fileList()}</div></aside>
      <article class="job-sheet">
        <header class="job-head"><div><span class="format-pill ${active.document.source.format}">${active.document.source.format.toUpperCase()}</span><h2>${escapeHtml(active.name.replace(/\.(bpp|cix)$/i, ""))}</h2><p>${c.dimensions}: <strong>${number(panel.width)} × ${number(panel.height)} × ${number(panel.thickness)} mm</strong> · ${summary.drillCount} ${c.drills.toLocaleLowerCase()} · ${summary.routeCount} ${c.routes.toLocaleLowerCase()}${summary.advancedCount ? ` · ${summary.advancedCount} ${c.advanced}` : ""}</p></div>
          <div class="job-actions"><button class="secondary" id="convert">${conversionTarget === "bpp" ? c.saveBpp : c.saveCix}</button><button class="secondary" id="save-json">${c.json}</button><button class="secondary" id="save-svg">${c.svg}</button><button class="primary" id="print">${c.print}</button></div>
        </header>
        <section class="preview-card"><div class="section-heading preview-heading">${previewControls(active.document)}</div><div class="preview-canvas" id="preview-svg"></div></section>
        <div class="details-grid">${operationTables(active.document)}${profileCard(active.document)}${machineCard(active.document)}${comparisonCard(active)}${diagnosticsCard(active.document)}</div>
      </article>
    </section>
  </main><footer>${c.footer}</footer>${preflightModal()}${machineProfileModal()}${projectHistoryModal()}${corpusLabModal()}${folderWorkspaceModal()}`;
};

const completePreflightDownload = async (): Promise<void> => {
  if (!preflight || preflightConflicts().size) return;
  const selected = selectedPreflightRows();
  if (!selected.length) return;
  try {
    const selectedItems = selected.map(selection => selection.item);
    const reportItems = selected.map(({ row, index }) => ({ ...preflight!.result.report.items[index]!, outputName: row.outputName }));
    const qaArtifacts = preflight.includeQaPdf ? await (async () => {
      const { generateQaJobSheet } = await import("../../../packages/qa/src/index.js");
      return Promise.all(selected.map(async ({ row, item }) => {
        const sources = item.sourceNames.map(name => items.find(candidate => candidate.name === name));
        if (sources.some(source => !source)) throw new Error(`Missing source text for ${item.sourceNames.join(", ")}`);
        return generateQaJobSheet({ item, sourceDocument: item.sourceDocument, sourceText: sources.map(source => source!.sourceText).join("\r\n; OPENCNC TWO-SIDED SOURCE BOUNDARY\r\n"), outputName: row.outputName });
      }));
    })() : [];
    const report = {
      ...preflight.result.report,
      generatedAt: new Date().toISOString(),
      summary: {
        sourceFiles: selectedItems.reduce((total, item) => total + item.sourceNames.length, 0),
        total: selectedItems.length,
        twoSidedPairs: selectedItems.filter(item => item.sourceNames.length === 2).length,
        converted: selectedItems.filter(item => item.status === "converted").length,
        failed: selectedItems.filter(item => item.status === "failed").length,
        reverseVerified: selectedItems.filter(item => item.reverseVerified).length,
        supportedSemanticRoundTrips: selectedItems.filter(item => item.supportedSemanticRoundTrip).length,
        expandedGeometryRoundTrips: selectedItems.filter(item => item.expandedGeometryRoundTrip).length,
        preservedInertOperations: selectedItems.reduce((total, item) => total + item.preservedInertOperationCount, 0),
        machineWarnings: selectedItems.reduce((total, item) => total + item.machineChecks.filter(check => check.severity === "warning").length, 0)
      },
      items: reportItems,
      preflight: {
        namingTemplate: preflight.template,
        selected: selected.map(({ item, row }) => ({ sourceNames: item.sourceNames, outputName: row.outputName })),
        excluded: preflight.rows.filter(row => !row.included).map(row => preflight!.result.outputs[Number(row.key)]?.name).filter(Boolean)
      },
      qaArtifacts: qaArtifacts.map((qa, index) => ({ sourceNames: selected[index]!.item.sourceNames, outputName: selected[index]!.row.outputName, pdfName: `qa/${qa.filename}`, reportId: qa.reportId, fidelityGrade: qa.fidelityGrade, sourceChecksum: qa.sourceChecksum, targetChecksum: qa.targetChecksum }))
    };
    lastConversionReport = report;
    if (preflight.mode === "single" && !preflight.includeQaPdf) {
      const { item, row } = selected[0]!;
      download(item.contents!, row.outputName, "text/plain;charset=utf-8");
    } else {
      const entries: ZipEntry[] = selected.map(({ row, item }) => ({ name: row.outputName, contents: item.contents! }));
      entries.push(...qaArtifacts.map(qa => ({ name: `qa/${qa.filename}`, contents: qa.bytes })));
      entries.push({ name: "opencnc-conversion-report.json", contents: `${JSON.stringify(report, null, 2)}\n` });
      const filename = preflight.mode === "bulk" ? zipFilename(bulkArchiveName) : zipFilename(selected[0]!.row.outputName.replace(/\.(bpp|cix)$/i, "-qa-package"));
      download(createZip(entries), filename, "application/zip");
      if (preflight.mode === "bulk") bulkArchiveName = filename.replace(/\.zip$/i, "");
    }
    const first = selected[0]!.item;
    notice = preflight.mode === "single"
      ? first.diagnostics.some(diagnostic => diagnostic.code === "CONVERSION_WAIT_PRESERVED_AS_METADATA") ? `${text[language].conversionReady} ${text[language].waitPreserved}` : text[language].conversionReady
      : `${text[language].bulkReady}: ${selectedItems.length}/${preflight.result.report.summary.total}; ${selectedItems.filter(item => item.supportedSemanticRoundTrip).length}/${selectedItems.length} ${text[language].bulkVerified}. ${text[language].normalized}`;
    preflight = undefined;
    render();
  } catch (error) {
    notice = error instanceof Error ? error.message : String(error);
    render();
  }
};

const openProjectPanel = async (mode: ProjectModal): Promise<void> => {
  projectModal = mode;
  projectHistoryError = "";
  render();
  try { projectSessions = await projectStore.listSessions(); }
  catch (error) { projectHistoryError = error instanceof Error ? error.message : String(error); }
  render();
};

const saveCurrentProject = async (): Promise<void> => {
  const nameInput = document.querySelector<HTMLInputElement>("#session-name");
  const notesInput = document.querySelector<HTMLTextAreaElement>("#session-notes");
  const simulationInput = document.querySelector<HTMLSelectElement>("#session-simulation");
  projectName = nameInput?.value.trim() || selectedItem()?.name.replace(/\.(bpp|cix)$/i, "") || "OpenCNC project";
  operatorNotes = notesInput?.value ?? "";
  const status = simulationInput?.value;
  if (status === "not-reviewed" || status === "pending" || status === "approved" || status === "rejected") simulationStatus = status;
  try {
    const now = new Date().toISOString();
    const previous = activeSessionId ? await projectStore.loadSession(activeSessionId) : undefined;
    const previousFiles = previous?.files.map(file => parseInput(file.name, file.sourceText, file.size)) ?? [];
    lastSessionComparison = previous ? compareProjectFiles(previousFiles, items, now) : undefined;
    const input: Omit<ProjectSession, "id" | "createdAt" | "updatedAt"> = {
      name: projectName,
      archiveName: bulkArchiveName,
      operatorNotes,
      simulationStatus,
      selectedFileName: selectedItem()?.name ?? "",
      files: items.map(item => ({ name: item.name, size: item.size, sourceText: item.sourceText, sourceFormat: item.document.source.format })),
      ...(lastConversionReport ? { conversionReport: lastConversionReport } : {}),
      ...(lastSessionComparison ? { previousComparison: lastSessionComparison } : {})
    };
    const session = createProjectSession(input, { ...(activeSessionId ? { id: activeSessionId } : {}), now });
    if (previous) session.createdAt = previous.createdAt;
    await projectStore.saveSession(session);
    activeSessionId = session.id;
    projectSessions = await projectStore.listSessions();
    notice = text[language].sessionSaved;
    projectHistoryError = "";
    render();
  } catch (error) {
    projectHistoryError = error instanceof Error ? error.message : String(error);
    render();
  }
};

const loadProjectSession = async (id: string): Promise<void> => {
  try {
    const session = await projectStore.loadSession(id);
    if (!session) throw new Error(`Local project ${id} was not found`);
    items = session.files.map(file => parseInput(file.name, file.sourceText, file.size));
    selectedName = items.some(item => item.name === session.selectedFileName) ? session.selectedFileName : items[0]?.name ?? "";
    activeSessionId = session.id;
    projectName = session.name;
    operatorNotes = session.operatorNotes;
    simulationStatus = session.simulationStatus;
    bulkArchiveName = session.archiveName;
    lastConversionReport = session.conversionReport;
    lastSessionComparison = session.previousComparison;
    projectModal = undefined;
    notice = text[language].sessionLoaded;
    render();
  } catch (error) {
    projectHistoryError = error instanceof Error ? error.message : String(error);
    render();
  }
};

const executeCorpusLab = async (): Promise<void> => {
  if (!items.length || corpusRunning) return;
  corpusRunning = true;
  corpusError = "";
  render();
  try {
    const previous = await projectStore.latestCorpusReport();
    const report = await runCorpusLab(items.map(item => ({ name: item.name, sourceText: item.sourceText, document: item.document })));
    corpusComparison = previous ? compareCorpusReports(report, previous) : undefined;
    corpusReport = report;
    await projectStore.saveCorpusReport(report);
  } catch (error) {
    corpusError = error instanceof Error ? error.message : String(error);
  } finally {
    corpusRunning = false;
    render();
  }
};

const exportCorpusLab = (): void => {
  if (!corpusReport) return;
  const entries = corpusReport.files.flatMap(file => [
    { name: `sanitized/${file.anonymousName}`, contents: file.sanitizedSourceText },
    ...(file.reducedFailureFixture ? [{ name: `reduced/${file.anonymousName}.failure.json`, contents: file.reducedFailureFixture }] : [])
  ]);
  entries.push({ name: "corpus-report.json", contents: `${JSON.stringify(publicCorpusReport(corpusReport), null, 2)}\n` });
  entries.push({ name: "README.txt", contents: "OpenCNC anonymized regression corpus\n\nFilenames, comments, labels, and known customer fields were replaced locally. Every sanitized file was re-parsed and compared for panel dimensions and expanded machining geometry. Reduced fixtures are diagnostic JSON and must never be sent to a CNC controller.\n" });
  download(createZip(entries), `opencnc-regression-corpus-${corpusReport.runId.toLocaleLowerCase()}.zip`, "application/zip");
};

const recordWorkspaceActivity = (tone: "info" | "success" | "warning" | "error", message: string): void => {
  workspaceActivity.unshift({ time: new Date().toISOString(), tone, message });
  workspaceActivity = workspaceActivity.slice(0, 30);
};

const persistWorkspace = async (): Promise<void> => {
  if (!workspaceRoot) return;
  try {
    await saveWorkspace({
      rootHandle: workspaceRoot,
      ...(workspaceSelectedProjectName ? { selectedProjectName: workspaceSelectedProjectName } : {}),
      autoConvert: workspaceAutoConvert,
      includeQa: workspaceIncludeQa
    });
  } catch (error) {
    workspaceError = error instanceof Error ? error.message : String(error);
  }
};

const convertSelectedWorkspaceProject = async (automatic = false): Promise<void> => {
  const project = selectedWorkspaceProject();
  if (!project || workspaceBusy || !workspaceRoot) return;
  workspaceBusy = true;
  workspaceError = "";
  if (workspaceOpen) render();
  try {
    workspacePermissionState = await workspacePermission(workspaceRoot);
    if (workspacePermissionState !== "granted") throw new Error(text[language].permissionNeeded);
    const result = await convertWorkspaceProject(project, { ...(machineProfile ? { machineProfile } : {}), includeQa: workspaceIncludeQa });
    workspaceLastResult = result;
    if (result.report) lastConversionReport = result.report;
    const tone = result.status === "converted" || result.status === "unchanged" ? "success" : result.status === "conflict" ? "warning" : "error";
    recordWorkspaceActivity(tone, `${automatic ? "AUTO · " : ""}${project.name}: ${result.message}`);
    if (result.orphanedOutputs.length) recordWorkspaceActivity("warning", `${project.name}: ${result.orphanedOutputs.length} old BPP output(s) were preserved rather than deleted`);
    if (result.status === "blocked") workspaceError = text[language].conversionBlockedFolder;
    if (result.status === "conflict") workspaceError = result.conflicts.map(conflict => `${conflict.outputName}: ${conflict.reason}`).join(" · ");
    workspaceProjects = await scanWorkspace(workspaceRoot);
    workspaceLastScan = new Date().toISOString();
    notice = result.message;
  } catch (error) {
    workspaceError = error instanceof Error ? error.message : String(error);
    recordWorkspaceActivity("error", `${project.name}: ${workspaceError}`);
  } finally {
    workspaceBusy = false;
    await persistWorkspace();
    if (workspaceOpen) render();
  }
};

const refreshFolderWorkspace = async (allowAutomatic = true): Promise<void> => {
  if (!workspaceRoot || workspaceBusy) return;
  workspaceBusy = true;
  workspaceError = "";
  if (workspaceOpen) render();
  let automaticProject: WorkspaceProject | undefined;
  try {
    workspacePermissionState = await workspacePermission(workspaceRoot);
    if (workspacePermissionState !== "granted") {
      workspaceProjects = [];
      workspaceAutoConvert = false;
      workspaceError = text[language].permissionNeeded;
      return;
    }
    const projects = await scanWorkspace(workspaceRoot);
    workspaceProjects = projects;
    if (!projects.some(project => project.name === workspaceSelectedProjectName)) workspaceSelectedProjectName = projects[0]?.name ?? "";
    const selected = selectedWorkspaceProject();
    if (selected) {
      const previousFingerprint = workspaceStableFingerprints.get(selected.name);
      workspaceStableFingerprints.set(selected.name, selected.fingerprint);
      if (allowAutomatic && workspaceAutoConvert && selected.needsConversion && previousFingerprint === selected.fingerprint && workspaceLastAttemptFingerprint !== selected.fingerprint) {
        workspaceLastAttemptFingerprint = selected.fingerprint;
        automaticProject = selected;
      }
    }
    workspaceLastScan = new Date().toISOString();
  } catch (error) {
    workspaceError = error instanceof Error ? error.message : String(error);
    recordWorkspaceActivity("error", workspaceError);
  } finally {
    workspaceBusy = false;
    if (workspaceOpen) render();
  }
  if (automaticProject) await convertSelectedWorkspaceProject(true);
};

const connectFolderWorkspace = async (): Promise<void> => {
  workspaceError = "";
  try {
    workspaceRoot = await chooseWorkspaceFolder();
    workspacePermissionState = await workspacePermission(workspaceRoot);
    workspaceSelectedProjectName = "";
    workspaceProjects = [];
    workspaceStableFingerprints = new Map();
    workspaceLastAttemptFingerprint = "";
    recordWorkspaceActivity("info", `${workspaceRoot.name}: workspace connected`);
    await persistWorkspace();
    await refreshFolderWorkspace(false);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    workspaceError = error instanceof Error ? error.message : String(error);
    render();
  }
};

const reconnectFolderWorkspace = async (): Promise<void> => {
  if (!workspaceRoot) return;
  try {
    workspacePermissionState = await workspacePermission(workspaceRoot, true);
    if (workspacePermissionState !== "granted") throw new Error(text[language].permissionNeeded);
    recordWorkspaceActivity("success", `${workspaceRoot.name}: write access granted`);
    await refreshFolderWorkspace(false);
  } catch (error) {
    workspaceError = error instanceof Error ? error.message : String(error);
    render();
  }
};

const openSelectedWorkspaceProject = async (): Promise<void> => {
  const project = selectedWorkspaceProject();
  if (!project || workspaceBusy) return;
  workspaceBusy = true;
  render();
  try {
    const files = await loadWorkspaceProject(project);
    items = files.map(file => parseInput(file.name, file.sourceText, file.size));
    selectedName = items[0]?.name ?? "";
    bulkArchiveName = `${project.name}-bpp`;
    workspaceOpen = false;
    notice = `${project.name}: ${files.length} CIX file(s) loaded from the workspace`;
  } catch (error) {
    workspaceError = error instanceof Error ? error.message : String(error);
  } finally {
    workspaceBusy = false;
    render();
  }
};

const restoreFolderWorkspace = async (): Promise<void> => {
  if (!folderWorkspaceSupported()) return;
  try {
    const saved = await loadSavedWorkspace();
    if (!saved) return;
    workspaceRoot = saved.rootHandle;
    workspaceSelectedProjectName = saved.selectedProjectName ?? "";
    workspaceAutoConvert = saved.autoConvert;
    workspaceIncludeQa = saved.includeQa;
    workspacePermissionState = await workspacePermission(saved.rootHandle);
    if (workspacePermissionState === "granted") await refreshFolderWorkspace(false);
    else render();
  } catch (error) {
    workspaceError = error instanceof Error ? error.message : String(error);
  }
};

const bind = (): void => {
  document.documentElement.lang = language;
  document.title = `OpenCNC ${text[language].workshop}`;
  document.querySelector<HTMLButtonElement>("#language")?.addEventListener("click", () => {
    language = language === "hu" ? "en" : "hu";
    localStorage.setItem("opencnc-language", language);
    notice = "";
    render();
  });
  document.querySelector<HTMLButtonElement>("#project-history")?.addEventListener("click", () => void openProjectPanel("history"));
  const openWorkspace = (): void => { workspaceOpen = true; workspaceError = ""; render(); if (workspaceRoot && workspacePermissionState === "granted") void refreshFolderWorkspace(false); };
  document.querySelector<HTMLButtonElement>("#workspace-open")?.addEventListener("click", openWorkspace);
  document.querySelector<HTMLButtonElement>("#workspace-open-card")?.addEventListener("click", openWorkspace);
  document.querySelector<HTMLButtonElement>("#workspace-close")?.addEventListener("click", () => { workspaceOpen = false; render(); });
  document.querySelector<HTMLButtonElement>("#workspace-choose")?.addEventListener("click", () => void connectFolderWorkspace());
  document.querySelector<HTMLButtonElement>("#workspace-change")?.addEventListener("click", () => void connectFolderWorkspace());
  document.querySelector<HTMLButtonElement>("#workspace-reconnect")?.addEventListener("click", () => void reconnectFolderWorkspace());
  document.querySelector<HTMLButtonElement>("#workspace-refresh")?.addEventListener("click", () => void refreshFolderWorkspace(false));
  document.querySelector<HTMLButtonElement>("#workspace-load")?.addEventListener("click", () => void openSelectedWorkspaceProject());
  document.querySelector<HTMLButtonElement>("#workspace-convert")?.addEventListener("click", () => void convertSelectedWorkspaceProject(false));
  document.querySelectorAll<HTMLButtonElement>("[data-workspace-project]").forEach(button => button.addEventListener("click", () => {
    workspaceSelectedProjectName = button.dataset.workspaceProject ?? "";
    workspaceLastAttemptFingerprint = "";
    void persistWorkspace();
    render();
  }));
  document.querySelector<HTMLInputElement>("#workspace-auto")?.addEventListener("change", event => {
    workspaceAutoConvert = (event.currentTarget as HTMLInputElement).checked;
    workspaceLastAttemptFingerprint = "";
    const selected = selectedWorkspaceProject();
    if (selected) workspaceStableFingerprints.set(selected.name, selected.fingerprint);
    recordWorkspaceActivity("info", `${selected?.name ?? "Workspace"}: automatic conversion ${workspaceAutoConvert ? "enabled" : "disabled"}`);
    void persistWorkspace();
    render();
  });
  document.querySelector<HTMLInputElement>("#workspace-qa")?.addEventListener("change", event => { workspaceIncludeQa = (event.currentTarget as HTMLInputElement).checked; void persistWorkspace(); render(); });
  const folderFallback = document.querySelector<HTMLInputElement>("#folder-fallback-input");
  folderFallback?.addEventListener("change", () => {
    const files = [...(folderFallback.files ?? [])].filter(file => /\.cix$/i.test(file.name));
    items = [];
    selectedName = "";
    workspaceOpen = false;
    void addFiles(files);
  });
  document.querySelector<HTMLButtonElement>("#project-save-open")?.addEventListener("click", () => void openProjectPanel("save"));
  document.querySelector<HTMLButtonElement>("#project-close")?.addEventListener("click", () => { projectModal = undefined; render(); });
  document.querySelector<HTMLButtonElement>("#session-save")?.addEventListener("click", () => void saveCurrentProject());
  document.querySelectorAll<HTMLButtonElement>("[data-open-session]").forEach(button => button.addEventListener("click", () => { if (button.dataset.openSession) void loadProjectSession(button.dataset.openSession); }));
  document.querySelector<HTMLButtonElement>("#corpus-open")?.addEventListener("click", () => { corpusOpen = true; corpusError = ""; render(); });
  document.querySelector<HTMLButtonElement>("#corpus-close")?.addEventListener("click", () => { corpusOpen = false; render(); });
  document.querySelector<HTMLButtonElement>("#corpus-run")?.addEventListener("click", () => void executeCorpusLab());
  document.querySelector<HTMLButtonElement>("#corpus-export")?.addEventListener("click", exportCorpusLab);
  const openMachineEditor = (): void => { machineEditorOpen = true; preflight = undefined; render(); };
  document.querySelector<HTMLButtonElement>("#machine-config")?.addEventListener("click", openMachineEditor);
  document.querySelector<HTMLButtonElement>("#machine-config-card")?.addEventListener("click", openMachineEditor);
  const closeMachineEditor = (): void => { machineEditorOpen = false; render(); };
  document.querySelector<HTMLButtonElement>("#machine-close")?.addEventListener("click", closeMachineEditor);
  document.querySelector<HTMLButtonElement>("#machine-cancel")?.addEventListener("click", closeMachineEditor);
  document.querySelector<HTMLButtonElement>("#machine-disable")?.addEventListener("click", () => {
    machineProfile = undefined;
    localStorage.removeItem("opencnc-machine-profile");
    machineEditorOpen = false;
    render();
  });
  document.querySelector<HTMLButtonElement>("#machine-save")?.addEventListener("click", () => {
    const value = (id: string): string => document.querySelector<HTMLInputElement>(`#${id}`)?.value.trim() ?? "";
    const requiredNumber = (id: string): number => Number(value(id).replace(",", "."));
    const optionalNumber = (id: string): number | undefined => value(id) ? requiredNumber(id) : undefined;
    const numberList = (id: string): number[] => value(id).split(/[,;\s]+/).filter(Boolean).map(item => Number(item.replace(",", "."))).filter(Number.isFinite);
    const tools = (["drill", "router", "saw"] as const).flatMap(kind => numberList(`machine-${kind}-tools`).map(diameter => ({ kind, diameter })));
    const candidate: MachineProfile = {
      schemaVersion: "0.1", id: "local-machine", name: value("machine-name") || "Local CNC",
      travel: {
        minX: requiredNumber("machine-min-x"), maxX: requiredNumber("machine-max-x"), minY: requiredNumber("machine-min-y"), maxY: requiredNumber("machine-max-y"),
        ...(optionalNumber("machine-min-z") !== undefined ? { minZ: optionalNumber("machine-min-z")! } : {}), ...(optionalNumber("machine-max-z") !== undefined ? { maxZ: optionalNumber("machine-max-z")! } : {})
      },
      supportedFaces: numberList("machine-faces"),
      ...(optionalNumber("machine-drill-depth") !== undefined ? { maxDrillDepth: optionalNumber("machine-drill-depth")! } : {}),
      ...(optionalNumber("machine-route-depth") !== undefined ? { maxRouteDepth: optionalNumber("machine-route-depth")! } : {}),
      ...(optionalNumber("machine-saw-depth") !== undefined ? { maxSawDepth: optionalNumber("machine-saw-depth")! } : {}),
      ...(tools.length ? { availableTools: tools } : {})
    };
    const issues = validateMachineProfile(candidate);
    const error = document.querySelector<HTMLElement>("#machine-error");
    if (issues.length) { if (error) error.textContent = issues.join(" · "); return; }
    machineProfile = candidate;
    localStorage.setItem("opencnc-machine-profile", JSON.stringify(candidate));
    machineEditorOpen = false;
    render();
  });
  const input = document.querySelector<HTMLInputElement>("#file-input");
  input?.addEventListener("change", () => void addFiles([...(input.files ?? [])]));
  const zone = document.querySelector<HTMLElement>("#dropzone");
  zone?.addEventListener("dragover", event => { event.preventDefault(); zone.classList.add("dragging"); });
  zone?.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone?.addEventListener("drop", event => { event.preventDefault(); zone.classList.remove("dragging"); void addFiles([...(event.dataTransfer?.files ?? [])]); });
  document.querySelector<HTMLButtonElement>("#demo")?.addEventListener("click", () => {
    const demo = parseInput(DEMO_NAME, DEMO_CIX, new Blob([DEMO_CIX]).size);
    items = [demo]; selectedName = demo.name; tracedOperationIds = []; render();
  });
  document.querySelector<HTMLButtonElement>("#clear")?.addEventListener("click", () => { items = []; selectedName = ""; notice = ""; preflight = undefined; tracedOperationIds = []; previewFilters = { topDrill: true, sideDrill: true, route: true, advanced: true }; render(); });
  const bulkNameInput = document.querySelector<HTMLInputElement>("#bulk-archive-name");
  bulkNameInput?.addEventListener("input", event => {
    bulkArchiveName = (event.currentTarget as HTMLInputElement).value;
  });
  bulkNameInput?.addEventListener("blur", event => {
    bulkArchiveName = zipFilename((event.currentTarget as HTMLInputElement).value).replace(/\.zip$/i, "");
    (event.currentTarget as HTMLInputElement).value = bulkArchiveName;
  });
  document.querySelector<HTMLButtonElement>("#bulk-convert")?.addEventListener("click", () => {
    openPreflight(items, "bulk");
  });
  const closePreflight = (): void => { preflight = undefined; render(); };
  document.querySelector<HTMLButtonElement>("#preflight-close")?.addEventListener("click", closePreflight);
  document.querySelector<HTMLButtonElement>("#preflight-cancel")?.addEventListener("click", closePreflight);
  document.querySelector<HTMLButtonElement>("#preflight-download")?.addEventListener("click", () => void completePreflightDownload());
  document.querySelector<HTMLInputElement>("#preflight-qa")?.addEventListener("change", event => { if (preflight) preflight.includeQaPdf = (event.currentTarget as HTMLInputElement).checked; render(); });
  document.querySelector<HTMLSelectElement>("#preflight-template")?.addEventListener("change", event => {
    if (!preflight) return;
    const template = (event.currentTarget as HTMLSelectElement).value;
    if (template !== "opposite" && template !== "converted" && template !== "direction") return;
    preflight.template = template;
    preflight.rows.forEach((row, index) => {
      const item = preflight!.result.outputs[index]!;
      row.outputName = outputNameFromTemplate(item.name, item.sourceFormat, item.targetFormat, template);
    });
    render();
  });
  document.querySelectorAll<HTMLInputElement>("[data-include-key]").forEach(input => input.addEventListener("change", () => {
    const row = preflight?.rows.find(candidate => candidate.key === input.dataset.includeKey);
    if (row) row.included = input.checked;
    render();
  }));
  document.querySelectorAll<HTMLInputElement>("[data-output-key]").forEach(input => {
    const updateOutputName = (): void => {
      if (!preflight) return;
      const row = preflight.rows.find(candidate => candidate.key === input.dataset.outputKey);
      const item = preflight.result.outputs[Number(input.dataset.outputKey)];
      if (row && item) row.outputName = sanitizeOutputName(input.value, item.targetFormat, item.outputName);
      refreshPreflightValidation();
    };
    input.addEventListener("input", updateOutputName);
    input.addEventListener("blur", () => { updateOutputName(); render(); });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-detail-key]").forEach(button => button.addEventListener("click", () => {
    if (preflight && button.dataset.detailKey !== undefined) preflight.detailKey = button.dataset.detailKey;
    render();
  }));
  const preflightArchiveName = document.querySelector<HTMLInputElement>("#preflight-archive-name");
  preflightArchiveName?.addEventListener("input", () => { bulkArchiveName = preflightArchiveName.value; });
  preflightArchiveName?.addEventListener("blur", () => {
    bulkArchiveName = zipFilename(preflightArchiveName.value).replace(/\.zip$/i, "");
    preflightArchiveName.value = bulkArchiveName;
  });
  document.querySelectorAll<HTMLButtonElement>("[data-select]").forEach(button => button.addEventListener("click", () => { selectedName = button.dataset.select ?? ""; tracedOperationIds = []; render(); }));
  const active = selectedItem();
  if (active) {
    const trace = (operationIds: string[]): void => {
      for (const operation of active.document.operations.filter(operation => operationIds.includes(operation.id))) {
        const layer = previewLayer(operation);
        if (layer) previewFilters[layer] = true;
      }
      const alreadySelected = operationIds.length === tracedOperationIds.length && operationIds.every(id => tracedOperationIds.includes(id));
      tracedOperationIds = alreadySelected ? [] : operationIds;
      render();
    };
    document.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach(button => button.addEventListener("click", () => {
      const layer = button.dataset.layer;
      if (layer === "topDrill" || layer === "sideDrill" || layer === "route" || layer === "advanced") {
        previewFilters[layer] = !previewFilters[layer];
        render();
      }
    }));
    document.querySelectorAll<HTMLButtonElement>("[data-trace]").forEach(button => button.addEventListener("click", () => {
      const operationIds = (button.dataset.trace ?? "").split(",").filter(Boolean).map(id => decodeURIComponent(id));
      if (operationIds.length) trace(operationIds);
    }));
    const visibleOperations = filterPreviewOperations(active.document.operations, previewFilters);
    const visibleIds = new Set(visibleOperations.map(operation => operation.id));
    document.querySelector<HTMLElement>("#preview-svg")!.innerHTML = renderSvg(active.document, { operationIds: visibleIds, highlightedOperationIds: new Set(tracedOperationIds) });
    document.querySelectorAll<SVGGElement>("[data-operation-id]").forEach(shape => {
      const selectShape = (): void => trace(shape.dataset.operationId ? [shape.dataset.operationId] : []);
      shape.addEventListener("click", selectShape);
      shape.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectShape(); }
      });
    });
    document.querySelector<HTMLButtonElement>("#print")?.addEventListener("click", () => window.print());
    document.querySelector<HTMLButtonElement>("#convert")?.addEventListener("click", () => {
      openPreflight([active], "single");
    });
    document.querySelector<HTMLButtonElement>("#save-json")?.addEventListener("click", () => download(JSON.stringify(active.document, null, 2), active.name.replace(/\.(bpp|cix)$/i, ".opencnc.json"), "application/json"));
    document.querySelector<HTMLButtonElement>("#save-svg")?.addEventListener("click", () => download(renderSvg(active.document), active.name.replace(/\.(bpp|cix)$/i, ".svg"), "image/svg+xml"));
  }
};

function render(): void {
  app!.innerHTML = items.length ? loadedView() : emptyView();
  bind();
}

render();
void restoreFolderWorkspace();
window.setInterval(() => { if (workspaceRoot && workspacePermissionState === "granted") void refreshFolderWorkspace(true); }, 10_000);
