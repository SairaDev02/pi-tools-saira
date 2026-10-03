# pi-tools-saira

Five self-contained Pi extensions, each published as its own npm package from this one repo. There is no root workspace and no shared build: every change lives inside one `pi-*/` package. Vocabulary is defined in `CONTEXT.md`; each package's `README.md` documents its own usage, env vars, and tests.

## Work in one package

1. `cd` into the package you are changing and `npm ci`.
2. Edit that package's single `src/<name>.ts`.
3. Run the gate: `npm run prepublishOnly` (it runs `npm test` then `npm run typecheck`).

Done when the gate is green and the test counts and case lists in this package's `README.md` and the root `README.md` match.

## Invariants

The repo's design constraints. A change that breaks one is a bug.

- **One extension, one file.** The extension is its `src/<name>.ts`, and the published artifact is that source, so the extension must stay runnable as-is. Move the file and its `pi.extensions` manifest entry together.
- **Host packages are peers.** Declare any host-provided package a package imports (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`) in `peerDependencies` with `"*"`, never in `dependencies`, so Pi supplies a single module instance.
- **Keep the tested-against pin current.** `devDependencies` pins the exact `@earendil-works/pi-coding-agent` version the package is checked against; bump it when Pi releases and re-run the gate. `peerDependencies` stays `"*"`.
- **Badges cost zero tokens.** The footer badges in `pi-ci-status`, `pi-verify-gate`, and `pi-deepseek-hours` render from gathered state with no model call.
- **Absorb I/O failures.** Wrap each external call (`gh`, `git`, filesystem, HTTP) so a failure returns a neutral value and never throws into the agent loop. A broken dependency then degrades the extension, not the session.
- **Tests run offline.** Exercise real behavior against local shims, temp repos, and stubbed `fetch` on plain Node's type stripping (Node ≥22.19), with no network.

## Releasing

Respect **release coupling**: all five packages share one version and ship together from one tag, so no package releases alone. Follow `PUBLISHING.md` for the version, tag, and trusted-publishing flow.
