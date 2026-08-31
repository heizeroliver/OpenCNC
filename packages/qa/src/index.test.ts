import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { bulkConvertAndVerify } from "../../converter/src/index.js";
import { parseBpp } from "../../parser-bpp/src/index.js";
import { generateQaJobSheet, sha256Hex } from "./index.js";

const fixture = (): Promise<string> => readFile(new URL("../../../fixtures/synthetic/minimal.bpp", import.meta.url), "utf8");

describe("production QA package", () => {
  it("creates a valid one-page PDF with deterministic integrity metadata", async () => {
    const sourceText = await fixture();
    const sourceDocument = parseBpp(sourceText, "minimal.bpp");
    const item = bulkConvertAndVerify([{ name: "minimal.bpp", document: sourceDocument }]).outputs[0]!;
    const qa = await generateQaJobSheet({ item, sourceDocument, sourceText, generatedAt: "2026-08-30T12:00:00.000Z" });
    expect(qa.filename).toBe("minimal-bpp-to-cix-qa.pdf");
    expect(qa.reportId).toMatch(/^OC-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
    expect(qa.sourceChecksum).toBe(await sha256Hex(sourceText));
    expect(qa.fidelityGrade).toMatch(/^[AB]$/);
    const pdf = await PDFDocument.load(qa.bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toContain("minimal.bpp");
  });
});
