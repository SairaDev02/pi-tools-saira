# npm publishing

The five extensions are separate, unscoped public npm packages. Each package has its own pinned development dependencies, lockfile, `npm test`, `npm run typecheck`, and `prepublishOnly` checks. The allowlisted tarballs contain only the package manifest, extension source, README, license, and tests.

## Current release: 0.2.0

All five packages are published at `0.2.0`. Verify an exact version before retrying any interrupted release:

```sh
npm view pi-ci-status@0.2.0 version
npm view pi-deepseek-hours@0.2.0 version
npm view pi-nano-gpt-provider@0.2.0 version
npm view pi-review-debt@0.2.0 version
npm view pi-verify-gate@0.2.0 version
```

Publishes are non-atomic: stop after a failure, check every package version, and never try to overwrite a published version. Do not put npm passwords, OTPs, or write tokens in the repository or chat. These unscoped packages are public by default and do not need `--access public`.

## Trusted publishing

Each package has a GitHub Actions trusted publisher at npmjs.com:

- GitHub user/organization: `SairaDev02`
- Repository: `pi-tools-saira`
- Workflow filename: `publish.yml`
- Environment: none — the publish job declares no `environment:`, so do not create the trusted publisher with one
- Allowed action: direct `npm publish` (the workflow does not use staged publishing)

Verify them with `npm trust list <package>` after `npm login --auth-type=web`; create a missing one with `npm trust github <package> --file publish.yml --repo SairaDev02/pi-tools-saira --allow-publish`. The package `repository.url` values match the public GitHub repository, and releases from its GitHub Actions workflow receive npm provenance automatically through OIDC; the workflow uses no long-lived npm token.

## Subsequent releases

1. Update all five package versions together. The release tag must match every manifest version. From each package directory, `npm version <version> --no-git-tag-version` updates both `package.json` and its lockfile.
2. Run `npm ci` and `npm run prepublishOnly` in each package, review `npm pack --dry-run`, then commit and merge the release to `main`.
3. Create and push the matching tag (for example, `v0.2.1`). The [`publish.yml`](.github/workflows/publish.yml) workflow checks all five packages before publishing any of them, then publishes them sequentially with OIDC.

A multi-package npm release cannot be atomic: if the registry or trusted-publisher configuration fails partway through publication, some packages may already be live. Check the exact published versions before retrying; do not try to overwrite a version.

If the tag-triggered workflow fails after some packages are live, re-running it retries all five and fails on the already-published versions. Recover by publishing only the missing packages locally: `npm login --auth-type=web` (browser/2FA may return `EOTP`), then `npm publish` from each missing package directory after confirming its version is absent with `npm view`.
