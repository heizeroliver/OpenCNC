# OpenCNC Local Agent for Windows

OpenCNC Local Agent is the unattended, local Windows workflow for folders exported by a CNC/CAD program. It recursively maps the directory tree below one selected parent, waits for CIX files to stop changing, and then uses OpenCNC's existing guarded converter to create or update that project's output directory. The default output pattern is `{projectName}_bpp`, so `Kitchen 101` writes to `Kitchen 101_bpp`. Selecting a project in the browser viewer is not required.

The application runs in the Windows notification area (system tray), keeps its settings and retry state across logout/reboot, and includes its own Electron/Node runtime. The target computer does not need Node.js, pnpm, Python, a developer terminal, or this Git repository.

> Converted programs still require inspection and simulation in the vendor software. The agent verifies the supported file semantics and expanded geometry; it cannot validate the physical machine, clamps, tooling, controller behavior, or collisions.

## Install

The Windows build is produced by `.github/workflows/windows-agent.yml` on a real `windows-latest` GitHub runner.

1. Open the repository's **Actions** page and select **Windows Local Agent**.
2. Open the latest successful run for the intended `release/windows-agent-rc1` commit or immutable `windows-agent-v*` tag.
3. Download the commit-specific `OpenCNC-Windows-Installer-<commit>` artifact and compare the installer with its included `SHA256SUMS.txt`.
4. Extract it and run `OpenCNC-Local-Agent-Setup.exe`.
5. Follow the install wizard. It supports a per-user install, a selectable installation directory, Start Menu/Desktop shortcuts, and normal Windows uninstall.

There is no background self-updater yet. To upgrade an existing installation, exit OpenCNC from its tray menu, download and verify the newer artifact, then run the newer installer over the existing installation and choose the same destination. Do not uninstall first. The Windows release workflow tests this in-place path and verifies that the SQLite settings/history and `%APPDATA%\OpenCNC Local Agent` data survive. If an in-place installation fails, back up that data directory, uninstall from Windows Settings, install the new build, and start it again; the uninstaller is configured to retain application data.

Unsigned validation builds may trigger Windows SmartScreen. The workflow accepts protected Authenticode credentials when available and records/verifies the signature state; see [Windows signing readiness](windows-code-signing.md). Do not treat an unsigned RC as a signed production release.

## First run and folder layout

Open **Settings**, choose the parent projects folder, and save. The directory should look like this:

```text
C:\CNC Projects\
  Kitchen 101\
    Door_f0.cix
    Door_f1.cix
  Wardrobe 204\
    Left_side.cix
```

The first successful scan after choosing a parent (and the first scan after upgrading from RC2) stores every existing nested directory as a baseline. Those earlier directories remain visible as **Existing · not enrolled**, but are not converted automatically. Any directory created afterward is enrolled, including a new directory nested inside an older one. Deleting and recreating an old path after it has disappeared from a scan makes that new directory eligible. Changing the selected parent captures a fresh baseline.

Discovery is recursive: a CIX-bearing project may be any number of levels below the parent. Hidden folders, OpenCNC lock folders, and managed output folders are excluded. Only `.cix` files directly inside each discovered project directory belong to that project. If `Door_f0.cix` and `Door_f1.cix` form the supported two-sided pair, the canonical converter can merge them into one BPP with the verified operator-reposition wait boundary.

CIX inputs are read-only: OpenCNC never renames, overwrites, moves, or deletes them. It reads and checks their size, timestamp, and SHA-256 while writing only to the resolved output subfolder. The editable output pattern may contain the single `{projectName}` placeholder or be a fixed Windows-safe name such as `BPP`.

The agent requires two identical scans by default. The fingerprint contains case-normalized filename, byte size, and modification time. A file is also checked after it is read; if it changed during the read, the attempt fails temporarily and retries instead of converting a partial export.

## Project folder browser and BiesseWorks handoff

The status screen lists every mapped directory with its CIX count, BPP count, and state. Select a row to open the original project folder, open its output folder, or open the latest fully verified BPP batch in BiesseWorks. Existing baseline folders remain visible even though they are excluded from automatic conversion.

After a project completes guarded conversion, the status screen enables **Open latest in BiesseWorks: …** and the equivalent selected-project action. One click opens every BPP recorded by that conversion job sequentially through BiesseWorks **File → Open**, so a project containing many CIX exports does not require manual selection. Approve the Windows administrator prompt once and do not use BiesseWorks until OpenCNC reports `N/N` files opened. The separate output-folder buttons remain the manual fallback.

The renderer sends only the persisted job ID. The Electron main process resolves the recorded output directory and names, requires the job to be completed with forward and reverse verification, rejects path traversal or non-BPP names, confirms every file is regular, and recomputes every SHA-256 before launching anything. If any output is missing or changed, none of the batch is handed off. A packaged, elevated local helper rechecks the same hashes, starts the fixed local BiesseWorks Editor when necessary, and drives only its proven **Ctrl+O / File → Open** path one file at a time. It does not change the registry or BiesseWorks installation, close documents, run simulation, or send a program to a CNC.

This targeted bridge exists because the observed BiesseWorks Editor 3.3.0.316 installation registers `.bpp` through legacy DDE (`Editor.exe /dde` plus `[open("%1")]`), but Explorer opens only a blank editor on the production computer. A quoted full-path command opens one file only on a cold start, while the running editor ignores later command-line requests; manual **Ctrl+O** works consistently. The bridge therefore uses that demonstrated application path without attempting a speculative DDE or registry repair. This is evidence for the tested installation, not a promise for every BiesseWorks version.

If Windows reports that no application is associated, right-click a known test `.bpp` in File Explorer, choose **Open with**, select BiesseWorks, and enable the option to always use that application. Convert the project again if the dashboard says its job predates launch tracking.

## Tray controls

The tray icon color and menu show one of these states:

- **Running** — monitoring normally.
- **Paused** — configuration remains saved, but scans are disabled.
- **Processing** — scanning or converting.
- **Warning** — a permanent guarded-conversion block or filename/manual-edit conflict needs attention.
- **Error** — a temporary filesystem or monitored-folder failure will retry.

The tray menu opens the full OpenCNC viewer or Local Agent dashboard, opens the monitored folder or logs folder, pauses/resumes automation, runs an immediate scan, changes the folder, shows recent jobs/errors, opens settings, controls **Start with Windows**, or exits the process. Closing the window leaves the tray agent running; choose **Exit** from the tray to stop it completely. The dashboard footer shows the application version and source commit for artifact traceability.

## Settings

The following are stored locally:

- Hungarian/English language choice;
- parent projects folder and persisted existing-folder baseline;
- BPP output folder pattern (default `{projectName}_bpp`);
- polling interval and required stable scans;
- initial and maximum retry delay;
- QA PDF generation;
- optional JSON machine-profile path;
- automation running/paused state;
- ordinary-success notification preference; and
- start-after-Windows-login preference.

The auto-start option uses Electron's Windows login-item API and starts the installed executable with a hidden-window argument after login. It does not depend on a developer shell or source path.

## Retry and recovery behavior

Thrown filesystem failures are temporary. This includes a locked source/output, temporarily denied permission, a disappearing project during a read, and many local/network I/O errors. The unchanged source fingerprint remains retryable. Delay doubles from the configured initial delay to the configured maximum; normal polling continues after recovery.

The agent also checks the names and SHA-256 values of the last verified BPP set on every scan. If the output folder or one generated BPP is deleted, the project becomes eligible again even though no CIX changed, and the guarded converter recreates the missing output. If an output was edited rather than deleted, checksum protection produces a conflict instead of overwriting that edit.

A missing/unavailable parent directory has its own bounded exponential backoff. Notifications are emitted on the first and third consecutive folder failure, then a recovery notification appears when the folder reconnects. Project failures notify on the first and third attempt, avoiding a notification on every poll.

Retry observations are saved to SQLite after every scan. If Windows closes the process while a job is marked `converting`, startup marks that history entry as interrupted/retrying and safely reevaluates it. Each BPP batch is staged in the destination directory and flushed before replacement. The agent rechecks every source and expected existing output before each commit; a mid-batch failure rolls earlier replacements back and removes staging files. Report and manifest files are written last. A per-project atomic directory lock prevents two agent processes from writing the same project; its heartbeat makes a genuinely abandoned lock recoverable after ten minutes.

## Conflicts and manual BPP protection

Conflicts do not retry until the CIX/output condition changes or the operator resolves the condition:

- `PartA.cix` and `parta.cix`, or Unicode-equivalent filename forms, are rejected because Windows would treat their destinations as the same name;
- colliding BPP output names are rejected before any production output is written; and
- an existing BPP is updated only when its SHA-256 checksum still equals the checksum in the previous OpenCNC manifest.

If an operator or BiesseWorks has edited a generated BPP, OpenCNC leaves it untouched and marks the whole project `conflicted`. The agent never deletes orphaned BPP files automatically. Resolve a conflict by reviewing/renaming the source collision or deliberately moving the edited output elsewhere; never delete an important production edit merely to silence the warning.

## Local history, database, and logs

The dashboard reads local SQLite history containing job ID, project and fingerprint, source/output names, timestamps, lifecycle status, retry count, input/output SHA-256 values, QA flag, forward/reverse verification, and the last message. The database also stores configuration and serialized retry observations. Schema migrations run in an immediate transaction and are tracked with SQLite `user_version`; startup runs `quick_check`. A newer unknown schema or corrupt/unreadable database stops startup explicitly and leaves the database bytes untouched for backup/recovery. OpenCNC never silently deletes a damaged history database.

By default, Electron stores these under:

```text
%APPDATA%\OpenCNC Local Agent\
  opencnc-agent.sqlite
  opencnc-agent.sqlite-wal
  opencnc-agent.sqlite-shm
  opencnc-agent.log
  opencnc-agent.log.previous
```

Use **Settings → Open data and logs folder** or **Tray → Open logs folder** to open the actual location. The active log rotates at approximately 5 MB and one previous log is retained, bounding normal diagnostic retention to roughly 10 MB. Job logging contains paths, transitions, retry counts, and checksums, but not CIX/BPP file contents. Completed/failed/conflict history is capped at the newest 10,000 terminal jobs; all unfinished jobs are retained for recovery. Uninstall does not delete application data automatically, so history is not silently destroyed.

If startup reports database corruption or an unsupported newer schema, exit the agent, copy the SQLite file plus any `-wal`/`-shm` companions to a backup location, and provide those files with the rotated logs to a developer. Restore from a known backup or deliberately start with a new database only after the history/configuration recovery decision has been made; do not rename/delete the original merely to make the error disappear.

## Electron security boundary

Both application windows load only packaged local HTML/assets. Every renderer runs with context isolation, Node integration disabled, sandboxing and web security enabled, and a restrictive Content Security Policy. The preload exposes only the narrow Local Agent IPC methods; the main process validates the sender and configuration key/type boundary. Navigation is denied, new windows are denied, and only parsed HTTPS links may be delegated to the system browser. No remote scripts or webviews are loaded.

The viewer deliberately retains its local File System Access workflow. Because its content is packaged and it needs a user-mediated directory picker, the app does not install a blanket permission-denial handler that would break that local capability. It never receives arbitrary filesystem access from web content: directory access still starts with an explicit user selection. `pnpm audit --prod` and the full dependency audit are part of release review; dependency upgrades are evaluated rather than applied automatically.

## Notifications

Notifications are intentionally limited to conflicts, blocked conversions, first/repeated temporary failures, important recoveries, and optionally ordinary successful conversions. Windows notification settings can disable banners without disabling the agent.

## Troubleshooting

- **No project appears:** confirm the selected parent is reachable and a nested directory contains CIX files directly. Discovery is recursive.
- **Agent remains in Setup:** choose and save a parent folder.
- **Agent is Paused:** select **Resume automation** from the tray or enable automation in Settings.
- **Folder unavailable:** confirm the drive/share is connected and the installed user's account can list/read it. The agent retries automatically.
- **Locked-file retries:** close the exporter/vendor program if it holds an exclusive lock. OpenCNC will continue from persisted retry state.
- **Conflict:** open Errors/Recent jobs and inspect the message. Check case-only names, Unicode-equivalent names, and manually edited BPP files.
- **Blocked conversion:** the converter could not prove all guarded round trips. No BPP was written; inspect the conversion report/source and add a verified format fixture before extending conversion support.
- **BiesseWorks button is disabled:** complete a new verified CIX-to-BPP job with this application version first.
- **Windows permission prompt:** approve it once for the batch. Cancelling it stops the operation without changing BPP or CIX files.
- **BiesseWorks batch stops:** leave the editor and its dialogs untouched while progress is running. Use **Open selected output folder** and BiesseWorks **File → Open** as the fallback, then review the agent log. The compatibility helper is specifically profiled for Editor 3.3.0.316 at `C:\Biesse\BiesseWorks\Editor\Editor.exe`.
- **BPP changed after conversion:** OpenCNC blocks the complete launch batch when its current checksum no longer matches the verified job. Review the edit or perform a fresh guarded conversion; the button never weakens overwrite protection.
- **Machine profile error:** select a valid OpenCNC profile JSON or clear the profile.
- **No notification:** verify Windows notification permissions. The dashboard and SQLite history remain authoritative.
- **Stop completely:** use **Exit** in the tray menu. Closing only the window is intentional background behavior.

## Developer build

Use Node 24 and pnpm 11.19.0:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm agent:dev
pnpm agent:package:win
```

`pnpm agent:package:win` creates `release/OpenCNC-Local-Agent-Setup.exe`. `electron-builder.yml` defines an x64 assisted NSIS installer; Electron 44 bundles the application runtime. `release/` is generated and ignored by Git.

The Windows workflow performs a clean full-history checkout, frozen install, production dependency audit, type-check, full suite (including real Windows exclusive-lock and long-path tests), fresh installer build, embedded commit verification, post-signing SHA-256 generation, and artifact upload. It also builds the immutable feature-complete checkpoint, silently installs it, seeds persisted settings/retry/interrupted-job state, upgrades in place to the current build, runs the installed executable's smoke mode, verifies the SQLite migration and packaged ASAR, then silently uninstalls. The test requires binaries and the login-start registry value to be removed while history/log/user data remain preserved.

## Verification boundary

Automated cross-platform tests cover stable/partial/changing exports, manual output edits, atomic replacement, persistent retries, interrupted jobs, deleted/renamed projects, multiple projects, empty folders, Unicode/case collisions, spaces, simulated parent-share loss/reconnect, and injected transient I/O failures. Windows CI additionally exercises a path beyond the legacy 260-character limit and real exclusive locks on both CIX and BPP files.

The following still require the real CNC Windows computer: login startup across an actual logout/reboot; tray/notification UX under that computer's policy; the real exporter timing pattern; the real network/share identity and reconnect behavior; antivirus/SmartScreen interaction; installer/uninstaller permissions under the production account; and BiesseWorks import/simulation of every resulting BPP. Follow [the production-machine validation checklist](windows-production-validation.md). No automated test claims physical machine safety.

## Restore the pre-agent checkpoint

The immutable restore tag is `pre-windows-agent`. First save or discard any unrelated uncommitted work. To inspect/run that checkpoint without moving a branch:

```sh
git fetch origin --tags
git switch --detach pre-windows-agent
```

Return to Local Agent development with:

```sh
git switch feature/windows-local-agent
```

To abandon the Local Agent work and point local `main` exactly at the checkpoint (this discards uncommitted files, so use it only deliberately):

```sh
git fetch origin --tags
git switch main
git reset --hard pre-windows-agent
```
