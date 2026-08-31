# Roadmap

## Phase 0 — repository foundation (complete)

- Versioned vendor-neutral intermediate representation
- Conservative BPP and CIX reader scaffolds
- Basic geometry validation and SVG rendering
- CLI and synthetic tests

## Phase 1 — real-world format discovery (current)

- Continue testing against permission-cleared BPP and CIX samples
- Expand beyond the currently mapped panels, drilling, repetitions, and routed lines
- Document dialect and version differences
- Expand diagnostics and regression fixtures

## Phase 2 — useful local viewer

- Interactive local preview (initial workshop view complete)
- Operation filters and source-to-preview traceability (initial layer controls and highlighting complete)
- Guarded BPP/CIX conversion with semantic round-trip verification (supported subset complete)
- Bulk BPP/CIX conversion with reverse verification and per-file fidelity reporting (complete)
- Conversion Diff Center with source/target/reverse field classification (complete)
- Order-independent, tolerance-aware operation matching with expanded repetition support (complete)
- Bulk preflight with selection, naming templates, editable ZIP/output names, and conflict blocking (complete)
- Explicit BPP/CIX dialect profiles with evidence-based auto-detection and report visibility (initial observed profiles complete)
- Staged advanced-operation model with verified counter-clockwise `ARC_EPCE` conversion plus preview/fail-closed handling for other arcs, geometry, pockets, and cuts
- Optional local machine profiles with advisory preflight checks (initial travel/face/depth/tool checks complete)
- Production QA package with PDF workpiece sheet, checksums, report QR, and sign-off (complete)
- Regression Corpus Lab with anonymization, robustness mutations, reduced fixtures, and previous-run comparison (complete)
- Local project sessions with operator notes, simulation status, conversion report, and previous/current comparison (complete)
- User-approved parent-folder browser workflow with project listing and direct `BPP` subfolder export (complete)
- Ten-second stable-file polling and persisted folder handles with explicit reconnect state (complete)
- Cross-platform unattended Node watcher with checksum manifests and conflict-safe updates (complete)
- JSON Schema publication
- Corpus verification and guarded serialization for remaining advanced operation families
- Exact envelopes for clockwise `ARC_EPCE`, `ARC_EPRA`, `ARC_IPEP`, and transformed coordinates

## Later

- Additional vendor importers and neutral interchange formats
- Stable library API and package releases

Machine-control and G-code generation are intentionally outside the first MVP.
