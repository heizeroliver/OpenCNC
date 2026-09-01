# Folder automation workflow

OpenCNC supports the export pattern where another program creates multiple CIX files inside a project folder and many project folders live under one parent directory.

```text
Production projects/
├── Kitchen 42/
│   ├── top_f0.cix
│   ├── top_f1.cix
│   └── BPP/
│       ├── top_f1.bpp
│       ├── QA/
│       ├── opencnc-conversion-report.json
│       └── opencnc-sync-manifest.json
└── Wardrobe 18/
    ├── door.cix
    └── BPP/
```

Only immediate child folders are treated as projects. If the selected parent itself contains CIX files, it is also presented as one project. Existing `BPP` folders are never scanned as new source projects.

An exact `_f0.cix`/`_f1.cix` pair is treated as one two-sided workpiece when its panel setup also matches. The resulting BPP contains f0 machining, the verified BiesseWorks operator-reposition `WAIT`, and then f1 machining. The manifest records both CIX sources against that one BPP, so a change to either face makes the project eligible for reconversion. Ambiguous duplicates and panel mismatches are never guessed into a pair.

## Browser workflow

1. Open **Folder automation**.
2. Choose the parent directory and grant read/write permission.
3. Select a project folder to see all of its top-level CIX files.
4. Choose **Open CIX files** for normal visual inspection, or **Convert into BPP folder** to write verified outputs directly.
5. Optionally enable automatic conversion. OpenCNC scans every ten seconds and waits for the same file names, sizes, and modification times to appear in two consecutive scans before reading them. This settling period avoids converting a CIX while the exporter is still writing it.

The browser tab must remain open for polling. Directory handles can be stored in IndexedDB, but the browser may require a user click to restore read/write permission after restart. Chrome and Edge expose the directory read/write API. Other browsers fall back to folder import followed by the existing ZIP download workflow.

The browser cannot list the computer's drives or arbitrary directories. It can enumerate only the folder the user explicitly selects and its descendants. This is a deliberate browser security boundary, documented by the [File System Access specification](https://github.com/WICG/file-system-access/blob/main/index.bs) and [Chrome implementation guide](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).

## Unattended local watcher

The local watcher uses Node.js and the existing TypeScript conversion engine; Python would not improve conversion fidelity. It continues working without an open browser.

```sh
pnpm opencnc watch path/to/parent-folder --interval 10
```

Transient project failures such as a temporarily locked file remain retryable even when the CIX fingerprint does not change. The watcher starts with a five-second retry delay, doubles it after each consecutive failure, and caps it at five minutes. A successful or already-current result clears retry state and is not rerun for the same fingerprint. Guarded conversion blocks and checksum conflicts are permanent for that fingerprint; the watcher waits for a source change instead of repeatedly attempting or weakening overwrite protection.

Options:

- `--project "Kitchen 42"` watches only one immediate project folder.
- `--output-folder BPP` changes the output subfolder name.
- `--qa` generates QA PDF sheets under `BPP/QA`.
- `--machine-profile machine.json` adds the configured advisory checks.
- `--stability-scans 2` controls how many identical observations are required before conversion.
- `--retry-initial 5` and `--retry-max 300` configure bounded exponential retry delays in seconds.
- `--once` performs one immediate pass and exits; it is useful for scheduled jobs and testing.

For a simple local installation, use `OpenCNC Auto Watch.command` on macOS or `OpenCNC Auto Watch.ps1` on Windows. Each launcher shows a native folder chooser, then keeps the watcher visible in a terminal window. Press Control-C to stop it.

## Write-safety contract

Folder automation is stricter than a normal overwrite loop:

1. Every CIX file in the project must parse and pass target reparse, reverse conversion, semantic round trip, and expanded-geometry round trip.
2. No project outputs are written if any input fails.
3. A new BPP filename can be created.
4. An identical BPP is left untouched.
5. A changed BPP can be updated only when its current SHA-256 equals the checksum in the previous OpenCNC manifest.
6. A manually edited or unknown BPP creates a conflict and blocks the entire project write.
7. If a CIX is removed, the old BPP is reported as orphaned but not deleted automatically.
8. All changed BPP files are durably staged as one guarded batch. Sources and expected existing-output checksums are rechecked before each replacement; a mid-batch error rolls prior replacements back.
9. The manifest is written last, after the output and report writes succeed.

These rules make repeated automatic conversion practical without treating the export folder as disposable. Generated BPP files remain interoperability drafts and must still be inspected and simulated in the machine vendor's software.
