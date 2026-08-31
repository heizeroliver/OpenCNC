# OpenCNC Local Agent for Windows

OpenCNC Local Agent is the unattended, local Windows workflow for folders exported by a CNC/CAD program. It monitors every immediate project folder below one selected parent directory, waits for top-level CIX files to stop changing, and then uses OpenCNC's existing guarded converter to create or update that project's `BPP` directory. Selecting a project in the browser viewer is not required.

The application runs in the Windows notification area (system tray), keeps its settings and retry state across logout/reboot, and includes its own Electron/Node runtime. The target computer does not need Node.js, pnpm, Python, a developer terminal, or this Git repository.

> Converted programs still require inspection and simulation in the vendor software. The agent verifies the supported file semantics and expanded geometry; it cannot validate the physical machine, clamps, tooling, controller behavior, or collisions.

## Install

The Windows build is produced by `.github/workflows/windows-agent.yml` on a real `windows-latest` GitHub runner.

1. Open the repository's **Actions** page and select **Windows Local Agent**.
2. Open the latest successful run for `main` or `feature/windows-local-agent`.
3. Download the `OpenCNC-Windows-Installer` artifact.
4. Extract it and run `OpenCNC-Local-Agent-Setup.exe`.
5. Follow the install wizard. It supports a per-user install, a selectable installation directory, Start Menu/Desktop shortcuts, and normal Windows uninstall.

Development builds are not code-signed. Windows SmartScreen may therefore ask for confirmation. A production release should be Authenticode-signed before wide deployment.

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

Only top-level `.cix` files in the parent itself or its immediate project directories are candidates. Empty folders, hidden folders, nested grandchildren, and `BPP` output directories are ignored. If `Door_f0.cix` and `Door_f1.cix` form the supported two-sided pair, the canonical converter can merge them into one BPP with the verified operator-reposition wait boundary.

The agent requires two identical scans by default. The fingerprint contains case-normalized filename, byte size, and modification time. A file is also checked after it is read; if it changed during the read, the attempt fails temporarily and retries instead of converting a partial export.

## Tray controls

The tray icon color and menu show one of these states:

- **Running** — monitoring normally.
- **Paused** — configuration remains saved, but scans are disabled.
- **Processing** — scanning or converting.
- **Warning** — a permanent guarded-conversion block or filename/manual-edit conflict needs attention.
- **Error** — a temporary filesystem or monitored-folder failure will retry.

The tray menu opens the full OpenCNC viewer or Local Agent dashboard, opens the monitored folder, pauses/resumes automation, runs an immediate scan, changes the folder, shows recent jobs/errors, opens settings, controls **Start with Windows**, or exits the process. Closing the window leaves the tray agent running; choose **Exit** from the tray to stop it completely.

## Settings

The following are stored locally:

- parent projects folder;
- BPP output folder name;
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

A missing/unavailable parent directory has its own bounded exponential backoff. Notifications are emitted on the first and third consecutive folder failure, then a recovery notification appears when the folder reconnects. Project failures notify on the first and third attempt, avoiding a notification on every poll.

Retry observations are saved to SQLite after every scan. If Windows closes the process while a job is marked `converting`, startup marks that history entry as interrupted/retrying and safely reevaluates it. Atomic same-directory temporary-file replacement prevents a half-written BPP from becoming the production filename. Report and manifest files are written last.

## Conflicts and manual BPP protection

Conflicts do not retry until the CIX fingerprint changes or the operator resolves the condition:

- `PartA.cix` and `parta.cix`, or Unicode-equivalent filename forms, are rejected because Windows would treat their destinations as the same name;
- colliding BPP output names are rejected before any production output is written; and
- an existing BPP is updated only when its SHA-256 checksum still equals the checksum in the previous OpenCNC manifest.

If an operator or BiesseWorks has edited a generated BPP, OpenCNC leaves it untouched and marks the whole project `conflicted`. The agent never deletes orphaned BPP files automatically. Resolve a conflict by reviewing/renaming the source collision or deliberately moving the edited output elsewhere; never delete an important production edit merely to silence the warning.

## Local history, database, and logs

The dashboard reads local SQLite history containing job ID, project and fingerprint, source/output names, timestamps, lifecycle status, retry count, input/output SHA-256 values, QA flag, forward/reverse verification, and the last message. The database also stores configuration and serialized retry observations.

By default, Electron stores these under:

```text
%APPDATA%\OpenCNC Local Agent\
  opencnc-agent.sqlite
  opencnc-agent.sqlite-wal
  opencnc-agent.sqlite-shm
  opencnc-agent.log
  opencnc-agent.log.previous
```

Use **Settings → Open data and logs folder** to open the actual location. Logs rotate at approximately 5 MB. Uninstall does not delete application data automatically, so history is not silently destroyed. Delete it manually only after making any desired backup and while the agent is exited.

## Notifications

Notifications are intentionally limited to conflicts, blocked conversions, first/repeated temporary failures, important recoveries, and optionally ordinary successful conversions. Windows notification settings can disable banners without disabling the agent.

## Troubleshooting

- **No project appears:** confirm CIX files are directly inside the selected parent or one immediate child folder. Nested files are intentionally ignored.
- **Agent remains in Setup:** choose and save a parent folder.
- **Agent is Paused:** select **Resume automation** from the tray or enable automation in Settings.
- **Folder unavailable:** confirm the drive/share is connected and the installed user's account can list/read it. The agent retries automatically.
- **Locked-file retries:** close the exporter/vendor program if it holds an exclusive lock. OpenCNC will continue from persisted retry state.
- **Conflict:** open Errors/Recent jobs and inspect the message. Check case-only names, Unicode-equivalent names, and manually edited BPP files.
- **Blocked conversion:** the converter could not prove all guarded round trips. No BPP was written; inspect the conversion report/source and add a verified format fixture before extending conversion support.
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

The Windows workflow installs frozen dependencies, type-checks, runs the full test suite (including real Windows exclusive-lock and long-path tests), builds the installer, checks that it exists and is nontrivial, prints its SHA-256, and uploads it as `OpenCNC-Windows-Installer` for 30 days. macOS/Linux-compatible tests remain in the regular CI workflow.

## Verification boundary

Automated cross-platform tests cover stable/partial/changing exports, manual output edits, atomic replacement, persistent retries, interrupted jobs, deleted/renamed projects, multiple projects, empty folders, Unicode/case collisions, spaces, simulated parent-share loss/reconnect, and injected transient I/O failures. Windows CI additionally exercises a path beyond the legacy 260-character limit and real exclusive locks on both CIX and BPP files.

The following still require the real CNC Windows computer: login startup across an actual logout/reboot; tray/notification UX under that computer's policy; the real exporter timing pattern; the real network/share identity and reconnect behavior; antivirus/SmartScreen interaction; installer/uninstaller permissions; and BiesseWorks import/simulation of every resulting BPP. No automated test claims physical machine safety.

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
