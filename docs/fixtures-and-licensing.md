# Fixtures and licensing

Real-world compatibility work needs representative BPP and CIX fixtures with permission to use them for development and testing.

Before adding a production file, confirm whether it may be:

1. kept locally and never committed;
2. anonymized and committed as a regression fixture; or
3. redistributed under the repository's Apache-2.0 license.

Remove customer names, job numbers, material pricing, network paths, and other sensitive metadata. A public fixture must include provenance and explicit redistribution permission.

Private fixtures belong outside the repository or in the ignored `fixtures/private/` directory. Public synthetic fixtures must be written independently and clearly labeled as synthetic.
