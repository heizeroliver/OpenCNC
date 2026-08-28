# Architecture

The data flow is intentionally one-way and read-only:

`BPP / CIX input → conservative parser → OpenCNC IR → validation → JSON or SVG`

The intermediate representation is vendor-neutral and versioned. Parsers retain unknown source records and attach diagnostics instead of silently discarding or guessing their meaning. Renderers consume only the IR; they do not interpret raw machine commands.

Repeated drilling remains one operation in the IR with an explicit count and offset. Validation and rendering expand that pattern safely, with a hard upper bound. Routed geometry is assembled from ordered start/end-point records.

## Parsers

- The BPP parser reads named sections, `PAN` variables, and compact `@` records from the `PROGRAM` section. Embedded VBScript is treated as inert text and is never executed.
- The CIX parser reads text blocks delimited by `BEGIN` and `END`, then interprets named macro parameters. CIX input is not assumed to be XML.

## Trust boundaries

- Inputs are untrusted local files.
- No input is executed.
- SVG text is escaped before rendering.
- No network access is required.
- No machine-control or postprocessor package exists in this repository.
