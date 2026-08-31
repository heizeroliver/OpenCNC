# Guarded BPP/CIX conversion

OpenCNC converts between the BPP v150 and CIX text-macro constructs represented by the current intermediate model. Conversion is semantic rather than byte-for-byte: source comments, runtime object identifiers, and installation-specific metadata are normalized.

## BiesseWorks Windows output profile

BiesseWorks is a Windows application, so generated BPP is validated as a Windows-oriented file rather than as a generic Unix text export. The current observed v150 writer emits:

- Windows CRLF line endings and an ASCII-only byte repertoire;
- the complete `[HEADER]`, `[DESCRIPTION]`, `[VARIABLES]`, `[PROGRAM]`, `[VBSCRIPT]`, `[MACRODATA]`, `[TDCODES]`, `[PCF]`, and `[TOOLING]` envelope;
- unquoted positive numeric runtime object IDs, logical `P1000…` program IDs, complete 50-field `BG`/`BV` records, 98-field `ROUT` records, and matching VBScript calls;
- BiesseWorks' generated `BV` entry bore for the exact observed `DIA10`/9.5 mm-depth inside-panel route profile, while preserving other routes without guessed scaffolding;
- verified counter-clockwise center/end arcs as 11-field `ARC_EPCE` records with matching `ProgBuilder.AddArcEPCE` calls; and
- three-decimal drilling normalization plus up-to-seven-decimal route coordinates, matching the measured BiesseWorks exports.

The generated route-entry bore is treated as exporter scaffolding during parsing and verification. It is regenerated from the route and is not exposed as a second user-authored machining operation during BPP→CIX conversion. Non-ASCII BPP output is currently rejected because a real BiesseWorks corpus has not yet established which Windows code page should be used; silently writing UTF-8 would be unsafe.

## Verification contract

Before OpenCNC writes or downloads a converted file, it:

1. rejects unresolved parser records, source validation errors, incomplete panel dimensions, unsupported units, unknown operations other than the explicitly handled `WAIT` record, unsupported operation dialects, incomplete routes, and unmapped repetition forms;
2. serializes the supported document to the other format;
3. parses the generated file with the target parser;
4. validates the reparsed document; and
5. compares panel dimensions and all supported operation semantics, including type, label, face, coordinates, Z values, depth, diameter, repetition, complete route paths, observed drill orientation fields, and observed tool/routing parameters;
6. converts the target back to the source format and repeats the semantic and expanded-geometry comparisons; and
7. produces a field-level fidelity diff for the source, target, and reverse-converted document.

Any error or semantic mismatch prevents output. The interface and reports also warn that the result has not been validated for direct machine operation; the machine file itself stays within the observed vendor layout.

### BPP `WAIT`

The observed BPP `WAIT` record has no counterpart in its matching vendor-exported CIX file. OpenCNC therefore preserves its identifier and raw parameters in an inert `OPENCNC-PRESERVED-WAIT` CIX comment. This makes an OpenCNC CIX→BPP round trip reversible, but the wait does not execute in CIX. The viewer and CLI surface that behavioral difference explicitly.

The paired Tetolap corpus establishes the opposite, two-file workflow as well. When a batch contains exactly one `<base>_f0.cix` and one `<base>_f1.cix` with the same panel dimensions, unit, and orientation, OpenCNC produces one `<base>_f1.bpp`. It emits every f0 operation first, then the observed operator material-reposition boundary `WAIT(1, 5, 0, 0, 1)`, followed by every f1 operation. Both CIX files use `SIDE=0` in their own local setups, so OpenCNC does not rewrite their coordinates or operation faces. The f0/f1 filename suffix is the pairing evidence.

Pairing is fail-closed: missing counterparts remain independent, while duplicate face candidates or differing panel setups are not merged and receive a warning. An optional browser-style duplicate suffix such as `_f1-1.cix` is recognized, but more than one candidate for either face is still considered ambiguous. Reports and folder manifests retain both source names behind the single BPP output.

## Commands

The target format is inferred from the input extension:

```sh
pnpm opencnc convert part.bpp --out part.cix
pnpm opencnc convert part.cix --out part.bpp
```

An explicit target can be supplied with `--to bpp` or `--to cix`.

Convert every top-level `.bpp` and `.cix` file in a directory to its opposite format:

```sh
pnpm opencnc bulk-convert path/to/input --out-dir path/to/new-output
```

The output directory must differ from the input directory and existing outputs are never overwritten. Successful files are written alongside `opencnc-conversion-report.json`; production QA sheets are written under `qa/`. One bad file does not prevent independent files from being assessed, but the command exits with status 2 when any item fails. In the workshop, bulk conversion first opens a preflight: successful files can be included or excluded, output names can use one of three templates or be edited directly, case-insensitive name conflicts block download, and the ZIP name remains editable. QA sheets are enabled by default and can be disabled explicitly. The final ZIP contains the selected converted files, corresponding report rows, and one PDF sheet per selected file when QA is enabled.

Generate the same signed-off inspection sheet for a single CLI conversion:

```sh
pnpm opencnc convert part.bpp --out part.cix --qa-pdf part-qa.pdf
```

The PDF records the workpiece preview, direction, fidelity grade, warnings, file checksums, deterministic local report ID and QR, plus vendor-simulation and operator sign-off fields. It does not approve machine execution.

## Regression Corpus Lab

Run the complete local safety net against a directory:

```sh
pnpm opencnc corpus-lab input-corpus --out corpus-report.json --export-dir anonymized-corpus
```

The lab anonymizes filenames, comments, labels, embedded script text, and known customer/job fields; re-parses sanitized files to prove dimensions and expanded geometry are unchanged; runs parsing, rendering, guarded conversion, reverse conversion, semantic and geometry comparison; tests UTF-8 BOM, CRLF, and trailing-whitespace variants; detects novel operation signatures; and emits reduced diagnostic fixtures for failures. The public report omits source text and original filenames. The browser also retains the previous local corpus run in IndexedDB and reports improvements or regressions.

## Local project sessions

The workshop's Local Projects panel stores exact loaded source files, ZIP naming, the latest conversion report, operator notes, simulation state, and the last previous/current comparison in IndexedDB. Opening a project restores the full local workspace. No cloud account or upload is used.

An optional local machine profile can be supplied to CLI inspection, validation, or bulk conversion:

```sh
pnpm opencnc validate part.cix --machine-profile machine-profile.json
pnpm opencnc bulk-convert input --out-dir output --machine-profile machine-profile.json
```

The browser editor stores its profile only in local browser storage. These checks cover configured travel, faces, depth limits, tool diameters, drill-bank restrictions, and spindle ranges when those fields exist. They are advisory and never turn the OpenCNC report into a collision-safety or machine-readiness claim.

## Dialect and advanced-operation gate

Each report records the detected source profile, confidence, reasons, warnings, and selected target profile. Detection suggests a compatible profile from file evidence; it does not silently turn an ambiguous family into a certified exporter profile.

Advanced CIX geometry can be structured, rendered, and validated before serialization support exists. One paired-corpus subset has now reached `verified-conversion`: counter-clockwise `ARC_EPCE` segments expressed by end point plus center point. The observed mapping is CIX `XE, YE, XC, YC, DIR=dirCCW, ZS, ZE` to BPP `XE, YE, XC, YC, 2, ZS, ZE, 0, 0, 0, 0`; the reverse mapping uses the same fields. The paired Tetolap exports also establish the local tool-library resolution `TNM="KILINCSM" → DIA=18 mm`, which is applied with an explicit informational diagnostic when CIX omits `DIA`.

Clockwise `ARC_EPCE`, `ARC_EPRA`, `ARC_IPEP`, and preview-only `GEO`, `ROUTG`, pocket, cut, saw, or groove operations remain blocked. BPP positional records are decoded only where paired evidence establishes the parameter positions. A route endpoint list is no longer sufficient for verification: segment type, start/end, center or via point, radius, and traversal direction are compared as machine-significant semantics. Unsupported shapes fail closed instead of being flattened to straight lines.

## What “verified” means

The report intentionally separates four claims:

- **Supported semantics:** reparsing and reverse conversion reproduce the normalized OpenCNC fields.
- **Expanded geometry:** repeated drills are expanded before comparison, so compact and explicit geometry are checked consistently.
- **Source text:** not preserved byte-for-byte. Layout, comments, VB, and source-only metadata are normalized.
- **Machine behavior:** not verified. Tool libraries, machine configuration, workholding, postprocessor behavior, and collision safety remain outside OpenCNC.

The Conversion Diff Center renders these claims at field level with `exact`, `equivalent`, `normalized`, `metadata`, `changed`, `unsupported`, and `machine-dependent` statuses. Single-file conversion opens this review before download; bulk preflight exposes the same detail for every row.

Document matching is independent of operation order and generated identifiers. Drills are expanded to individual occurrences before matching, so one repeated drill can match many explicit drills. Numeric geometry is compared with a default 0.001 mm review tolerance. A route with the same points in reverse order is paired for explanation but is not accepted as semantically or geometrically equivalent because traversal direction can alter machining behavior.

The real export corpus also showed that same-named BPP and CIX files can differ before conversion. Vendor-pair equality is therefore reported separately from OpenCNC round-trip fidelity.

## Why the implementation stays in TypeScript

Bulk filesystem access is available directly in Node.js, while the same converter can run locally in the browser. The research found no public Biesse field specification or Python SDK that would add format knowledge. Rewriting in Python would duplicate the parser/serializer and create a drift risk without improving conversion quality. A future authoritative vendor SDK can be integrated behind the same intermediate model regardless of its implementation language.

## Evidence and limits

Automated tests exercise both directions, the full BPP Windows envelope, complete drill/route record shapes, the verified counter-clockwise arc envelope, arc-versus-line mismatch rejection, inside-panel route-entry generation and normalization, process-parameter transport, inert `WAIT` restoration, rejection paths, order-independent and tolerance-aware matching, split/repeated drills, reversed routes, field-level diffs, PDF generation, corpus anonymization, linked identifier preservation, robustness mutations, local history, bulk preflight naming, conflict detection, reporting, and ZIP creation. A local end-to-end run assessed the 18 original production exports plus one duplicated BPP/CIX pair currently present in Downloads (20 files total): 20/20 first-hop conversions, 20/20 reverse conversions, 20/20 supported-semantic round trips, 20/20 expanded-geometry round trips, and 20/20 Diff Center verifications passed with no changed or unsupported fields. One `WAIT` was preserved inertly.

The Regression Corpus Lab independently re-ran those 20 local exports: 20/20 parsed, 20/20 rendered, 20/20 converted and reverse-verified, 20/20 retained expanded machining geometry after anonymization, and 60/60 BOM/line-ending/trailing-whitespace variants passed. It applied 741 privacy redactions, found one novel operation signature for review, and needed no reduced failure fixture. The exported report and filenames contained none of the original job names checked in the privacy audit.

The corrected writer was additionally compared against four exact CIX→BPP pairs produced by BiesseWorks, including drilling-only files, an outside-panel route lead-in, and an inside-panel route. After normalizing only BiesseWorks runtime object IDs and the installation-specific `PUTLST` setting, all four generated files matched the BiesseWorks files line-for-line.

The advanced Tetolap attachment set adds two independently generated CIX modules and their combined BiesseWorks BPP reference. Both CIX→BPP modules passed parse, target validation, reverse conversion, supported-semantic comparison, and expanded-geometry comparison. After normalizing only runtime object IDs, the f0 and f1 outputs matched all 48 + 44 BPP program records and all 48 + 44 corresponding VBScript operation calls exactly. OpenCNC's merged output also matches all 93/93 combined BPP program records and all 93/93 VBScript operation calls, including the exact `WAIT` boundary, after normalizing only runtime object IDs. The combined BPP→CIX direction also passed; its single `WAIT` is retained as inert OpenCNC metadata because the paired CIX exports contain no executable equivalent.

This is strong corpus evidence, not a universal format proof. Three independently exported same-name vendor pairs already differ in their operation sets. Public Biesse material identifies CIX as a native part-program format and describes vendor simulation/collision checking; it does not provide a public field-level specification. Every converted file must therefore be opened and simulated in the appropriate vendor environment before any machine use.

See Biesse's discussion of native CIX import and collision simulation: https://biesse.com/it/it/novita/il-software-di-simulazione-della-replica-digitale-assicura-vantaggi-concreti-agli-utenti-cnc/
