import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateDocument } from "../../core/src/index.js";
import { parseBpp } from "../../parser-bpp/src/index.js";
import { parseCix } from "../../parser-cix/src/index.js";
import { anonymizeCncSource, compareCorpusReports, publicCorpusReport, runCorpusLab } from "./index.js";

const fixture = async (name: "minimal.bpp" | "minimal.cix" | "advanced.cix") => {
  const sourceText = await readFile(new URL(`../../../fixtures/synthetic/${name}`, import.meta.url), "utf8");
  const document = name.endsWith(".bpp") ? parseBpp(sourceText, name) : parseCix(sourceText, name);
  document.diagnostics.push(...validateDocument(document));
  return { name, sourceText, document };
};

describe("Regression Corpus Lab", () => {
  it("redacts linked CIX labels without altering machining geometry", async () => {
    const input = await fixture("minimal.cix");
    const sourceText = `; Customer: Acme Cabinets\n${input.sourceText.replace('PARAM,NAME=LAY,VALUE="Synthetic drill row"', 'PARAM,NAME=LAY,VALUE="Acme kitchen east"')}`;
    const document = parseCix(sourceText, "private-client.cix");
    document.diagnostics.push(...validateDocument(document));
    const redacted = anonymizeCncSource("cix", sourceText);
    expect(redacted.sourceText).not.toContain("Acme");
    expect(redacted.redactionCount).toBeGreaterThanOrEqual(2);
    const report = await runCorpusLab([{ name: "private-client.cix", sourceText, document }], "2026-08-30T12:00:00.000Z");
    expect(report.files[0]?.anonymousName).toBe("fixture-0001.cix");
    expect(report.files[0]?.sanitizedMachiningPreserved).toBe(true);
    expect(report.summary.rendererPassed).toBe(1);
    expect(report.summary.robustnessPassed).toBe(report.summary.robustnessTotal);
  });

  it("runs both format directions and emits a privacy-safe public report", async () => {
    const inputs = await Promise.all([fixture("minimal.bpp"), fixture("minimal.cix")]);
    const report = await runCorpusLab(inputs, "2026-08-30T12:00:00.000Z");
    expect(report.summary.files).toBe(2);
    expect(report.summary.conversionsVerified).toBe(2);
    expect(report.summary.reverseVerified).toBe(2);
    expect(report.summary.semanticRoundTrips).toBe(2);
    expect(report.summary.geometryRoundTrips).toBe(2);
    expect(report.summary.novelSignatureCount).toBeGreaterThan(0);
    expect(publicCorpusReport(report).files.every(file => file.sanitizedSourceText === "")).toBe(true);
  });

  it("keeps linked advanced-operation identifiers consistent while reducing blocked fixtures", async () => {
    const input = await fixture("advanced.cix");
    const report = await runCorpusLab([input], "2026-08-30T12:00:00.000Z");
    expect(report.files[0]?.sanitizedMachiningPreserved).toBe(true);
    expect(report.files[0]?.conversionStatus).toBe("blocked");
    expect(report.files[0]?.reducedFailureFixture).toContain("CONVERSION_OPERATION_UNSUPPORTED");
  });

  it("compares report quality across engine runs", async () => {
    const input = await fixture("minimal.bpp");
    const previous = await runCorpusLab([input], "2026-08-29T12:00:00.000Z");
    const current = await runCorpusLab([input], "2026-08-30T12:00:00.000Z");
    const comparison = compareCorpusReports(current, previous);
    expect(comparison.comparableFiles).toBe(1);
    expect(comparison.unchangedFiles).toBe(1);
    expect(comparison.regressedFiles).toBe(0);
  });
});
