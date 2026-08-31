import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseBpp } from "../../parser-bpp/src/index.js";
import { parseCix } from "../../parser-cix/src/index.js";
import { bulkConvertAndVerify, compareDocuments, convertAndVerify, convertDocument, createConversionDiff, documentsGeometryEqual, validateBiesseBppV150 } from "./index.js";

const fixture = (name: string): Promise<string> => readFile(new URL(`../../../fixtures/synthetic/${name}`, import.meta.url), "utf8");

describe("BPP and CIX conversion", () => {
  it("converts BPP to verified CIX matching the paired fixture", async () => {
    const source = parseBpp(await fixture("minimal.bpp"), "minimal.bpp");
    const expected = parseCix(await fixture("minimal.cix"), "minimal.cix");
    const result = convertAndVerify(source, "cix");
    expect(result.verified).toBe(true);
    expect(result.contents).toContain("BEGIN MAINDATA");
    expect(result.contents).toContain("NAME=ROUT");
    expect(result.reparsed && documentsGeometryEqual(result.reparsed, expected)).toBe(true);
  });

  it("converts CIX to verified BPP matching the paired fixture", async () => {
    const source = parseCix(await fixture("minimal.cix"), "minimal.cix");
    const expected = parseBpp(await fixture("minimal.bpp"), "minimal.bpp");
    const result = convertAndVerify(source, "bpp");
    expect(result.verified).toBe(true);
    expect(result.contents).toContain("TYPE=BPP");
    expect(result.contents).toContain("@ ROUT");
    expect(result.reparsed && documentsGeometryEqual(result.reparsed, expected)).toBe(true);
  });

  it("refuses conversion when an operation cannot be represented", async () => {
    const source = parseCix(await fixture("minimal.cix"), "minimal.cix");
    source.operations.push({ id: "unsupported", kind: "unknown", sourceType: "WAIT", raw: {} });
    const result = convertDocument(source, "bpp");
    expect(result.contents).toBeUndefined();
    expect(result.diagnostics.map(item => item.code)).toContain("CONVERSION_OPERATION_UNSUPPORTED");
  });

  it("fails closed for preview-only advanced operations", async () => {
    const source = parseCix(await fixture("minimal.cix"), "advanced.cix");
    source.operations.push({ id: "pocket", kind: "pocket", sourceType: "PKT1", path: [{ x: 10, y: 10 }, { x: 20, y: 20 }], support: { stage: "validated", geometry: "exact", conversion: false }, raw: {} });
    const result = convertDocument(source, "bpp");
    expect(result.contents).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "CONVERSION_OPERATION_UNSUPPORTED", location: { record: "pocket" } }));
  });

  it("refuses conversion when the parser left an unresolved source record", async () => {
    const source = parseBpp(await fixture("minimal.bpp"), "minimal.bpp");
    source.diagnostics.push({ severity: "warning", code: "BPP_RECORD_MALFORMED", message: "test record" });
    const result = convertDocument(source, "cix");
    expect(result.contents).toBeUndefined();
    expect(result.diagnostics.map(item => item.code)).toContain("CONVERSION_SOURCE_UNRESOLVED");
  });

  it("survives a complete BPP to CIX to BPP cycle", async () => {
    const source = parseBpp(await fixture("minimal.bpp"), "minimal.bpp");
    const toCix = convertAndVerify(source, "cix");
    expect(toCix.verified).toBe(true);
    const backToBpp = convertAndVerify(toCix.reparsed!, "bpp");
    expect(backToBpp.verified).toBe(true);
    expect(backToBpp.reparsed && documentsGeometryEqual(backToBpp.reparsed, source)).toBe(true);
  });

  it("preserves BPP WAIT as inert CIX metadata and restores it", async () => {
    const source = parseBpp(`${await fixture("minimal.bpp")}\n@ WAIT, "", "", 42, "", 0 : 1, 5, 0, 0, 1\n`, "wait.bpp");
    const toCix = convertAndVerify(source, "cix");
    expect(toCix.verified).toBe(true);
    expect(toCix.contents).toContain("; OPENCNC-PRESERVED-WAIT");
    expect(toCix.diagnostics.map(item => item.code)).toContain("CONVERSION_WAIT_PRESERVED_AS_METADATA");
    expect(toCix.reparsed?.operations).toContainEqual(expect.objectContaining({ id: "42", kind: "unknown", sourceType: "WAIT" }));
    const backToBpp = convertAndVerify(toCix.reparsed!, "bpp");
    expect(backToBpp.verified).toBe(true);
    expect(backToBpp.contents).toMatch(/@ WAIT, "", "", \d+, "", 0 : 1, 5, 0, 0, 1/);
  });

  it("treats split and repeated drills as the same expanded geometry", async () => {
    const repeated = parseCix(await fixture("minimal.cix"), "minimal.cix");
    const split = structuredClone(repeated);
    const drill = split.operations.find(operation => operation.kind === "drill")!;
    const { repeat: _repeat, ...singleDrill } = drill;
    const points = [20, 70, 120, 170].map(x => ({ x, y: 30, z: 0 }));
    split.operations = [
      ...points.map((position, index) => ({ ...singleDrill, id: `split-${index + 1}`, position })),
      ...split.operations.filter(operation => operation.kind !== "drill")
    ];
    expect(documentsGeometryEqual(repeated, split)).toBe(true);
    const comparison = compareDocuments(repeated, split);
    expect(comparison.semanticMatch).toBe(true);
    expect(comparison.equivalent).toBeGreaterThan(0);
  });

  it("matches reordered operations and small numeric drift without relying on IDs", async () => {
    const source = parseCix(await fixture("minimal.cix"), "minimal.cix");
    const reordered = structuredClone(source);
    reordered.operations.reverse();
    reordered.operations.forEach((operation, index) => { operation.id = `renamed-${index}`; });
    const drill = reordered.operations.find(operation => operation.kind === "drill")!;
    drill.position!.x += 0.0005;
    const comparison = compareDocuments(source, reordered, 0.001);
    expect(comparison.geometryMatch).toBe(true);
    expect(comparison.semanticMatch).toBe(true);
    expect(comparison.equivalent).toBeGreaterThan(0);
  });

  it("flags reversed routes as machine-significant even when their footprint matches", async () => {
    const source = parseCix(await fixture("minimal.cix"), "minimal.cix");
    const reversed = structuredClone(source);
    const route = reversed.operations.find(operation => operation.kind === "route")!;
    route.path!.reverse();
    const comparison = compareDocuments(source, reversed);
    expect(comparison.geometryMatch).toBe(false);
    expect(comparison.semanticMatch).toBe(false);
    expect(comparison.operationMatches.find(match => match.kind === "route")?.fields).toContainEqual(expect.objectContaining({ name: "pathDirection", status: "changed" }));
  });

  it("pairs changed drill dialects for review without accepting them as semantic matches", async () => {
    const source = parseCix(await fixture("minimal.cix"), "minimal.cix");
    const changedDialect = structuredClone(source);
    changedDialect.operations.find(operation => operation.kind === "drill")!.sourceType = "BV";
    const comparison = compareDocuments(source, changedDialect);
    expect(comparison.geometryMatch).toBe(true);
    expect(comparison.semanticMatch).toBe(false);
    expect(comparison.operationMatches.find(match => match.kind === "drill")?.fields).toContainEqual(expect.objectContaining({ name: "sourceType", status: "changed" }));
  });

  it("creates a field-level source, target and reverse fidelity diff", async () => {
    const source = parseBpp(await fixture("minimal.bpp"), "minimal.bpp");
    const target = convertAndVerify(source, "cix");
    const reverse = convertAndVerify(target.reparsed!, "bpp");
    const diff = createConversionDiff(source, target.reparsed, reverse.reparsed, target.diagnostics);
    expect(diff.verified).toBe(true);
    expect(diff.entries).toContainEqual(expect.objectContaining({ path: "panel.width", status: "exact", sourceValue: 800, targetValue: 800, reverseValue: 800 }));
    expect(diff.entries).toContainEqual(expect.objectContaining({ status: "normalized" }));
    expect(diff.entries).toContainEqual(expect.objectContaining({ status: "machine-dependent" }));
    expect(diff.counts.changed).toBe(0);
  });

  it("emits complete BPP operation records and carries mapped process parameters", async () => {
    const source = parseCix((await fixture("minimal.cix"))
      .replace(
        "\tPARAM,NAME=LAY,VALUE=\"Synthetic drill row\"",
        "\tPARAM,NAME=AZ,VALUE=90\n\tPARAM,NAME=AR,VALUE=180\n\tPARAM,NAME=CKA,VALUE=azrABS\n\tPARAM,NAME=TTP,VALUE=7\n\tPARAM,NAME=TCL,VALUE=2\n\tPARAM,NAME=LAY,VALUE=\"Synthetic drill row\""
      )
      .replace(
        "\tPARAM,NAME=LAY,VALUE=\"Synthetic route\"",
        "\tPARAM,NAME=TNM,VALUE=\"DIA8\"\n\tPARAM,NAME=TTP,VALUE=103\n\tPARAM,NAME=TCL,VALUE=1\n\tPARAM,NAME=CRC,VALUE=2\n\tPARAM,NAME=TIN,VALUE=3\n\tPARAM,NAME=AIN,VALUE=4\n\tPARAM,NAME=TOU,VALUE=5\n\tPARAM,NAME=AOU,VALUE=6\n\tPARAM,NAME=LAY,VALUE=\"Synthetic route\""
      ), "technology.cix");
    const result = convertAndVerify(source, "bpp");
    expect(result.verified).toBe(true);
    const drill = result.reparsed?.operations.find(operation => operation.kind === "drill");
    const route = result.reparsed?.operations.find(operation => operation.kind === "route");
    expect(drill?.raw.params).toHaveLength(50);
    expect(route?.raw.params).toHaveLength(98);
    expect(drill?.raw.params).toMatchObject({ 17: "90", 18: "180", 20: "1", 21: "7", 22: "2" });
    expect(route?.raw.params).toMatchObject({ 47: "DIA8", 48: "103", 49: "1", 50: "2", 51: "3", 52: "4", 53: "5", 54: "6" });
  });

  it("emits the complete BiesseWorks v150 Windows envelope", async () => {
    const source = parseCix(await fixture("minimal.cix"), "minimal.cix");
    const result = convertAndVerify(source, "bpp");
    expect(result.verified).toBe(true);
    expect(result.contents).toBeDefined();
    const contents = result.contents!;
    expect(validateBiesseBppV150(contents)).toEqual([]);
    expect(contents).toContain("[DESCRIPTION]\r\n|\r\n\r\n[VARIABLES]");
    expect(contents).toContain('PAN=PUTLST|""||0|');
    expect(contents).toContain("[VBSCRIPT]\r\nOption Explicit");
    expect(contents).toContain("Call ProgBuilder.SetPanel(");
    expect(contents).toContain("BSW_OBJ_BORING.Add_Ver_000");
    expect(contents).toContain("BSW_OBJ_ROUTING.Add_Ver_000");
    expect(contents).toContain("ProgBuilder.AddLineEP");
    expect(contents.endsWith("[TOOLING]\r\n\r\n")).toBe(true);
    expect(contents.replace(/\r\n/g, "")).not.toContain("\n");
    const programRecords = contents.split("[VBSCRIPT]")[0]!.match(/^\s*@.+$/gm) ?? [];
    expect(programRecords).toHaveLength(5);
    expect(programRecords.every(line => /^\s*@\s*[A-Z_]+, "", "", \d+, "", 0 :/.test(line))).toBe(true);
    expect(programRecords[0]).toContain('"P1000"');
    expect(programRecords[1]).toContain('@ ROUT');
    expect(programRecords[1]).toContain('"P1001"');
    expect(programRecords.find(line => line.includes("LINE_EP"))?.split(":")[1]?.split(",")).toHaveLength(9);
  });

  it("reproduces and semantically normalizes the BiesseWorks inside-panel route entry bore", async () => {
    const source = parseCix((await fixture("minimal.cix"))
      .replace("PARAM,NAME=DP,VALUE=6", "PARAM,NAME=DP,VALUE=9.5")
      .replace("PARAM,NAME=DIA,VALUE=8", "PARAM,NAME=DIA,VALUE=10\n\tPARAM,NAME=TNM,VALUE=\"DIA10\"\n\tPARAM,NAME=TTP,VALUE=103\n\tPARAM,NAME=TCL,VALUE=1\n\tPARAM,NAME=CRC,VALUE=0"), "observed-entry.cix");
    const toBpp = convertAndVerify(source, "bpp");
    expect(toBpp.verified).toBe(true);
    const entry = toBpp.reparsed?.operations.find(operation => operation.raw.biesseDerivedRouteEntry === true);
    const route = toBpp.reparsed?.operations.find(operation => operation.kind === "route");
    expect(entry).toMatchObject({ kind: "drill", sourceType: "BV", label: "BG", face: route?.face, position: route?.path?.[0], depth: route?.diameter, diameter: route?.diameter });
    expect(toBpp.diagnostics.map(item => item.code)).not.toContain("CONVERSION_OPERATION_UNSUPPORTED");
    expect(compareDocuments(source, toBpp.reparsed!).semanticMatch).toBe(true);

    const backToCix = convertAndVerify(toBpp.reparsed!, "cix");
    expect(backToCix.verified).toBe(true);
    expect(backToCix.contents?.match(/\bNAME=BV\b/g) ?? []).toHaveLength(0);
    expect(backToCix.reparsed && documentsGeometryEqual(backToCix.reparsed, source)).toBe(true);
  });

  it("converts the verified KILINCSM counter-clockwise ARC_EPCE profile in both directions", () => {
    const source = parseCix(`BEGIN MAINDATA\nLPX=2400\nLPY=600\nLPZ=36\nORLST="5"\nEND MAINDATA\nBEGIN MACRO\nNAME=ROUT\nPARAM,NAME=SIDE,VALUE=0\nPARAM,NAME=Z,VALUE=0\nPARAM,NAME=DP,VALUE=51\nPARAM,NAME=ZS,VALUE=0\nPARAM,NAME=ZE,VALUE=0\nPARAM,NAME=THR,VALUE=NO\nPARAM,NAME=TNM,VALUE="KILINCSM"\nPARAM,NAME=TTP,VALUE=103\nPARAM,NAME=TCL,VALUE=1\nPARAM,NAME=CRC,VALUE=1\nPARAM,NAME=LAY,VALUE="Surface"\nEND MACRO\nBEGIN MACRO\nNAME=START_POINT\nPARAM,NAME=X,VALUE=1362.5\nPARAM,NAME=Y,VALUE=539.5\nPARAM,NAME=Z,VALUE=0\nEND MACRO\nBEGIN MACRO\nNAME=LINE_EP\nPARAM,NAME=XE,VALUE=1637.5\nPARAM,NAME=YE,VALUE=539.5\nPARAM,NAME=ZS,VALUE=0\nPARAM,NAME=ZE,VALUE=0\nEND MACRO\nBEGIN MACRO\nNAME=ARC_EPCE\nPARAM,NAME=XE,VALUE=1712.5\nPARAM,NAME=YE,VALUE=464.5\nPARAM,NAME=XC,VALUE=1637.5\nPARAM,NAME=YC,VALUE=464.5\nPARAM,NAME=DIR,VALUE=dirCCW\nPARAM,NAME=ZS,VALUE=0\nPARAM,NAME=ZE,VALUE=0\nEND MACRO\nBEGIN MACRO\nNAME=ENDPATH\nEND MACRO`, "advanced-route.cix");
    expect(source.operations[0]).toMatchObject({ diameter: 18, segments: [{ kind: "line" }, { kind: "arc", clockwise: false }] });

    const toBpp = convertAndVerify(source, "bpp");
    expect(toBpp.verified).toBe(true);
    expect(validateBiesseBppV150(toBpp.contents!)).toEqual([]);
    expect(toBpp.contents).toMatch(/@ ARC_EPCE, "", "", \d+, "", 0 : 1712\.5, 464\.5, 1637\.5, 464\.5, 2, 0, 0, 0, 0, 0, 0/);
    expect(toBpp.contents).toContain("ProgBuilder.AddArcEPCE(76");
    expect(toBpp.contents).not.toContain("@ BV");

    const backToCix = convertAndVerify(toBpp.reparsed!, "cix");
    expect(backToCix.verified).toBe(true);
    expect(backToCix.contents).toContain("NAME=ARC_EPCE");
    expect(backToCix.contents).toContain("PARAM,NAME=DIR,VALUE=dirCCW");
    expect(compareDocuments(source, backToCix.reparsed!).semanticMatch).toBe(true);
  });

  it("keeps unverified clockwise arcs fail-closed", () => {
    const source = parseCix(`BEGIN MAINDATA\nLPX=500\nLPY=300\nLPZ=18\nEND MAINDATA\nBEGIN MACRO\nNAME=ROUT\nPARAM,NAME=SIDE,VALUE=0\nPARAM,NAME=DP,VALUE=6\nPARAM,NAME=DIA,VALUE=8\nEND MACRO\nBEGIN MACRO\nNAME=START_POINT\nPARAM,NAME=X,VALUE=50\nPARAM,NAME=Y,VALUE=100\nEND MACRO\nBEGIN MACRO\nNAME=ARC_EPCE\nPARAM,NAME=XE,VALUE=150\nPARAM,NAME=YE,VALUE=100\nPARAM,NAME=XC,VALUE=100\nPARAM,NAME=YC,VALUE=100\nPARAM,NAME=DIR,VALUE=dirCW\nEND MACRO\nBEGIN MACRO\nNAME=ENDPATH\nEND MACRO`, "clockwise.cix");
    const result = convertDocument(source, "bpp");
    expect(result.contents).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "CONVERSION_ARC_PROFILE_UNSUPPORTED" }));
  });

  it("treats line-versus-arc segment changes as a geometry mismatch", () => {
    const arc = parseCix(`BEGIN MAINDATA\nLPX=500\nLPY=300\nLPZ=18\nEND MAINDATA\nBEGIN MACRO\nNAME=ROUT\nPARAM,NAME=SIDE,VALUE=0\nPARAM,NAME=DP,VALUE=6\nPARAM,NAME=DIA,VALUE=8\nEND MACRO\nBEGIN MACRO\nNAME=START_POINT\nPARAM,NAME=X,VALUE=50\nPARAM,NAME=Y,VALUE=100\nEND MACRO\nBEGIN MACRO\nNAME=ARC_EPCE\nPARAM,NAME=XE,VALUE=150\nPARAM,NAME=YE,VALUE=100\nPARAM,NAME=XC,VALUE=100\nPARAM,NAME=YC,VALUE=100\nPARAM,NAME=DIR,VALUE=dirCCW\nEND MACRO\nBEGIN MACRO\nNAME=ENDPATH\nEND MACRO`, "arc.cix");
    const flattened = structuredClone(arc);
    flattened.operations[0]!.segments = [{ kind: "line", start: arc.operations[0]!.path![0]!, end: arc.operations[0]!.path![1]! }];
    const comparison = compareDocuments(arc, flattened);
    expect(comparison.geometryMatch).toBe(false);
    expect(comparison.operationMatches[0]?.fields).toContainEqual(expect.objectContaining({ name: "segments", status: "changed" }));
  });

  it("uses BiesseWorks three-decimal normalization without failing semantic verification", () => {
    const source = parseCix(`BEGIN MAINDATA\nLPX=1923\nLPY=443.5\nLPZ=18\nORLST="5"\nEND MAINDATA\nBEGIN MACRO\nNAME=BG\nPARAM,NAME=SIDE,VALUE=0\nPARAM,NAME=X,VALUE=1226.1667\nPARAM,NAME=Y,VALUE=421.5\nPARAM,NAME=Z,VALUE=0\nPARAM,NAME=DP,VALUE=5\nPARAM,NAME=DIA,VALUE=3\nPARAM,NAME=RTY,VALUE=rpNO\nPARAM,NAME=LAY,VALUE="Furat"\nEND MACRO`, "biesse-rounding.cix");
    const result = convertAndVerify(source, "bpp");
    expect(result.verified).toBe(true);
    expect(result.contents).toContain(", 1226.167, 421.5, 0, 5, 3,");
  });

  it("rejects the former Linux-style interchange draft at the vendor compatibility gate", async () => {
    const source = parseCix(await fixture("minimal.cix"), "minimal.cix");
    const valid = convertDocument(source, "bpp").contents!;
    const legacy = valid
      .replace(/\r\n/g, "\n")
      .replace(/@ BG, "", "", \d+, "", 0 :/, '@ BG, "", "", "cix-1", "", 0 :')
      .replace(/\n\[VBSCRIPT\][\s\S]*$/, "\n");
    const codes = validateBiesseBppV150(legacy).map(item => item.code);
    expect(codes).toContain("BPP_VENDOR_LINE_ENDINGS_INVALID");
    expect(codes).toContain("BPP_VENDOR_OBJECT_ID_INVALID");
    expect(codes).toContain("BPP_VENDOR_SECTION_MISSING");
    expect(codes).toContain("BPP_VENDOR_VBSCRIPT_INCOMPLETE");
  });

  it("emits the observed CIX identity, orientation and VB scaffold", async () => {
    const source = parseBpp(await fixture("minimal.bpp"), "minimal.bpp");
    const result = convertAndVerify(source, "cix");
    expect(result.verified).toBe(true);
    expect(result.contents).toContain("BEGIN ID CID3\r\n\tREL= 5.0\r\nEND ID");
    expect(result.contents).toContain('\tORLST="5"');
    expect(result.contents).toContain('BEGIN VB\r\n\tVBLINE=""\r\nEND VB');
  });

  it("bulk converts every input and reports reverse semantic and geometry verification", async () => {
    const bpp = parseBpp(await fixture("minimal.bpp"), "minimal.bpp");
    const cix = parseCix(await fixture("minimal.cix"), "minimal.cix");
    const result = bulkConvertAndVerify([{ name: "minimal.bpp", document: bpp }, { name: "minimal.cix", document: cix }]);
    expect(result.report.summary).toMatchObject({
      total: 2,
      converted: 2,
      failed: 0,
      reverseVerified: 2,
      supportedSemanticRoundTrips: 2,
      expandedGeometryRoundTrips: 2
    });
    expect(result.outputs.map(output => output.outputName)).toEqual(["minimal.cix", "minimal.bpp"]);
    expect(result.report.fidelity.sourceText).toBe("normalized-not-byte-identical");
    expect(result.report.fidelity.machineBehavior).toBe("not-verified-requires-vendor-simulation");
    expect(result.outputs.every(output => output.diff.verified)).toBe(true);
    expect(result.report.items.every(item => "targetDocument" in item === false && "reverseDocument" in item === false)).toBe(true);
  });

  it("merges one unambiguous f0/f1 CIX pair into one verified BPP with the observed material-flip WAIT", async () => {
    const sourceText = await fixture("minimal.cix");
    const face0 = parseCix(sourceText, "Cabinet_top_f0.cix");
    const face1 = parseCix(sourceText.replace("PARAM,NAME=X,VALUE=20", "PARAM,NAME=X,VALUE=25"), "Cabinet_top_f1.cix");
    const result = bulkConvertAndVerify([
      { name: "Cabinet_top_f1.cix", document: face1 },
      { name: "Cabinet_top_f0.cix", document: face0 }
    ]);

    expect(result.report.summary).toMatchObject({ sourceFiles: 2, total: 1, twoSidedPairs: 1, converted: 1 });
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({
      name: "Cabinet_top_f1.cix",
      sourceNames: ["Cabinet_top_f0.cix", "Cabinet_top_f1.cix"],
      outputName: "Cabinet_top_f1.bpp",
      status: "converted",
      verified: true,
      reverseVerified: true
    });
    expect(result.outputs[0]!.contents).toMatch(/@ WAIT, "", "", \d+, "", 0 : 1, 5, 0, 0, 1/);
    expect(result.outputs[0]!.contents).toMatch(/Call ProgBuilder\.AddWait\(0, \d+, ""    , stTR, 5, 0, mrrNO, YES\)/);
    const operationTypes = result.outputs[0]!.targetDocument!.operations.filter(operation => operation.raw.biesseDerivedRouteEntry !== true).map(operation => operation.sourceType);
    const waitIndex = operationTypes.indexOf("WAIT");
    expect(waitIndex).toBe(face0.operations.length);
    expect(operationTypes.slice(waitIndex + 1)).toHaveLength(face1.operations.length);
    expect(result.outputs[0]!.diagnostics).toContainEqual(expect.objectContaining({ code: "CIX_TWO_SIDED_PAIR_MERGED" }));
  });

  it("does not merge filename pairs when their panel setup differs", async () => {
    const sourceText = await fixture("minimal.cix");
    const face0 = parseCix(sourceText, "Panel_f0.cix");
    const face1 = parseCix(sourceText, "Panel_f1.cix");
    face1.panel.thickness = (face1.panel.thickness ?? 0) + 1;
    const result = bulkConvertAndVerify([{ name: "Panel_f0.cix", document: face0 }, { name: "Panel_f1.cix", document: face1 }]);
    expect(result.report.summary).toMatchObject({ sourceFiles: 2, total: 2, twoSidedPairs: 0 });
    expect(result.outputs.every(item => item.sourceNames.length === 1)).toBe(true);
    expect(result.outputs.every(item => item.diagnostics.some(value => value.code === "CIX_TWO_SIDED_PAIR_PANEL_MISMATCH"))).toBe(true);
  });

  it("leaves duplicate face candidates separate instead of guessing a two-sided pair", async () => {
    const sourceText = await fixture("minimal.cix");
    const inputs = ["Panel_f0.cix", "Panel_f1.cix", "Panel_f1-1.cix"].map(name => ({ name, document: parseCix(sourceText, name) }));
    const result = bulkConvertAndVerify(inputs);
    expect(result.report.summary).toMatchObject({ sourceFiles: 3, total: 3, twoSidedPairs: 0 });
    expect(result.outputs.every(item => item.diagnostics.some(value => value.code === "CIX_TWO_SIDED_PAIR_AMBIGUOUS"))).toBe(true);
  });
});
