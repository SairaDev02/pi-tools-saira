# pi-provider-switch

Provider and model switching commands for the [Pi coding agent](https://pi.dev):

- `/provider` — switch the active provider and persist it as the default
- `/switch-provider` — alias of `/provider` (both share one handler, so a fix can never silently miss one)
- `/models` — list and switch models, optionally persisting a default

## Install

```bash
# from npm (after publishing)
pi install npm:pi-provider-switch

# or copy the single file into your global extensions dir
cp src/provider-switch.ts ~/.pi/agent/extensions/
```

Then `/reload` (or restart).

## Usage

```text
/provider                          interactive picker of providers (sets default)
/provider nano-gpt                 switch to nano-gpt's first model (sets default)
/provider deepseek/v4              switch to a specific model (sets default)
/provider nano-gpt --no-default    switch without touching settings.json

/models                            interactive picker of all models (no persist)
/models nano-gpt                   interactive picker of that provider's models
/models deepseek/v4                direct switch to deepseek-v4-flash
/models qwen3.5-27b                fuzzy switch to first matching model
/models nano-gpt --default         switch AND save as default in settings.json
```

**Tab-completions** are provided for all three commands (provider ids; `provider/model` pairs for `/models`), read from the persisted catalog in `~/.pi/agent/models-store.json` (the same file Pi refreshes into). If the store is missing or a provider hasn't refreshed yet, completions simply don't appear.

## Behavior notes

- **Persistence** is atomic (temp-file + rename into `settings.json`): `defaultProvider` / `defaultModel`.
- The agent dir is `~/.pi/agent` by default; override with the `PI_CODING_AGENT_DIR` env var.
- On a failed switch, you get a clear message: no API key for the provider (run `/login`) or the model not usable in the current scope.

## Requirements

- Pi coding agent (extension API)

## License

MIT — see [LICENSE](./LICENSE).
