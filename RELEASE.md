# Release guide

Releases are prepared in the repository and published by
`.github/workflows/release.yml` from an explicitly approved `v*` tag. The
workflow publishes in this order: npm, MCP Registry, then GitHub Releases.

Publishing npm and MCP Registry versions is irreversible. Preparing a release
does not authorize creating or pushing its tag.

## First release (1.0.0)

npm only allows a trusted publisher on a package that already exists, so the
first version is published manually. The workflow then verifies it and
publishes the MCP Registry entry and the GitHub release.

1. Prepare, review, and merge the release as described below. Record approval
   for the version, commit, tag, and publication.
2. From a clean checkout of the approved `main` commit, with 2FA enabled on the
   npm account:

   ```bash
   git switch main
   git pull --ff-only
   git status --short          # must print nothing
   git rev-parse HEAD          # must equal the approved commit
   npm ci
   npm login
   npm publish                 # prepack builds dist/; npm records gitHead
   npm view @granitebps/youtube-mcp@1.0.0 gitHead   # must equal the approved commit
   ```

3. Create and push the tag (see [Record approval and create the tag](#record-approval-and-create-the-tag)).
   The publishing job finds the existing npm version, accepts it only because
   its `gitHead` matches the tag commit, and continues with the MCP Registry and
   GitHub release.

npm 1.0.0 therefore has no provenance attestation. Later versions published by
the workflow do.

## One-time repository setup (before 1.0.1)

1. In npm package settings for `@granitebps/youtube-mcp`, configure a trusted
   GitHub Actions publisher for repository `granitebps/youtube-mcp` and workflow
   filename `release.yml`. Under **Allowed actions**, explicitly select
   `npm publish`. Do not configure an npm token. A new configuration expires
   unless it completes a publish within 2 days, so add it when the 1.0.1 tag is
   about to be pushed.
2. Optionally set the package's publishing access to require 2FA and disallow
   tokens once trusted publishing has worked.
3. Keep GitHub Actions enabled with permission to create releases. The workflow
   grants `id-token: write` and `contents: write` only to its publishing job.
4. Protect `main` after the CI jobs have passed on GitHub. Require the
   deterministic check, package checks, production audit, and release preflight;
   require current branches, resolved conversations, and linear history; block
   force-pushes and branch deletion.

These settings are remote administration tasks and are not changed by the
repository files.

## Prepare a candidate

Use Node.js 22.21.0 or newer. Start from the exact `main` commit intended for
release with a clean worktree.

1. Choose the version according to semantic versioning and the
   [v1 compatibility contract](docs/v1-compatibility.md).
2. Update the version in `package.json`, `package-lock.json`, and `server.json`.
3. Add the matching entry to `CHANGELOG.md`.
4. Add `docs/release-notes-vX.Y.Z.md`. This file is the exact GitHub release
   body and must describe installation, notable changes, known limitations, and
   any compatibility impact.
5. Review the complete diff and confirm that it contains no credentials.

The release contract checker requires all package and Registry metadata to
match. On a tag, it also requires the tag to equal `v` plus the package version
and requires the corresponding release-notes file.

## Verify without publishing

Run the same deterministic checks used by CI:

```bash
npm ci
npm run check
npm audit --omit=dev --audit-level=high
mcp-publisher validate
git diff --check
```

Review the packed file list from `npm pack --dry-run`. It must contain the
compiled server, README, license, `package.json`, and `server.json`; it must not
contain credentials, `.env` files, tests, sources, or maintainer documentation.

Run a short live smoke against YouTube from the built server (for example,
`get_video_info` and `get_video_transcript` on a known video). CI never calls
YouTube.

Open the pull request and wait for CI and the release preflight to pass. The
preflight checks the exact commit, installs and exercises the npm tarball, and
validates `server.json` with a checksum-pinned MCP Publisher. Pull requests and
ordinary branch pushes cannot enter the publishing job.

## Record approval and create the tag

Before tagging, record approval for all four of these values:

- version;
- exact commit SHA;
- tag name;
- authorization to publish npm, MCP Registry, and GitHub releases.

Then tag the approved commit without moving or recreating an existing release
tag:

```bash
git switch main
git pull --ff-only
git status --short
git rev-parse HEAD
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

The tag push runs reusable CI and the release preflight before the publishing
job. The workflow checks out `github.sha`, confirms that the tag points to that
commit, and checks version-specific metadata again.

## Publication and reruns

The publishing job uses npm trusted publishing with GitHub OIDC. It verifies the
public package and its `gitHead` before continuing. It then creates a Registry
publication document bound to the triggering commit, uses GitHub OIDC for the
MCP Registry, and finally creates the GitHub release from the tag-specific
notes.

If a run fails after publishing one destination, rerun the workflow for the
same immutable tag. Each step accepts an existing version only when its public
metadata matches the approved version, package, transport, and commit. Never
move the tag, reuse the version for different code, or retry with a different
commit.

If an existing npm version or Registry entry does not match, stop. Choose a new
patch version, fix the metadata, repeat review and approval, and create a new
tag. If a published npm version has a serious problem, deprecate it with a
specific message directing users to the fixed version; do not unpublish or
overwrite it.

## Verify the release

After the workflow succeeds:

1. Confirm npm serves `@granitebps/youtube-mcp@X.Y.Z`, its `gitHead` equals the
   approved commit, and the `latest` tag is correct. From 1.0.1 on, confirm npm
   displays provenance.
2. From a temporary directory, run the exact published version and use MCP
   Inspector to list tools and call `get_video_info`:

   ```bash
   release_test_dir=$(mktemp -d)
   cd "$release_test_dir"
   npx -y @modelcontextprotocol/inspector@latest --web \
     npx -y @granitebps/youtube-mcp@X.Y.Z
   ```

3. Confirm the MCP Registry lists
   `io.github.granitebps/youtube-mcp@X.Y.Z` with the matching npm package and
   `stdio` transport.
4. Confirm the GitHub release and tag both point to the approved commit and the
   release body matches `docs/release-notes-vX.Y.Z.md`.
