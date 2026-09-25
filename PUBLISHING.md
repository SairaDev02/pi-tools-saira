# npm publishing

The six extensions are separate, unscoped public npm packages. Each package has its own pinned development dependencies, lockfile, `npm test`, `npm run typecheck`, and `prepublishOnly` checks. The allowlisted tarballs contain only the package manifest, extension source, README, license, and tests.

## First publication

The initial publish must be run by an npm account authorized to claim these names. Verify each name immediately before publishing; a registry 404 means no published version was found, but does not reserve the name.

From a clean, reviewed release commit, log in interactively and publish each package. `npm publish` runs that package's tests and typecheck through `prepublishOnly` before publishing:

```sh
npm login
(cd pi-ci-status && npm ci && npm publish)
(cd pi-deepseek-hours && npm ci && npm publish)
(cd pi-nano-gpt-provider && npm ci && npm publish)
(cd pi-provider-switch && npm ci && npm publish)
(cd pi-review-debt && npm ci && npm publish)
(cd pi-verify-gate && npm ci && npm publish)
```

Do not put npm passwords, OTPs, or write tokens in the repository. These packages are unscoped, so they are public by default and do not need `--access public`. A version already published cannot be overwritten; check `npm view <name> version` if a publish is interrupted.

The npm [trusted publisher](https://docs.npmjs.com/trusted-publishers/) setup is attached to an existing package, so bootstrap each package once with an authenticated publish. Configure a GitHub Actions trusted publisher for every resulting package at npmjs.com, using:

- GitHub user/organization: `SairaDev02`
- Repository: `pi-tools-saira`
- Workflow filename: `publish.yml`
- Allowed action: direct `npm publish` (the workflow does not use staged publishing)

The package `repository.url` values match the public GitHub repository. Subsequent releases from the public repository's GitHub Actions workflow receive npm provenance automatically through OIDC; the workflow uses no long-lived npm token.

## Subsequent releases

1. Update all six package versions together. The release tag must match every manifest version. From each package directory, `npm version <version> --no-git-tag-version` updates both `package.json` and its lockfile.
2. Run `npm ci` and `npm run prepublishOnly` in each package, review `npm pack --dry-run`, then commit and merge the release to `main`.
3. Create and push the matching tag (for example, `v0.1.1`). The [`publish.yml`](.github/workflows/publish.yml) workflow checks all six packages before publishing any of them, then publishes them sequentially with OIDC.

A multi-package npm release cannot be atomic: if the registry or publisher configuration fails partway through publication, some packages may already be live. Check the exact published versions before retrying; do not try to overwrite a version.
