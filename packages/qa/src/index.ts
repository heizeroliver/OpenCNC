import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { operationPoints, type ArcSegment, type OpenCncDocument, type Operation, type Point } from "../../core/src/index.js";
import type { BulkConversionItem } from "../../converter/src/index.js";

export interface QaJobSheetInput {
  item: BulkConversionItem;
  sourceDocument: OpenCncDocument;
  sourceText: string;
  outputName?: string;
  generatedAt?: string;
}

export interface QaJobSheetResult {
  bytes: Uint8Array;
  filename: string;
  reportId: string;
  sourceChecksum: string;
  targetChecksum: string;
  fidelityGrade: "A" | "B" | "C" | "BLOCKED";
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const INK = rgb(0.12, 0.15, 0.13);
const MUTED = rgb(0.39, 0.43, 0.41);
const ORANGE = rgb(0.93, 0.42, 0.18);
const GREEN = rgb(0.14, 0.48, 0.34);
const RED = rgb(0.78, 0.29, 0.20);
const BLUE = rgb(0.16, 0.41, 0.67);
const PALE = rgb(0.96, 0.95, 0.92);
const LINE = rgb(0.82, 0.82, 0.78);

const ascii = (value: string): string => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "?");
const stem = (name: string): string => name.replace(/\.(bpp|cix)$/i, "");
const safeFilename = (name: string): string => ascii(name).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 160) || "opencnc-job";

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const wrappedLines = (text: string, font: PDFFont, size: number, width: number): string[] => {
  const words = ascii(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
    else {
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= width) line = word;
      else {
        let part = "";
        for (const character of word) {
          if (font.widthOfTextAtSize(part + character, size) > width && part) { lines.push(part); part = character; }
          else part += character;
        }
        line = part;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
};

const drawWrapped = (page: PDFPage, text: string, options: { x: number; y: number; width: number; size: number; font: PDFFont; color?: ReturnType<typeof rgb>; lineHeight?: number; maxLines?: number }): number => {
  const lineHeight = options.lineHeight ?? options.size * 1.3;
  const lines = wrappedLines(text, options.font, options.size, options.width).slice(0, options.maxLines ?? 99);
  lines.forEach((line, index) => page.drawText(line, { x: options.x, y: options.y - index * lineHeight, size: options.size, font: options.font, color: options.color ?? INK }));
  return options.y - lines.length * lineHeight;
};

const fidelityGrade = (item: BulkConversionItem): QaJobSheetResult["fidelityGrade"] => {
  if (item.status !== "converted" || item.diff.counts.changed || item.diff.counts.unsupported) return "BLOCKED";
  const warnings = item.diagnostics.filter(value => value.severity === "warning").length + item.machineChecks.filter(value => value.severity === "warning").length;
  if (warnings) return "C";
  if (item.diff.counts.equivalent || item.diff.counts.metadata) return "B";
  return "A";
};

const arcPoints = (segment: ArcSegment): Point[] => {
  if (!segment.center) return segment.via ? [segment.start, segment.via, segment.end] : [segment.start, segment.end];
  const radius = Math.hypot(segment.start.x - segment.center.x, segment.start.y - segment.center.y);
  const start = Math.atan2(segment.start.y - segment.center.y, segment.start.x - segment.center.x);
  const end = Math.atan2(segment.end.y - segment.center.y, segment.end.x - segment.center.x);
  const tau = Math.PI * 2;
  const positive = (value: number): number => ((value % tau) + tau) % tau;
  const sweep = segment.clockwise ? positive(end - start) : -positive(start - end);
  return Array.from({ length: 19 }, (_, index) => {
    const angle = start + sweep * index / 18;
    return { x: segment.center!.x + radius * Math.cos(angle), y: segment.center!.y + radius * Math.sin(angle) };
  });
};

const operationPath = (operation: Operation): Point[] => operation.segments?.length
  ? operation.segments.flatMap((segment, index) => segment.kind === "arc" ? arcPoints(segment).slice(index ? 1 : 0) : [segment.start, segment.end].slice(index ? 1 : 0))
  : operation.path ?? [];

const drawPanelPreview = (page: PDFPage, document: OpenCncDocument, box: { x: number; y: number; width: number; height: number }): void => {
  const panelWidth = document.panel.width ?? 1000;
  const panelHeight = document.panel.height ?? 600;
  const scale = Math.min(box.width / panelWidth, box.height / panelHeight);
  const width = panelWidth * scale;
  const height = panelHeight * scale;
  const originX = box.x + (box.width - width) / 2;
  const originY = box.y + (box.height - height) / 2;
  page.drawRectangle({ x: originX, y: originY, width, height, color: rgb(0.91, 0.78, 0.57), borderColor: INK, borderWidth: 0.8 });
  const map = (point: Point): Point => ({ x: originX + point.x * scale, y: originY + height - point.y * scale });
  for (const operation of document.operations) {
    if (operation.kind === "drill") {
      for (const source of operationPoints(operation)) {
        const point = map(source);
        page.drawCircle({ x: point.x, y: point.y, size: Math.max(1.2, (operation.diameter ?? 4) * scale / 2), color: operation.face === undefined || operation.face === 0 ? RED : rgb(0.74, 0.49, 0.11) });
      }
      continue;
    }
    const path = operationPath(operation);
    const color = operation.kind === "route" ? BLUE : operation.kind === "saw" || operation.kind === "cut" ? rgb(0.03, 0.57, 0.69) : rgb(0.49, 0.23, 0.85);
    path.slice(1).forEach((point, index) => page.drawLine({ start: map(path[index]!), end: map(point), thickness: Math.max(1, (operation.diameter ?? 2) * scale), color }));
  }
};

const metric = (page: PDFPage, bold: PDFFont, regular: PDFFont, x: number, y: number, value: string, label: string, color = INK): void => {
  page.drawText(ascii(value), { x, y, size: 19, font: bold, color });
  page.drawText(ascii(label.toUpperCase()), { x, y: y - 13, size: 6.5, font: regular, color: MUTED });
};

export async function generateQaJobSheet(input: QaJobSheetInput): Promise<QaJobSheetResult> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const targetText = input.item.contents ?? "";
  const [sourceChecksum, targetChecksum] = await Promise.all([sha256Hex(input.sourceText), sha256Hex(targetText)]);
  const reportSeed = `${sourceChecksum}:${targetChecksum}:${input.item.name}:${input.outputName ?? input.item.outputName}`;
  const reportHash = await sha256Hex(reportSeed);
  const reportId = `OC-${reportHash.slice(0, 4).toUpperCase()}-${reportHash.slice(4, 8).toUpperCase()}-${reportHash.slice(8, 12).toUpperCase()}`;
  const grade = fidelityGrade(input.item);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`OpenCNC QA - ${input.item.name}`);
  pdf.setAuthor("OpenCNC local QA package");
  pdf.setSubject(`Interoperability inspection ${reportId}`);
  pdf.setKeywords(["OpenCNC", "BPP", "CIX", "QA", reportId]);
  pdf.setCreationDate(new Date(generatedAt));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 8, width: PAGE_WIDTH, height: 8, color: ORANGE });
  page.drawRectangle({ x: 38, y: 775, width: 32, height: 32, color: INK });
  page.drawText("OC", { x: 45, y: 786, size: 12, font: bold, color: rgb(1, 1, 1) });
  page.drawText("OpenCNC", { x: 80, y: 794, size: 16, font: bold, color: INK });
  page.drawText("PRODUCTION QA PACKAGE", { x: 80, y: 781, size: 7, font: bold, color: ORANGE });
  page.drawText(`REPORT ${reportId}`, { x: 405, y: 792, size: 8, font: mono, color: INK });
  page.drawText(ascii(generatedAt), { x: 405, y: 779, size: 6.7, font: regular, color: MUTED });

  page.drawText("INTEROPERABILITY DRAFT - VENDOR SIMULATION REQUIRED", { x: 38, y: 747, size: 8, font: bold, color: grade === "BLOCKED" ? RED : ORANGE });
  drawWrapped(page, "This sheet documents OpenCNC checks. It does not approve machine execution, tooling, workholding, controller behavior, or collision safety.", { x: 38, y: 733, width: 519, size: 7.5, font: regular, color: MUTED, maxLines: 2 });

  page.drawRectangle({ x: 38, y: 650, width: 519, height: 58, color: PALE, borderColor: LINE, borderWidth: 0.7 });
  page.drawText("SOURCE", { x: 50, y: 692, size: 6.5, font: bold, color: MUTED });
  drawWrapped(page, input.item.name, { x: 50, y: 677, width: 218, size: 10, font: bold, maxLines: 2 });
  page.drawText(`${input.item.sourceFormat.toUpperCase()}  >  ${input.item.targetFormat.toUpperCase()}`, { x: 274, y: 677, size: 11, font: bold, color: BLUE });
  page.drawText("OUTPUT", { x: 355, y: 692, size: 6.5, font: bold, color: MUTED });
  drawWrapped(page, input.outputName ?? input.item.outputName, { x: 355, y: 677, width: 190, size: 10, font: bold, maxLines: 2 });

  const drillCount = input.sourceDocument.operations.filter(operation => operation.kind === "drill").reduce((total, operation) => total + operationPoints(operation).length, 0);
  const routeCount = input.sourceDocument.operations.filter(operation => operation.kind === "route").length;
  const advancedCount = input.sourceDocument.operations.filter(operation => !["drill", "route", "unknown"].includes(operation.kind)).length;
  metric(page, bold, regular, 48, 614, `${input.sourceDocument.panel.width ?? "?"} x ${input.sourceDocument.panel.height ?? "?"}`, "panel mm");
  metric(page, bold, regular, 194, 614, String(drillCount), "drills");
  metric(page, bold, regular, 285, 614, String(routeCount), "routes");
  metric(page, bold, regular, 375, 614, String(advancedCount), "advanced");
  metric(page, bold, regular, 475, 614, grade, "fidelity", grade === "A" || grade === "B" ? GREEN : grade === "BLOCKED" ? RED : ORANGE);

  page.drawText("WORKPIECE PREVIEW", { x: 38, y: 574, size: 7, font: bold, color: MUTED });
  drawPanelPreview(page, input.sourceDocument, { x: 38, y: 397, width: 519, height: 164 });

  const warnings = [
    ...input.item.diagnostics.filter(value => value.severity !== "info").map(value => `${value.code}: ${value.message}`),
    ...input.item.machineChecks.filter(value => value.severity === "warning").map(value => `${value.code}: ${value.message}`)
  ];
  page.drawText("CHECK RESULTS", { x: 38, y: 374, size: 7, font: bold, color: MUTED });
  page.drawRectangle({ x: 38, y: 272, width: 519, height: 90, color: rgb(0.985, 0.982, 0.968), borderColor: LINE, borderWidth: 0.7 });
  const checkLines = [
    `Target reparse: ${input.item.verified ? "PASS" : "FAIL"}    Reverse conversion: ${input.item.reverseVerified ? "PASS" : "FAIL"}`,
    `Semantic round trip: ${input.item.supportedSemanticRoundTrip ? "PASS" : "FAIL"}    Expanded geometry: ${input.item.expandedGeometryRoundTrip ? "PASS" : "FAIL"}`,
    `Exact fields: ${input.item.diff.counts.exact}    Equivalent: ${input.item.diff.counts.equivalent}    Normalized: ${input.item.diff.counts.normalized}    Unsupported: ${input.item.diff.counts.unsupported}`,
    warnings.length ? `Warnings (${warnings.length}): ${warnings.slice(0, 2).join(" | ")}${warnings.length > 2 ? ` | +${warnings.length - 2} more in JSON report` : ""}` : "Warnings: none reported by OpenCNC"
  ];
  let checkY = 345;
  checkLines.forEach((line, index) => { checkY = drawWrapped(page, line, { x: 50, y: checkY, width: 495, size: index === 3 ? 6.6 : 7.2, font: index < 3 ? bold : regular, color: index === 3 && warnings.length ? ORANGE : INK, maxLines: index === 3 ? 2 : 1 }) - 4; });

  page.drawText("FILE INTEGRITY", { x: 38, y: 251, size: 7, font: bold, color: MUTED });
  page.drawText(`Source SHA-256  ${sourceChecksum}`, { x: 38, y: 235, size: 6.1, font: mono, color: INK });
  page.drawText(`Target SHA-256  ${targetChecksum}`, { x: 38, y: 222, size: 6.1, font: mono, color: INK });
  page.drawText(`Dialect  ${input.item.sourceProfile.profileId} (${input.item.sourceProfile.confidence})`, { x: 38, y: 208, size: 6.5, font: regular, color: MUTED });

  const qrData = await QRCode.toDataURL(`opencnc://local-report/${reportId}`, { errorCorrectionLevel: "M", margin: 1, width: 160, color: { dark: "#202522", light: "#FAF9F5" } });
  const qr = await pdf.embedPng(qrData);
  page.drawImage(qr, { x: 462, y: 112, width: 78, height: 78 });
  page.drawText(reportId, { x: 457, y: 99, size: 6.4, font: mono, color: INK });
  page.drawText("LOCAL REPORT ID", { x: 466, y: 88, size: 5.8, font: bold, color: MUTED });

  page.drawText("WORKSHOP SIGN-OFF", { x: 38, y: 181, size: 7, font: bold, color: MUTED });
  const checkbox = (x: number, y: number, label: string): void => {
    page.drawRectangle({ x, y, width: 10, height: 10, borderColor: INK, borderWidth: 0.8 });
    page.drawText(label, { x: x + 16, y: y + 1, size: 7, font: regular, color: INK });
  };
  checkbox(38, 158, "Vendor simulation completed");
  checkbox(224, 158, "Tooling and workholding checked");
  checkbox(38, 137, "Approved for production by authorized operator");
  page.drawLine({ start: { x: 38, y: 112 }, end: { x: 225, y: 112 }, thickness: 0.7, color: INK });
  page.drawLine({ start: { x: 250, y: 112 }, end: { x: 420, y: 112 }, thickness: 0.7, color: INK });
  page.drawText("Operator / signature", { x: 38, y: 100, size: 6.2, font: regular, color: MUTED });
  page.drawText("Date / time", { x: 250, y: 100, size: 6.2, font: regular, color: MUTED });

  page.drawLine({ start: { x: 38, y: 61 }, end: { x: 557, y: 61 }, thickness: 0.6, color: LINE });
  page.drawText("OpenCNC local inspection artifact - not a machine program", { x: 38, y: 45, size: 6.5, font: regular, color: MUTED });
  page.drawText("1 / 1", { x: 532, y: 45, size: 6.5, font: bold, color: INK });

  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, filename: `${safeFilename(stem(input.outputName ?? input.item.outputName))}-${input.item.sourceFormat}-to-${input.item.targetFormat}-qa.pdf`, reportId, sourceChecksum, targetChecksum, fidelityGrade: grade };
}
