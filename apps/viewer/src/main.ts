import "./styles.css";
import { validateDocument, type OpenCncDocument } from "../../../packages/core/src/index.js";
import { parseBpp } from "../../../packages/parser-bpp/src/index.js";
import { parseCix } from "../../../packages/parser-cix/src/index.js";
import { renderSvg } from "../../../packages/svg/src/index.js";
import { DEMO_CIX, DEMO_NAME } from "./demo.js";
import { compareDocuments, groupDrills, groupRoutes, jobStem, summarizeDocument } from "./workshop.js";

type Language = "hu" | "en";

interface ParsedItem {
  name: string;
  size: number;
  document: OpenCncDocument;
}

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
    selected: "kiválasztva", addMore: "További fájlok"
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
    selected: "selected", addMore: "Add more files"
  }
} as const;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Application root not found");

let language: Language = localStorage.getItem("opencnc-language") === "en" ? "en" : "hu";
let items: ParsedItem[] = [];
let selectedName = "";
let notice = "";

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const number = (value: number | undefined): string => value === undefined ? "—" : new Intl.NumberFormat(language === "hu" ? "hu-HU" : "en-GB", { maximumFractionDigits: 2 }).format(value);
const coordinate = (point: { x: number; y: number } | undefined): string => point ? `${number(point.x)}, ${number(point.y)}` : "—";
const selectedItem = (): ParsedItem | undefined => items.find(item => item.name === selectedName) ?? items[0];

const parseInput = (name: string, input: string, size: number): ParsedItem => {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (extension !== "bpp" && extension !== "cix") throw new Error("Unsupported extension");
  const document = extension === "bpp" ? parseBpp(input, name) : parseCix(input, name);
  document.diagnostics.push(...validateDocument(document));
  return { name, size, document };
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

const download = (contents: string, filename: string, type: string): void => {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const header = (): string => {
  const c = text[language];
  return `<header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span><strong>OpenCNC</strong><small>${c.workshop}</small></span></div>
    <div class="top-actions"><div class="privacy"><span></span> ${c.local}</div><button class="language" id="language" aria-label="Change language">${language === "hu" ? "EN" : "HU"}</button></div>
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
  </main><footer>${c.footer}</footer>`;
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
  const drillRows = groupDrills(document.operations).map(group => `<tr><td><strong>${group.quantity}</strong></td><td>${number(group.diameter)} mm</td><td>${number(group.depth)} mm</td><td>${group.face ?? "—"}</td><td class="coordinate">${coordinate(group.first)} → ${coordinate(group.last)}</td></tr>`).join("");
  const routeRows = groupRoutes(document.operations).map(group => `<tr><td><strong>${group.quantity}</strong></td><td>${number(group.diameter)} mm</td><td>${number(group.depth)} mm</td><td>${group.face ?? "—"}</td><td>${number(group.totalLength)} mm</td></tr>`).join("");
  const empty = `<p class="empty-note">${c.none}</p>`;
  return `<section class="detail-card"><div class="section-heading"><h3>${c.drillList}</h3><span>${groupDrills(document.operations).reduce((sum, group) => sum + group.quantity, 0)} ${c.quantity.toLocaleLowerCase()}</span></div>
    ${drillRows ? `<div class="table-scroll"><table><thead><tr><th>${c.quantity}</th><th>${c.diameter}</th><th>${c.depth}</th><th>${c.face}</th><th>${c.span}</th></tr></thead><tbody>${drillRows}</tbody></table></div>` : empty}
  </section>
  <section class="detail-card"><div class="section-heading"><h3>${c.routeList}</h3><span>${groupRoutes(document.operations).reduce((sum, group) => sum + group.quantity, 0)} ${c.quantity.toLocaleLowerCase()}</span></div>
    ${routeRows ? `<div class="table-scroll"><table><thead><tr><th>${c.quantity}</th><th>${c.diameter}</th><th>${c.depth}</th><th>${c.face}</th><th>${c.length}</th></tr></thead><tbody>${routeRows}</tbody></table></div>` : empty}
  </section>`;
};

const comparisonCard = (item: ParsedItem): string => {
  const c = text[language];
  const pair = items.find(candidate => candidate.name !== item.name && jobStem(candidate.name) === jobStem(item.name) && candidate.document.source.format !== item.document.source.format);
  if (!pair) return `<section class="detail-card comparison"><div class="section-heading"><h3>${c.comparison}</h3></div><p class="empty-note">${c.noPair}</p></section>`;
  const result = compareDocuments(item.document, pair.document);
  const status = result.geometryMatch ? "match" : result.dimensionsMatch ? "different" : "error";
  const message = result.geometryMatch ? c.geometryMatch : result.dimensionsMatch ? c.dimensionsMatch : c.dimensionsDiffer;
  return `<section class="detail-card comparison"><div class="section-heading"><h3>${c.comparison}</h3><span class="compare-status ${status}">${status === "match" ? "✓" : "!"} ${message}</span></div><p>${c.comparedWith}: <strong>${escapeHtml(pair.name)}</strong></p>${result.geometryMatch ? "" : `<p class="comparison-note">${c.sourceDifference}</p>`}</section>`;
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
  return `${header()}<main class="shell loaded-shell">
    <section class="dashboard-head"><div><p class="eyebrow">${c.eyebrow}</p><h1>${c.dashboard}</h1><p>${c.private}</p></div><div class="head-actions"><button class="secondary" id="clear">${c.clear}</button></div></section>
    ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
    ${dropzone(true)}
    <section class="summary-grid">
      <div class="summary-card"><small>${c.pieces.toUpperCase()}</small><strong>${workpieceCount}</strong><span>${items.length} .bpp / .cix</span></div>
      <div class="summary-card"><small>${c.drills.toUpperCase()}</small><strong>${summary.drillCount}</strong><span>${c.selected}</span></div>
      <div class="summary-card"><small>${c.routes.toUpperCase()}</small><strong>${summary.routeCount}</strong><span>${c.selected}</span></div>
      <div class="summary-card"><small>${c.alerts.toUpperCase()}</small><strong class="${activeAlerts ? "warn" : "good"}">${activeAlerts}</strong><span>${c.selected}</span></div>
    </section>
    <section class="workspace">
      <aside class="file-panel"><div class="panel-title"><h2>${c.files}</h2><span>${items.length}</span></div><div class="file-list">${fileList()}</div></aside>
      <article class="job-sheet">
        <header class="job-head"><div><span class="format-pill ${active.document.source.format}">${active.document.source.format.toUpperCase()}</span><h2>${escapeHtml(active.name.replace(/\.(bpp|cix)$/i, ""))}</h2><p>${c.dimensions}: <strong>${number(panel.width)} × ${number(panel.height)} × ${number(panel.thickness)} mm</strong> · ${summary.drillCount} ${c.drills.toLocaleLowerCase()} · ${summary.routeCount} ${c.routes.toLocaleLowerCase()}</p></div>
          <div class="job-actions"><button class="secondary" id="save-json">${c.json}</button><button class="secondary" id="save-svg">${c.svg}</button><button class="primary" id="print">${c.print}</button></div>
        </header>
        <section class="preview-card"><div class="section-heading"><h3>${c.visual}</h3><div class="legend"><span class="red">${c.topDrill}</span><span class="amber">${c.sideDrill}</span><span class="blue">${c.route}</span></div></div><div class="preview-canvas" id="preview-svg"></div></section>
        <div class="details-grid">${operationTables(active.document)}${comparisonCard(active)}${diagnosticsCard(active.document)}</div>
      </article>
    </section>
  </main><footer>${c.footer}</footer>`;
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
  const input = document.querySelector<HTMLInputElement>("#file-input");
  input?.addEventListener("change", () => void addFiles([...(input.files ?? [])]));
  const zone = document.querySelector<HTMLElement>("#dropzone");
  zone?.addEventListener("dragover", event => { event.preventDefault(); zone.classList.add("dragging"); });
  zone?.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone?.addEventListener("drop", event => { event.preventDefault(); zone.classList.remove("dragging"); void addFiles([...(event.dataTransfer?.files ?? [])]); });
  document.querySelector<HTMLButtonElement>("#demo")?.addEventListener("click", () => {
    const demo = parseInput(DEMO_NAME, DEMO_CIX, new Blob([DEMO_CIX]).size);
    items = [demo]; selectedName = demo.name; render();
  });
  document.querySelector<HTMLButtonElement>("#clear")?.addEventListener("click", () => { items = []; selectedName = ""; notice = ""; render(); });
  document.querySelectorAll<HTMLButtonElement>("[data-select]").forEach(button => button.addEventListener("click", () => { selectedName = button.dataset.select ?? ""; render(); }));
  const active = selectedItem();
  if (active) {
    document.querySelector<HTMLElement>("#preview-svg")!.innerHTML = renderSvg(active.document);
    document.querySelector<HTMLButtonElement>("#print")?.addEventListener("click", () => window.print());
    document.querySelector<HTMLButtonElement>("#save-json")?.addEventListener("click", () => download(JSON.stringify(active.document, null, 2), active.name.replace(/\.(bpp|cix)$/i, ".opencnc.json"), "application/json"));
    document.querySelector<HTMLButtonElement>("#save-svg")?.addEventListener("click", () => download(renderSvg(active.document), active.name.replace(/\.(bpp|cix)$/i, ".svg"), "image/svg+xml"));
  }
};

function render(): void {
  app!.innerHTML = items.length ? loadedView() : emptyView();
  bind();
}

render();
