# Architecture

The inspection data flow is intentionally one-way and read-only:

`BPP / CIX input → conservative parser → OpenCNC IR → validation → JSON or SVG`

Guarded format conversion adds a verified return path:

`source input → parser → OpenCNC IR → strict target serializer → target parser → semantic equality check`

Bulk conversion applies the same gate per file, then converts the target back to the source format and compares both normalized semantics and expanded geometry. Its shared comparison engine ignores generated identifiers and source operation order, expands repeated drilling, uses an explicit numeric tolerance, and retains machine-significant route direction. It also produces field-level source/target/reverse fidelity entries. The CLI writes successful outputs, PDF QA sheets, and a JSON report; the browser presents a selectable naming/conflict preflight before packaging the chosen artifacts into a local ZIP.

Each QA sheet is generated from the structured source document plus the verified conversion item. It includes a vector workpiece preview, direction, fidelity grade, warnings, source and target SHA-256 values, a deterministic local report identifier, QR code, simulation approval, and operator sign-off. It remains an inspection artifact, never a machine program.

The Regression Corpus Lab is a separate local test path:

`source corpus → anonymizer → sanitized reparse/geometry comparison → parser + renderer + converter + reverse converter + input mutations → private report + reduced fixtures`

The export uses anonymous filenames and removes comments, labels, scripts, and known customer fields. It re-parses every sanitized file and requires panel dimensions and expanded geometry to remain equal. Reports use checksums rather than original filenames, detect one-off operation signatures, and compare quality against the previous local engine run.

Browser project sessions are stored in IndexedDB. They retain the exact local source text needed to restore a project, along with archive naming, conversion report, operator notes, simulation state, and a previous/current comparison snapshot. No session or corpus data requires a network service.

Folder automation has two adapters over the same converter and manifest contract:

- The browser adapter receives a user-approved `FileSystemDirectoryHandle`, enumerates immediate project folders, polls every ten seconds, and writes through the File System Access API. Handles are stored in IndexedDB, but permission may need to be re-authorized after a browser restart.
- The Node adapter enumerates the same layout directly and can remain active without a browser. It uses the existing TypeScript parser/converter; Python is not part of the quality or filesystem boundary.

Both adapters require an export fingerprint to remain unchanged across two watcher scans before automatic conversion. Every project writes into its own `BPP` directory. `opencnc-sync-manifest.json` records source size, modification time, source checksum, output checksum, and all four verification claims. An existing BPP is updated only when its current checksum equals the previous manifest checksum. Unknown or manually edited outputs block the entire project write. Removed-source outputs are reported as orphans and preserved rather than deleted.

The serializer refuses output when an operation cannot be represented by the currently mapped subset. A successful equality check proves that OpenCNC can recover the same supported panel and operation semantics from its generated file; it does not prove machine compatibility or collision safety.

Dialect detection sits beside parsing, not inside the machine-safety claim. It uses header/version, block structure, exporter hints, and observed record shapes to suggest an explicit profile with a confidence label. Conversion reports retain both the detected source evidence and the selected target profile.

Advanced operations follow a staged capability model: preserve, preview, validate, experimental conversion, then verified conversion. Paired BiesseWorks exports have moved the counter-clockwise center/end `ARC_EPCE` subset to verified conversion in both directions. Its endpoint, center, Z values, and direction are compared explicitly. Other arc forms and geometry references remain visible in the viewer while the strict serializer refuses them. Ambiguous BPP positional records remain preserved until a verified exporter profile establishes their field layout.

Optional machine profiles run after document validation. They produce advisory travel, face, depth, tool, drill-bank, and spindle warnings for the viewer, CLI, and bulk report. They never change conversion success and do not claim collision, clamping, controller, or postprocessor validation.

The intermediate representation is vendor-neutral and versioned. Parsers retain unknown source records and attach diagnostics instead of silently discarding or guessing their meaning. Renderers consume only the IR; they do not interpret raw machine commands.

Repeated drilling remains one operation in the IR with an explicit count and offset. Validation and rendering expand that pattern safely, with a hard upper bound. Routed geometry is assembled from ordered start/end-point records.

## Parsers

- The BPP parser reads named sections, `PAN` variables, and compact `@` records from the `PROGRAM` section. Embedded VBScript is treated as inert text and is never executed.
- The CIX parser reads text blocks delimited by `BEGIN` and `END`, then interprets named macro parameters. CIX input is not assumed to be XML.

## Trust boundaries

- Inputs are untrusted local files.
- No input is executed.
- SVG text is escaped before rendering.
- Conversion fails closed on unsupported operations or incomplete panel geometry.
- Converted output carries an explicit machine-use warning and must be checked in vendor software.
- No network access is required.
- Project history and corpus history remain in the browser's local IndexedDB database.
- Folder access is limited to the directory explicitly selected by the user; the browser cannot enumerate arbitrary drives or parent directories.
- No G-code, postprocessor, or direct machine-control package exists in this repository.
