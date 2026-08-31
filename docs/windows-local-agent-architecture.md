# Windows Local Agent architecture baseline

This note captures the known-good automation architecture at the `pre-windows-agent` checkpoint. It is intentionally descriptive: the verified converter remains the canonical conversion implementation.

## Existing workflow

1. **Project discovery.** The Node watcher treats the configured root as a project when it contains top-level CIX files, then examines each immediate non-hidden child directory except `BPP`. A child is included only when it contains top-level CIX files. The browser applies the same immediate-folder rule through the File System Access API.
2. **Stability detection.** `quickWorkspaceFingerprint` sorts case-normalized filename, size, and modification-time tuples. The CLI requires the same fingerprint in two consecutive polls. The browser keeps the same two-scan test, but only for the currently selected project.
3. **Conversion trigger.** Once stable, `convertWatchProject` or `convertWorkspaceProject` parses every CIX file, runs the shared guarded bulk converter, requires target reparse plus reverse semantic and expanded-geometry verification, and blocks the whole project if any conversion job fails.
4. **Output creation.** The Node workflow plans every write before creating the project's output directory. It then creates `BPP`, uses temporary same-directory files plus rename for atomic replacement, writes optional QA sheets, writes the report, and writes the manifest last. The browser follows the same planning order through directory handles, although its writable-stream replacement is browser-managed rather than the Node atomic-rename implementation.
5. **Manual-edit protection.** Every source and generated output is checksummed. `planWorkspaceWrite` creates missing output, leaves identical output unchanged, updates only when the current output checksum equals the previous OpenCNC manifest checksum, and returns a conflict for unknown or manually changed output. Conflicts block all project writes and files are never deleted automatically.
6. **Configuration storage.** CLI watcher configuration exists only in process arguments. Browser folder settings and directory handles are stored in IndexedDB; machine profile and language settings use browser local storage. Local browser project history uses a separate IndexedDB database. There is no persistent background-agent configuration or cross-process job history yet.
7. **Why unchanged failures do not retry.** The CLI sets its in-memory `attempted` fingerprint before calling conversion and skips whenever that same fingerprint appears again. It does not distinguish success, permanent conflict, guarded conversion block, or thrown transient filesystem failure. The browser similarly stores one `workspaceLastAttemptFingerprint`; unchanged failed projects therefore remain suppressed until files change, the project is reselected, or the process/UI state is reset.

## Reuse and extraction boundary

The Windows Local Agent should reuse, not duplicate:

- `packages/converter` as the only CIX/BPP conversion engine;
- `packages/workspace` for fingerprints, manifests, checksums, and overwrite decisions;
- the Node watcher's project discovery, safe output planning, QA/report generation, and atomic rename behavior;
- `packages/profiles` for optional machine checks; and
- the existing two-sided CIX grouping performed inside guarded bulk conversion.

A reusable `packages/agent-core` should own polling-independent state: discovered projects, stability observations, case-insensitive collision checks, job lifecycle, retry classification, bounded exponential backoff, persistence interfaces, and event/status reporting. Node filesystem conversion should move behind an injected adapter or reusable service. The CLI and Windows tray process should both drive the same core.

The browser folder workflow remains constrained by user-granted directory handles and can retain its browser-specific implementation. Shared pure retry/state utilities may be reused, but a background Windows agent must not depend on an open browser or selected project.

## Platform direction

The existing TypeScript and Node implementation makes an Electron tray application the lowest-duplication Windows packaging path. It can bundle its runtime, host the existing local viewer, provide tray/notification/startup APIs, and call the shared Node filesystem agent without requiring Node.js or pnpm on the target computer. Platform integration must remain isolated under `apps/windows-agent`; conversion stays in `packages/converter` and automation state stays in `packages/agent-core`.

## Extracted core

`packages/agent-core` now owns the retry/stability controller, generic cycle runner, lifecycle events, serializable attempt state, persistent configuration/runtime/history interfaces, Node project discovery, guarded project conversion, QA/report generation, and atomic workspace writes. `apps/cli/src/workspace-watch.ts` is a compatibility adapter that maps CLI options and console events onto this shared core. Existing CLI exports remain available to avoid breaking callers and tests.
