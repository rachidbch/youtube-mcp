# Contributing

## Development setup

Use Node.js 22.21.0 or newer. CI checks Node 22.21.0 and Node 24.

```bash
npm ci
npm run check
```

Tests must not call YouTube. Replace `globalThis.fetch` with the fakes in `test/helpers.mjs`. Preserve the [v1 compatibility contract](docs/v1-compatibility.md) unless a change is explicitly planned as breaking.

## Pull requests

Keep changes focused, add tests for behavior changes, and update the README or changelog when user-facing behavior changes. Run `npm run check` before opening a pull request.

Release preparation follows [RELEASE.md](RELEASE.md). A release pull request may prepare version metadata and notes, but it must not create or push the release tag. Tagging and publication require separate approval for the exact version and commit.

Report security problems through the process in `SECURITY.md`, not a public issue.
