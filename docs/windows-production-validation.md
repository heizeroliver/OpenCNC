# OpenCNC Windows production-machine validation

Use this checklist on the actual Windows account, storage path, exporter, BiesseWorks installation, and CNC workflow. Complete it with a release-candidate installer built from one immutable tag. A CI pass is only permission to begin this validation; it is not approval to machine production material.

## Test record

- Date/operator: ____________________
- Windows computer/account: ____________________
- RC tag and full commit: ____________________
- Installer filename: ____________________
- Expected SHA-256: ____________________
- Observed SHA-256: ____________________
- Authenticode signer/status: ____________________
- Parent projects folder/share: ____________________
- BiesseWorks version/machine profile: ____________________

For every step, mark exactly one result and write evidence or a reason for failure. Stop the validation when a safety invariant fails.

## A. Installation

1. Compare the downloaded installer's SHA-256 with `SHA256SUMS.txt`.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
2. Inspect **Properties → Digital Signatures** or `Get-AuthenticodeSignature`. Record expected unsigned-RC SmartScreen behavior or verify the approved production signer.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
3. Run the assisted per-user installer and confirm the product name, destination, Start Menu/Desktop shortcuts, and first startup.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
4. Confirm one OpenCNC tray icon appears and the Local Agent opens to Settings on first run.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
5. Open the data/log folder from the tray and confirm `opencnc-agent.sqlite` and `opencnc-agent.log` exist.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
6. Confirm the displayed version and commit match the tested tag/artifact record.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
7. Re-run the same/newer installer over the installation. Confirm settings/history remain. Uninstall and confirm program binaries/startup entry disappear while `%APPDATA%\OpenCNC Local Agent` remains available for recovery; then reinstall for the remaining tests.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
8. Switch the Local Agent to Hungarian, restart it, and confirm the window and tray remain Hungarian. Switch back to English and confirm that choice also persists.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________

## B. Startup and single instance

1. Enable **Start with Windows**, sign out/in, and confirm the tray agent starts without a developer terminal.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
2. Reboot Windows and confirm it starts again with the saved settings.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
3. Launch the shortcut a second time and confirm it focuses the existing agent rather than creating a second processor/tray instance.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
4. Disable **Start with Windows**, sign out/in, and confirm the login-start behavior is removed.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________

## C. Real project folder

1. Select the actual parent projects folder. Confirm the complete nested folder tree appears and every directory that already existed at selection time is marked as existing/not enrolled.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
2. Export a known non-production test project into a newly created directory, at least two levels below the parent, containing several CIX files.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
3. Observe at least one `waiting_for_stability` state before conversion. Confirm no project selection or open browser is required.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
4. Confirm the project's `<project-name>_bpp` folder contains every expected BPP plus `opencnc-sync-manifest.json` and `opencnc-conversion-report.json`; if QA is enabled, confirm its PDFs.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
5. Confirm Recent Jobs shows source/output names, completed status, checksums, and verified forward/reverse results.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
6. Leave unchanged exports in place for several scan cycles. Confirm no duplicate conversion/job/notification occurs.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
7. Confirm every input CIX retains its original name and byte-for-byte SHA-256, then delete one disposable generated BPP. Without editing any CIX, confirm OpenCNC recreates the missing BPP on a later scan.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________

## D. File locking and retry

1. While exporting a test file, hold its CIX open with an exclusive lock. Confirm conversion reports a retry and no BPP is created/changed.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
2. Release the CIX lock without editing the file. Confirm the persisted retry succeeds automatically.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
3. After a safe baseline conversion, hold the BPP open exclusively, change its CIX, and trigger conversion. Confirm the original BPP remains byte-for-byte intact and no `.opencnc-*.tmp` remains.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
4. Release the BPP lock without another source edit. Confirm retry succeeds with the normal checksum protections.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________

## E. Manual BPP protection

1. Back up a generated test BPP, then deliberately add a recognizable manual edit in BiesseWorks or a text editor.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
2. Change/re-export its CIX so a new conversion is eligible. Confirm OpenCNC reports a visible conflict and does not alter the manually edited BPP.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
3. Restart OpenCNC and confirm the conflict remains visible and still cannot bypass overwrite protection.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________

## F. Restart during work

1. Using disposable test files, terminate the agent while a conversion is in progress or while history says `converting`.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
2. Restart it. Confirm history describes interrupted recovery, the job is safely reevaluated, and no truncated BPP or temporary file is accepted as completed.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
3. Confirm a manually edited output remains protected during the restart recovery attempt.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________

## G. Network folder, if used

If production uses only a local disk, mark this section N/A and explain.

1. Connect using the production SMB path and Windows identity; confirm list/read/write permissions and normal conversion latency.
   Result: [ ] PASS [ ] FAIL [ ] N/A — Notes: ____________________
2. Disconnect the share temporarily. Confirm bounded backoff, first/persistent failure notifications, no busy polling, and no output corruption.
   Result: [ ] PASS [ ] FAIL [ ] N/A — Notes: ____________________
3. Reconnect without editing CIX files. Confirm automatic recovery and conversion/retry resume.
   Result: [ ] PASS [ ] FAIL [ ] N/A — Notes: ____________________
4. Repeat while another OpenCNC instance/computer attempts the same project. Confirm only one project lock owns production writes and a stale abandoned lock recovers after its documented timeout.
   Result: [ ] PASS [ ] FAIL [ ] N/A — Notes: ____________________

## H. Filenames and paths

1. Convert known-safe names containing Hungarian accented characters and spaces.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
2. Test a path longer than 260 characters if the production exporter/share permits it.
   Result: [ ] PASS [ ] FAIL [ ] N/A — Notes: ____________________
3. In a disposable folder, present case-only names such as `PartA.cix` and `parta.cix`. Confirm a visible conflict and no output write.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
4. If the filesystem permits it, present composed/decomposed Unicode-equivalent names. Confirm a conflict rather than silent collision.
   Result: [ ] PASS [ ] FAIL [ ] N/A — Notes: ____________________

## I. BiesseWorks interoperability

Use known, non-production parts only.

1. Associate `.bpp` with the installed BiesseWorks version, complete a multi-output test conversion, and click **Send to BiesseWorks: …**. Record whether BiesseWorks actually loads every output; Windows accepting the handoff alone is not a pass.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
2. Temporarily remove/change the association or copy the outputs to a safe test account without it. Confirm OpenCNC reports the launch failure rather than claiming the files opened.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
3. Modify one disposable generated BPP after conversion and click the button. Confirm checksum validation blocks the entire launch batch; then restore/reconvert it.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
4. Import each generated BPP into the actual BiesseWorks version. Confirm it parses with no unexpected repair or dropped module.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
5. Inspect panel dimensions, face/origin, drills, routes/arcs, depths, diameters, tools, repeated operations, and operation ordering against the source/design.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
6. For an `_f0`/`_f1` pair, verify the single merged BPP and the exact operator-reposition `WAIT` boundary.
   Result: [ ] PASS [ ] FAIL [ ] N/A — Notes: ____________________
7. Run BiesseWorks simulation and compare the expected geometry/tooling with a trusted reference export.
   Result: [ ] PASS [ ] FAIL — Notes: ____________________
8. If File Explorer and OpenCNC both start a blank BiesseWorks editor, confirm **Open selected output folder** works and record the vendor-approved manual File → Open/Import procedure.
   Result: [ ] PASS [ ] FAIL [ ] N/A — Notes: ____________________

## J. CNC safety gate

1. A qualified operator reviews the BiesseWorks program and simulation under the shop's normal approval procedure.
   Result: [ ] PASS [ ] FAIL — Notes/signature: ____________________
2. Confirm correct material, orientation, zero/origin, tooling, clamps/workholding, clearances, feeds/speeds, and machine/controller setup independently of OpenCNC.
   Result: [ ] PASS [ ] FAIL — Notes/signature: ____________________
3. If the shop authorizes a test cut, use scrap/non-production material and the established guarded test procedure. Do not automatically machine merely because software tests passed.
   Result: [ ] PASS [ ] FAIL [ ] NOT RUN — Notes/signature: ____________________

## Final decision

- [ ] PASS — Approved by the responsible shop personnel for the explicitly tested workflow and environment.
- [ ] FAIL — Do not use for production; blockers: ________________________________________________

Operator: ____________________  CNC/safety approver: ____________________  Date: ____________________
