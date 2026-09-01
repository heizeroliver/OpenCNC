# Windows Authenticode signing readiness

OpenCNC's Windows workflow is ready to consume a real Authenticode identity, but the repository contains no certificate or private key. An unsigned build is a development/release-candidate artifact and may show **Unknown publisher** or a SmartScreen warning. A self-signed certificate is not a substitute for a publicly trusted production identity.

## Recommended identity

Obtain one of the following for the organization that will publish OpenCNC:

- an OV Authenticode code-signing certificate from a public CA, exported as a password-protected `.pfx` for CI;
- an EV certificate whose non-exportable key is available through a supported hardware/HSM signing method; or
- Azure Trusted Signing when the publisher meets Microsoft's eligibility and operational requirements.

OV certificates normally need time to build SmartScreen reputation. EV and Azure Trusted Signing can provide immediate reputation, subject to Microsoft's current policies. The certificate subject is the publisher identity; do not add a guessed `publisherName` to `electron-builder.yml`. Once the real certificate is selected, record its exact subject and decide whether updater signature verification should pin that subject.

References: [electron-builder code signing](https://www.electron.build/docs/features/code-signing/) and [Windows code signing](https://www.electron.build/docs/features/code-signing/code-signing-win/).

## GitHub Actions secrets

For a CI-compatible OV `.pfx`, configure these encrypted repository or protected-environment secrets:

- `WIN_CSC_LINK`: the base64-encoded `.pfx` contents, a protected HTTPS URL, or another electron-builder-supported certificate location;
- `WIN_CSC_KEY_PASSWORD`: the certificate's private-key password.

The workflow passes those values only to the current installer build. electron-builder signs the application executables and NSIS installer automatically when the values are present. When they are absent, the same workflow deliberately continues as an unsigned validation build and records the signature state. No certificate, encoded certificate, password, client secret, or private key belongs in Git, an artifact, a log, or `SHA256SUMS.txt`.

For Azure Trusted Signing, use electron-builder's Azure signing configuration and protected `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` values instead. That is a separate credential path and should be introduced only after the Azure account, certificate profile, and release environment are known.

## Release policy

Before distributing a production installer:

1. Restrict signing secrets to a protected GitHub environment and trusted tag/ref policy.
2. Build from the intended immutable tag with a clean checkout.
3. Require the workflow's installer and installed-executable signature checks to report `Valid`.
4. Generate SHA-256 only after signing; signing changes the bytes.
5. Retain the CI run, commit, tag, artifact reference, exact byte size, and checksum together.
6. Test SmartScreen and publisher presentation on a clean Windows machine.

The workflow does not set `forceCodeSigning` globally because pull requests and ordinary branch validation must remain buildable without secrets. A protected production-release job should either provide signing credentials and keep the existing `Valid` assertions, or set `forceCodeSigning: true` in a release-only configuration.

## Verification on Windows

Run these checks on the exact downloaded artifact and the installed executable:

```powershell
Get-FileHash .\OpenCNC-Local-Agent-Setup.exe -Algorithm SHA256
Get-AuthenticodeSignature .\OpenCNC-Local-Agent-Setup.exe | Format-List Status,StatusMessage,SignerCertificate,TimeStamperCertificate
Get-AuthenticodeSignature "$env:LOCALAPPDATA\Programs\OpenCNC Local Agent\OpenCNC Local Agent.exe" | Format-List Status,StatusMessage,SignerCertificate,TimeStamperCertificate
```

Both Authenticode checks must report `Valid` for a signed production candidate. Inspect the signer subject and timestamp certificate; do not accept `NotSigned`, `UnknownError`, `HashMismatch`, an expired un-timestamped signature, or a subject different from the approved publisher.
