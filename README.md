# OpenCNC

[![CI](https://github.com/heizeroliver/OpenCNC/actions/workflows/ci.yml/badge.svg)](https://github.com/heizeroliver/OpenCNC/actions/workflows/ci.yml)

**A local interoperability toolkit for woodworking CNC files.**

OpenCNC makes proprietary CNC program data inspectable through a clear, local workshop view and a vendor-neutral JSON representation. The early MVP reads Biesse BPP/CIX documents, validates geometry, compares matching exports, renders SVG previews, and performs guarded conversion between its supported BPP and CIX subset.

> **Safety boundary:** converted BPP/CIX files are interoperability drafts, not production-ready machine programs. OpenCNC cannot validate tooling, workholding, machine configuration, or collisions. Always inspect and simulate converted files in the vendor software before considering machine use.

## Current status

🚧 **Early-stage project:** the parser has been verified locally against 18 representative BPP/CIX exports. Those private production files are not distributed; public regression tests use independently written synthetic fixtures.

Current verified coverage:

- Local Hungarian/English workshop viewer with drag-and-drop batch opening
- Interactive top/side drilling and route layers with source-line highlighting
- Explicit dialect detection with confidence, version/record-shape evidence, and target-profile reporting
- Verified bidirectional counter-clockwise `ARC_EPCE` route conversion; other advanced arcs, geometry references, pockets, saw cuts, and grooves remain preview-only and fail closed
- Optional local machine profile with advisory travel, face, depth, tool, drill-bank, and spindle checks
- Verified BPP→CIX and CIX→BPP conversion for the currently supported operation subset
- Bulk conversion preflight in the browser with file selection, editable naming templates, collision blocking, ZIP naming, and a fidelity report
- Production QA packages with an A4 PDF job sheet, workpiece thumbnail, checks, SHA-256 integrity values, local report QR, simulation approval, and operator sign-off
- Regression Corpus Lab with local anonymization, parser/renderer/converter/round-trip testing, input mutations, novelty detection, reduced failure fixtures, and previous-run comparison
- Local IndexedDB project sessions for loaded source files, conversion reports, archive names, operator notes, simulation state, and previous/current comparisons
- Folder automation that lists CIX project folders under one user-approved parent, refreshes every 10 seconds, and writes verified output into each project's `BPP` subfolder
- Automatic, fail-closed `_f0.cix` + `_f1.cix` two-sided pairing into one BPP with the verified BiesseWorks operator-reposition `WAIT` boundary
- Cross-platform unattended Node watcher with stable-export debouncing, per-project manifests, and checksum-protected updates—no Python runtime required
- Conversion Diff Center with field-level source, target, and reverse-conversion values
- Workpiece dimensions, expanded drill counts, grouped drill lists, and route lengths
- Tolerance-aware, order-independent BPP/CIX matching that understands repeated versus explicit drills and flags reversed routes
- Print-ready job sheets plus JSON and SVG export
- BPP v150 Windows layout with CRLF, complete panel variables, full-width program records, and matching VBScript
- CIX text-macro blocks (`BEGIN` / `PARAM` / `END`), not XML
- Drilling (`BG` and `BV`) with face, position, depth, and diameter
- Linear drill repetitions with count and X/Y offsets
- Routed line/verified-arc paths (`ROUT`, `START_POINT`, `LINE_EP`, counter-clockwise `ARC_EPCE`, `ENDPATH`)
- Structured diagnostics and SVG previews

See [format support](docs/format-support.md) for boundaries and known differences.

## Quick start

### Workshop viewer

On a Mac, double-click **`OpenCNC Workshop.command`**. The first run prepares the project; then the viewer opens in the browser. Keep the small Terminal window open while using it.

Or start it from Terminal:

```sh
pnpm install
pnpm viewer:open
```

Drop one or more `.bpp` or `.cix` files onto the page. Files are processed only in the browser on that computer and are never uploaded.

For the production-folder workflow, open **Folder automation**, grant read/write access to the parent folder containing the exported project folders, select a project, and choose **Convert into BPP folder**. Optional automatic mode checks every 10 seconds and waits for two unchanged scans before conversion. Chrome or Edge is required for direct folder writing; regular file/ZIP conversion remains available in other browsers.

For a watcher that works without keeping the browser open, double-click **`OpenCNC Auto Watch.command`** on macOS or run **`OpenCNC Auto Watch.ps1`** on Windows, then choose the parent folder.

### Developer tools

```sh
pnpm install
pnpm test
pnpm build
pnpm opencnc summary path/to/file.cix
pnpm opencnc inspect path/to/file.bpp
pnpm opencnc svg path/to/file.cix --out preview.svg
pnpm opencnc convert path/to/file.bpp --out converted.cix --qa-pdf converted-qa.pdf
pnpm opencnc convert path/to/file.cix --out converted.bpp
pnpm opencnc bulk-convert path/to/input-directory --out-dir path/to/new-output-directory
pnpm opencnc corpus-lab path/to/input-directory --out corpus-report.json --export-dir anonymized-corpus
pnpm opencnc watch path/to/parent-directory --interval 10
pnpm opencnc watch path/to/parent-directory --once --qa
pnpm opencnc validate path/to/file.cix --machine-profile path/to/machine-profile.json
```

## Repository layout

- `packages/core`: intermediate representation, diagnostics, and validation
- `packages/parser-bpp`: conservative BPP reader
- `packages/parser-cix`: conservative CIX reader
- `packages/converter`: strict serializers and semantic round-trip verification
- `packages/profiles`: dialect detection and advisory local machine constraints
- `packages/qa`: deterministic PDF job sheets, checksums, report IDs, and sign-off artifacts
- `packages/corpus`: anonymization, regression execution, mutations, fixture reduction, and report comparison
- `packages/workspace`: shared folder-manifest, fingerprint, and overwrite-safety rules
- `packages/svg`: safe SVG preview renderer
- `apps/cli`: local inspection CLI
- `apps/viewer`: private, browser-based workshop interface
- `fixtures/synthetic`: non-proprietary test inputs
- `docs`: format notes and project decisions

## Non-goals for the first MVP

- G-code, postprocessor generation, or direct machine execution
- Claiming converted BPP/CIX drafts are production-ready without vendor simulation
- Uploading production files to a service
- Silently guessing ambiguous units or operation semantics
- Claiming complete compatibility from the currently verified sample set

## Roadmap and contributing

See the [folder workflow](docs/folder-workflow.md) for setup and safety behavior, and the [roadmap](docs/roadmap.md) for the planned path from format discovery to a useful local viewer. Contributions are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md), especially the fixture privacy and licensing rules.

## License

Apache-2.0. Biesse and other product names are trademarks of their respective owners. OpenCNC is an independent project and is not affiliated with or endorsed by those vendors.
