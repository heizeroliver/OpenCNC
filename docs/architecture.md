# Architecture

The data flow is intentionally one-way and read-only:

`BPP / CIX input → conservative parser → OpenCNC IR → validation → JSON or SVG`

The intermediate representation is vendor-neutral and versioned. Parsers retain unknown source records and attach diagnostics instead of silently discarding or guessing their meaning. Renderers consume only the IR; they do not interpret raw machine commands.

## Trust boundaries

- Inputs are untrusted local files.
- No input is executed.
- SVG text is escaped before rendering.
- No network access is required.
- No machine-control or postprocessor package exists in this repository.

