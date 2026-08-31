import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

/**
 * /provider — switch the active provider (persists as default).
 * /models   — list and switch to a specific model.
 *
 * Usage:
 *   /provider                      -> interactive picker of providers (sets default)
 *   /provider nano-gpt             -> switch to nano-gpt's first model (sets default)
 *   /provider deepseek/v4          -> switch to a specific model (sets default)
 *   /provider nano-gpt --no-default-> switch without touching settings.json
 *
 *   /models                        -> interactive picker of all models (no persist)
 *   /models nano-gpt               -> interactive picker of nano-gpt models
 *   /models deepseek/v4            -> direct switch to deepseek-v4-flash
 *   /models qwen3.5-27b            -> fuzzy switch to first matching model
 *   /models nano-gpt --default     -> switch AND save as default in settings.json
 *
 * /switch-provider is an alias of /provider — both share one handler so a fix
 * to one can never silently miss the other.
 */

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SETTINGS_FILE = join(AGENT_DIR, "settings.json");
const MODELS_STORE_FILE = join(AGENT_DIR, "models-store.json");

/** Write defaultProvider/defaultModel into settings.json (atomic). */
function persistDefault(provider: string, modelId: string): boolean {
  try {
    let settings: Record<string, unknown> = {};
    if (existsSync(SETTINGS_FILE)) {
      try {
        settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Record<string, unknown>;
      } catch {
        /* corrupt/unreadable — start fresh */
      }
    }
    settings.defaultProvider = provider;
    settings.defaultModel = modelId;
    mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
    const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    renameSync(tmp, SETTINGS_FILE);
    return true;
  } catch {
    return false;
  }
}

type Ctx = ExtensionCommandContext;
type ModelRef = Model<any>;

/**
 * Sync read of the persisted provider catalog (same source pi refreshes into
 * models-store.json). Used only for tab-completions, which receive no context —
 * best-effort: missing/unreadable store just yields no completions.
 */
interface StoreEntry {
  models?: Array<{ id: string }>;
}
function readProviderCatalog(): Record<string, StoreEntry> {
  try {
    return JSON.parse(readFileSync(MODELS_STORE_FILE, "utf-8")) as Record<string, StoreEntry>;
  } catch {
    return {};
  }
}

type Completion = { value: string; label: string };
const filterByPrefix = (items: Completion[], prefix: string): Completion[] =>
  items.filter((i) => i.value.toLowerCase().startsWith(prefix.toLowerCase()));

/** Provider-name completions (provider ids from the persisted catalog). */
function providerCompletions(prefix: string): Completion[] | null {
  const items = Object.keys(readProviderCatalog()).map((p) => ({ value: p, label: p }));
  const filtered = filterByPrefix(items, prefix);
  return filtered.length > 0 ? filtered : null;
}

/** Model completions: provider/model pairs plus bare provider ids. */
function modelCompletions(prefix: string): Completion[] | null {
  const catalog = readProviderCatalog();
  const items: Completion[] = [];
  for (const [provider, entry] of Object.entries(catalog)) {
    items.push({ value: provider, label: provider });
    for (const m of entry.models ?? []) {
      items.push({ value: `${provider}/${m.id}`, label: `${provider}/${m.id}` });
    }
  }
  const filtered = filterByPrefix(items, prefix);
  return filtered.length > 0 ? filtered : null;
}

export default function (pi: ExtensionAPI) {
  /** Switch model and optionally persist as default. */
  const applyModel = async (
    ctx: Ctx,
    model: ModelRef,
    persist: boolean,
  ): Promise<boolean> => {
    const ok = await pi.setModel(model);
    if (!ok) {
      ctx.ui.notify(
        `Could not switch to ${model.provider}/${model.id}: no API key for this ` +
          `provider, or the model is not usable in the current scope. ` +
          `Run /login to add a key.`,
        "warning",
      );
      return false;
    }
    if (persist) {
      const saved = persistDefault(model.provider, model.id);
      ctx.ui.notify(
        `Default: ${model.provider}/${model.id}${saved ? "" : " (settings write failed)"}`,
        saved ? "info" : "warning",
      );
    } else {
      ctx.ui.notify(`Model: ${model.provider}/${model.id}`, "info");
    }
    return true;
  };

  /** Build provider -> models lookup from the registry. */
  const groupByProvider = (ctx: Ctx) => {
    const byProvider = new Map<string, ModelRef[]>();
    for (const m of ctx.modelRegistry.getAvailable()) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return byProvider;
  };

  const resolveModel = (
    ctx: Ctx,
    provider: string,
    modelPrefix?: string,
  ): ModelRef | undefined => {
    const byProvider = groupByProvider(ctx);
    const providerModels = byProvider.get(provider) ?? [];
    if (providerModels.length === 0) return undefined;
    if (modelPrefix) {
      const q = modelPrefix.toLowerCase();
      return providerModels.find((m) => m.id.toLowerCase().includes(q));
    }
    const currentId = ctx.model?.id;
    return (
      (currentId ? providerModels.find((m) => m.id === currentId) : undefined) ??
      providerModels[0]
    );
  };

  // ---------------------------------------------------------------------------
  // Shared handler for /provider and its alias /switch-provider
  // ---------------------------------------------------------------------------
  const handleProviderCommand = async (rawArgs: string, ctx: Ctx) => {
    const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
    const persist = !parts.includes("--no-default") && !parts.includes("--no-persist");
    const query = parts.filter((p) => !p.startsWith("--")).join(" ").trim();

    const byProvider = groupByProvider(ctx);
    if (byProvider.size === 0) {
      ctx.ui.notify("No providers available", "warning");
      return;
    }

    let provider: string;
    let modelPrefix: string | undefined;

    if (!query) {
      // ---- interactive provider picker ----
      const currentProvider = ctx.model?.provider;
      const optionToProvider = new Map<string, string>();
      const options = [...byProvider.entries()]
        .map(([pid, ms]) => {
          const display = ctx.modelRegistry.getProviderDisplayName(pid);
          const marker = pid === currentProvider ? " (current)" : "";
          const label = `${display} (${ms.length})${marker}`;
          optionToProvider.set(label, pid);
          return label;
        })
        .sort();
      const choice = await ctx.ui.select("Switch provider:", options);
      if (!choice) return;
      provider = optionToProvider.get(choice) ?? choice;
    } else {
      // ---- arg form: provider or provider/model ----
      const slash = query.indexOf("/");
      if (slash > 0) {
        provider = query.slice(0, slash);
        modelPrefix = query.slice(slash + 1) || undefined;
      } else {
        provider = query;
      }
    }

    const target = resolveModel(ctx, provider, modelPrefix);
    if (!target) {
      ctx.ui.notify(`Provider "${provider}" not found`, "error");
      return;
    }
    await applyModel(ctx, target, persist);
  };

  const providerCommandOptions = {
    description:
      "Switch provider and set as default (add --no-default to skip persisting)",
    getArgumentCompletions: providerCompletions,
    handler: handleProviderCommand,
  };

  pi.registerCommand("provider", providerCommandOptions);

  pi.registerCommand("switch-provider", {
    ...providerCommandOptions,
    description: "Switch provider (alias of /provider)",
  });

  // ---------------------------------------------------------------------------
  // /models
  // ---------------------------------------------------------------------------
  pi.registerCommand("models", {
    description:
      "List & switch models (e.g. /models, /models nano-gpt, /models deepseek/v4; --default persists)",
    getArgumentCompletions: modelCompletions,
    handler: async (rawArgs: string, ctx: Ctx) => {
      const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
      const persist = parts.includes("--default");
      const query = parts.filter((p) => !p.startsWith("--")).join(" ").trim();

      const byProvider = groupByProvider(ctx);
      const allModels = ctx.modelRegistry.getAvailable();
      if (allModels.length === 0) {
        ctx.ui.notify("No models available", "warning");
        return;
      }

      // ---- interactive model picker ----
      const pickModel = async (models: ModelRef[], title: string): Promise<ModelRef | undefined> => {
        if (models.length === 0) return undefined;
        if (models.length === 1) return models[0];
        const currentProvider = ctx.model?.provider;
        const currentId = ctx.model?.id;
        const optionToModel = new Map<string, ModelRef>();
        const options = models
          .map((m) => {
            const marker =
              m.provider === currentProvider && m.id === currentId ? " (current)" : "";
            const label = `${m.provider}/${m.id} — ${m.name}${marker}`;
            optionToModel.set(label, m);
            return label;
          })
          .sort();
        const choice = await ctx.ui.select(title, options);
        if (!choice) return undefined;
        return optionToModel.get(choice);
      };

      let target: ModelRef | undefined;

      if (!query) {
        // ---- all models grouped by provider ----
        target = await pickModel(
          [...byProvider.values()].flat(),
          "Select model (type to filter):",
        );
      } else {
        const slash = query.indexOf("/");
        if (slash > 0) {
          // provider/model — direct resolution
          const provider = query.slice(0, slash);
          const modelPrefix = query.slice(slash + 1) || undefined;
          target = resolveModel(ctx, provider, modelPrefix);
          if (!target) {
            ctx.ui.notify(`No model matching "${query}"`, "error");
            return;
          }
        } else if (byProvider.has(query)) {
          // provider name — picker within that provider
          target = await pickModel(
            byProvider.get(query)!,
            `Select model for ${query}:`,
          );
        } else {
          // bare prefix — fuzzy match across all providers
          const q = query.toLowerCase();
          const matches = allModels.filter((m) => m.id.toLowerCase().includes(q));
          if (matches.length === 0) {
            ctx.ui.notify(`No model matching "${query}"`, "error");
            return;
          }
          if (matches.length === 1) {
            target = matches[0];
          } else {
            target = await pickModel(matches, `Models matching "${query}":`);
          }
        }
      }

      if (!target) return; // user cancelled
      await applyModel(ctx, target, persist);
    },
  });
}
