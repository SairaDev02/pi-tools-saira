# npm publishing

The six extensions are separate, unscoped public npm packages. Each package has its own pinned development dependencies, lockfile, `npm test`, `npm run typecheck`, and `prepublishOnly` checks. The allowlisted tarballs contain only the package manifest, extension source, README, license, and tests.

## Current release: 0.1.0

All six packages are published at `0.1.0`. Verify an exact version before retrying any interrupted release:

```sh
npm view pi-ci-status@0.1.0 version
npm view pi-deepseek-hours@0.1.0 version
npm view pi-nano-gpt-provider@0.1.0 version
npm view pi-provider-switch@0.1.0 version
npm view pi-review-debt@0.1.0 version
npm view pi-verify-gate@0.1.0 version
```

The bootstrap publish required npm browser/2FA approval. If a publish returns `EOTP`, complete the browser challenge from your terminal or use `npm login --auth-type=web`, then retry only versions confirmed absent by `npm view`. Publishes are non-atomic: stop after a failure, check every package version, and never try to overwrite a published version. Do not put npm passwords, OTPs, or write tokens in the repository or chat. These unscoped packages are public by default and do not need `--access public`.

## Trusted publishing for future releases

The npm [trusted publisher](https://docs.npmjs.com/trusted-publishers/) setup is attached to an existing package. Configure a GitHub Actions trusted publisher for each package at npmjs.com, using:

- GitHub user/organization: `SairaDev02`
- Repository: `pi-tools-saira`
- Workflow filename: `publish.yml`
- Allowed action: direct `npm publish` (the workflow does not use staged publishing)

The package `repository.url` values match the public GitHub repository. Subsequent releases from the public repository's GitHub Actions workflow receive npm provenance automatically through OIDC; the workflow uses no long-lived npm token.

Do not push a `v0.1.0` tag: all six `0.1.0` versions are already live, and the tag-triggered workflow would attempt to publish them again. Configure trusted publishing for each package before the next release.

## Subsequent releases

1. Update all six package versions together. The release tag must match every manifest version. From each package directory, `npm version <version> --no-git-tag-version` updates both `package.json` and its lockfile.
2. Run `npm ci` and `npm run prepublishOnly` in each package, review `npm pack --dry-run`, then commit and merge the release to `main`.
3. Create and push the matching tag (for example, `v0.1.1`). The [`publish.yml`](.github/workflows/publish.yml) workflow checks all six packages before publishing any of them, then publishes them sequentially with OIDC.

A multi-package npm release cannot be atomic: if the registry or publisher configuration fails partway through publication, some packages may already be live. Check the exact published versions before retrying; do not try to overwrite a version.
