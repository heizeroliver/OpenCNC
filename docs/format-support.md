# Format support

OpenCNC implements observed BPP and CIX constructs conservatively. Support means the construct was parsed successfully and cross-checked locally; it does not imply complete vendor-format compatibility.

| Construct | BPP v150 | CIX text macro |
| --- | --- | --- |
| Panel width, height, thickness | Supported | Supported |
| Drilling (`BG`) | Supported | Supported |
| Alternate drilling record (`BV`) | Preserved as drilling; generated route-entry bores recognized | Supported when present |
| Face/side value | Supported | Supported |
| Depth and diameter | Supported | Supported |
| Linear X/Y repetitions | Supported | Supported |
| Routed line paths | Supported | Supported |
| Explicit dialect detection | BPP family / observed v150 profile | CIX family / observed text-macro profile |
| Geometry definitions (`GEO`) | Linear records previewed; arcs profile-gated | Structured and previewed |
| Counter-clockwise center/end arcs (`ARC_EPCE`) | Verified 11-field positional profile | Structured, rendered, and verified |
| Other arcs (clockwise `ARC_EPCE`, `ARC_EPRA`, `ARC_IPEP`) | Preserved; explicit positional profile required | Structured and rendered when numeric geometry is complete; conversion blocked |
| Geometry routes (`ROUTG`) | Classified and preserved | Geometry reference resolved and previewed |
| Pockets (`PKT1`, `POCK`) | Classified and preserved | Geometry reference resolved and previewed |
| Saw cuts / grooves | Classified and preserved | Linear geometry previewed where defensible |
| Expressions / conditional records | Preserved without execution | Preserved without execution |
| Unknown operations | Preserved with diagnostics | Preserved with diagnostics |
| Direct machine execution | Intentionally unsupported | Intentionally unsupported |

Advanced operation support is staged: `preserved` → `preview` → `validated` → `experimental-conversion` → `verified-conversion`. The current parser can expose more geometry than the serializer is allowed to emit. Preview-only records make conversion fail closed rather than disappearing or being flattened into an unsafe approximation.

## Conversion support

OpenCNC can translate the supported intermediate representation in either direction. Every generated file is reparsed and compared with its source IR before it is offered for download or written by the CLI.

| Construct | BPP → CIX | CIX → BPP |
| --- | --- | --- |
| Panel width, height, thickness | Verified | Verified |
| `BG` / `BV` drilling | Verified | Verified |
| Face, position, Z, depth, diameter | Verified | Verified |
| Linear X/Y repetition | Verified | Verified |
| Routed line paths with multiple segments | Verified | Verified |
| Counter-clockwise `ARC_EPCE` route segments | Verified with endpoint, center, Z, and direction comparison | Verified with 11-field record and matching VBScript call |
| Observed `KILINCSM` tool identity without CIX `DIA` | Restored as `KILINCSM` plus 18 mm diameter | Resolved to 18 mm from paired local BiesseWorks evidence |
| BiesseWorks inside-panel route-entry `BV` | Removed as generated scaffolding | Regenerated with shared logical path ID |
| Operation labels | Preserved when present | Preserved when present |
| Observed drill azimuth/rotation/mode and tool class/type | Mapped | Mapped |
| Observed route tool identity/class and entry/exit parameters | Mapped | Mapped |
| Unknown, cut, or incomplete operations | Conversion refused | Conversion refused |
| BPP `WAIT` | Preserved as non-executing metadata with warning | Restored when OpenCNC metadata is present |
| Other arcs, geometry, pockets, saw cuts, grooves, `ROUTG` | Conversion refused after preview/preservation | Conversion refused after preview/preservation |
| Source comments, metadata, byte layout | Normalized, not preserved | Normalized, not preserved |

Conversion verification uses the public synthetic BPP/CIX pair and a local corpus of 18 original production exports. The current Downloads folder also contains one duplicated BPP/CIX pair, so the latest bulk run covered 20 files. All 20 passed target reparse, reverse conversion, normalized semantic equality, and expanded-geometry equality. Four exact BiesseWorks CIX→BPP pairs also match the corrected writer line-for-line after normalizing only runtime object IDs and the installation-specific `PUTLST` value. The advanced Tetolap modules add exact checks for 92 BPP program records and 92 VBScript operation calls, including eight counter-clockwise arcs and `KILINCSM` tool resolution. These private files are local evidence and are not redistributed by the project.

Generated BPP uses the observed BiesseWorks v150 Windows envelope, CRLF line endings, ASCII-safe bytes, full positional record widths, three-decimal drilling values, up-to-seven-decimal route geometry, and matching VBScript calls. Non-ASCII output is rejected until an authoritative Windows code-page profile is established.

## Verification snapshot

The implementation was exercised locally against 18 private production exports: eight BPP files and ten CIX files. All parsed without errors, produced finite SVG geometry, and yielded valid panel dimensions. Eight filename-matched BPP/CIX pairs agreed on panel dimensions; five also produced identical normalized geometry. The remaining three pairs contain genuine export-level differences, including compact `BV` representation, a `WAIT` record, or different face subsets.

The private files are not committed or redistributed. Public unit tests cover the same parser and converter concepts using independently written synthetic data.

## Interpretation boundaries

- A route outside the panel is informational because lead-ins and lead-outs may intentionally cross the panel boundary.
- Depth greater than panel thickness is informational because through operations may intentionally exceed material thickness.
- Face values are preserved numerically until their coordinate semantics have been verified across more machines and dialects.
- Unknown records remain available under `raw` data and produce diagnostics instead of being silently discarded.
- Dialect detection is an evidence label, not vendor certification. `observed-compatible` means the header and record shapes match the tested corpus.
- Machine profiles are optional, local, and advisory. Travel, face, depth, tool-diameter, drill-bank, and spindle-range warnings do not prove collision safety or postprocessor compatibility.
