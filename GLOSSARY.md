# pi-tools-saira

Five independent Pi extensions published as separate npm packages from one repository. This glossary fixes the vocabulary shared across all five packages.

## Language

**Extension**:
A single-file TypeScript module that Pi loads to register tools, commands, event handlers, or UI for one capability.
_Avoid_: plugin, addon, module

**Package**:
One npm-published unit in this repo, shipping exactly one extension plus its README, tests, and license.
_Avoid_: tool, library

**Badge**:
The compact zero-token indicator an extension renders in Pi's footer via `ctx.ui.setStatus`; it consumes no model context.
_Avoid_: status bar, HUD, widget

**Edge-triggered delta**:
One line injected into the model context only when a watched signature transitions (for example CI green→red), never on every turn.
_Avoid_: notification, poll, heartbeat

**Tested-against pin**:
The exact `@earendil-works/pi-coding-agent` version in a package's `devDependencies` that its `npm ci` and `prepublishOnly` checks compile and run against. It is independent of the package's `peerDependencies` range, which only declares what the host may provide.
_Avoid_: host version, current stable

**Release coupling**:
The rule that all five packages share one version and are published together by `publish.yml`, so no package can be released alone.
_Avoid_: monorepo release, lockstep versioning
