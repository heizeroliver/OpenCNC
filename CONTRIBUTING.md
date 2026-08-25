# Contributing to OpenCNC

OpenCNC is at the beginning of its format-discovery phase. Contributions that improve safe, read-only understanding of woodworking CNC files are welcome.

## Before contributing a fixture

Only submit CNC files that you have permission to redistribute publicly. Remove customer names, job numbers, pricing, network paths, and other sensitive data. State the fixture's provenance and redistribution permission in your pull request.

If a production file cannot be published, use it locally to create a minimal synthetic reproduction of the relevant format behavior.

## Development

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

Please add tests for parser behavior and preserve unknown records instead of silently discarding them. Do not add G-code generation, machine-control output, or code that executes input files.

By contributing, you agree that your contribution is licensed under Apache-2.0.

