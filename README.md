# OpenCNC

[![CI](https://github.com/heizeroliver/OpenCNC/actions/workflows/ci.yml/badge.svg)](https://github.com/heizeroliver/OpenCNC/actions/workflows/ci.yml)

**A read-only interoperability toolkit for woodworking CNC files.**

OpenCNC aims to make proprietary CNC program data inspectable and portable through a vendor-neutral JSON representation. The early MVP reads Biesse BPP/CIX documents, validates basic geometry, and renders SVG previews.

> **Safety boundary:** OpenCNC does not generate G-code or machine-control output. Parsed data and previews must not be used as the sole basis for operating machinery.

## Current status

🚧 **Early-stage project:** the parser has been verified locally against 18 representative BPP/CIX exports. Those private production files are not distributed; public regression tests use independently written synthetic fixtures.

Current verified coverage:

- BPP v150 panel variables and compact program records
- CIX text-macro blocks (`BEGIN` / `PARAM` / `END`), not XML
- Drilling (`BG` and `BV`) with face, position, depth, and diameter
- Linear drill repetitions with count and X/Y offsets
- Routed line paths (`ROUT`, `START_POINT`, `LINE_EP`, `ENDPATH`)
- Structured diagnostics and SVG previews

See [format support](docs/format-support.md) for boundaries and known differences.

## Quick start

```sh
pnpm install
pnpm test
pnpm build
pnpm opencnc summary path/to/file.cix
pnpm opencnc inspect path/to/file.bpp
pnpm opencnc svg path/to/file.cix --out preview.svg
```

## Repository layout

- `packages/core`: intermediate representation, diagnostics, and validation
- `packages/parser-bpp`: conservative BPP reader
- `packages/parser-cix`: conservative CIX reader
- `packages/svg`: safe SVG preview renderer
- `apps/cli`: local inspection CLI
- `fixtures/synthetic`: non-proprietary test inputs
- `docs`: format notes and project decisions

## Non-goals for the first MVP

- G-code or machine-control generation
- Uploading production files to a service
- Silently guessing ambiguous units or operation semantics
- Claiming complete compatibility from the currently verified sample set

## Roadmap and contributing

See the [roadmap](docs/roadmap.md) for the planned path from format discovery to a useful local viewer. Contributions are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md), especially the fixture privacy and licensing rules.

## License

Apache-2.0. Biesse and other product names are trademarks of their respective owners. OpenCNC is an independent project and is not affiliated with or endorsed by those vendors.
