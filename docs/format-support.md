# Format support

OpenCNC implements observed BPP and CIX constructs conservatively. Support means the construct was parsed successfully and cross-checked locally; it does not imply complete vendor-format compatibility.

| Construct | BPP v150 | CIX text macro |
| --- | --- | --- |
| Panel width, height, thickness | Supported | Supported |
| Drilling (`BG`) | Supported | Supported |
| Alternate drilling record (`BV`) | Preserved as drilling | Supported when present |
| Face/side value | Supported | Supported |
| Depth and diameter | Supported | Supported |
| Linear X/Y repetitions | Supported | Supported |
| Routed line paths | Supported | Supported |
| Unknown operations | Preserved with diagnostics | Preserved with diagnostics |
| Arcs and advanced contours | Not yet verified | Not yet verified |
| Machine-control output | Intentionally unsupported | Intentionally unsupported |

## Verification snapshot

The implementation was exercised locally against 18 private production exports: eight BPP files and ten CIX files. All parsed without errors, produced finite SVG geometry, and yielded valid panel dimensions. Eight filename-matched BPP/CIX pairs agreed on panel dimensions; five also produced identical normalized geometry. The remaining three pairs contain genuine export-level differences, including compact `BV` representation, a `WAIT` record, or different face subsets.

The private files are not committed or redistributed. Six public unit tests cover the same parser concepts using independently written synthetic data.

## Interpretation boundaries

- A route outside the panel is informational because lead-ins and lead-outs may intentionally cross the panel boundary.
- Depth greater than panel thickness is informational because through operations may intentionally exceed material thickness.
- Face values are preserved numerically until their coordinate semantics have been verified across more machines and dialects.
- Unknown records remain available under `raw` data and produce diagnostics instead of being silently discarded.
