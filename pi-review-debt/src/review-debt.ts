/**
 * review-debt — a review-debt tracker for pi.
 *
 * Records code-review findings as durable, per-repository debt and closes the
 * loop automatically:
 *
 *  1. The agent (or you) records findings via the `record_finding` tool or
 *     `/debt add` — e.g. right after a `/review` run surfaces concrete issues.
 *  2. At the end of every agent run (`agent_settled`), the tracker detects
 *     whether the affected file's content changed since the finding was
 *     recorded (git blob hash) and flags likely-fixed findings as
 *     "addressed" — awaiting verification.
 *  3. Open debt is surfaced to the model at every turn (`before_agent_start`
 *     appends a short bullet) and to you via notifications and `/debt`.
 *
 * Surface:
 *  - tools:        `record_finding`, `list_findings` (agent-callable)
 *  - commands:     `/debt`, `/debt add|resolve|dismiss|check|clear|list`
 *  - notifications: one warning per open→addressed transition (never spams)
 *
 * State: ~/.pi/agent/review-debt/state.json (override with REVIEW_DEBT_STATE
 * for tests). Findings are keyed per repository via the file blob captured at
 * creation, so cross-repo debt does not interfere.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "info" | "warning" | "critical";
export type FindingStatus = "open" | "addressed" | "resolved" | "dismissed";

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  /** Repo-relative path of the affected file, when known. */
  file?: string;
  line?: number;
  detail?: string;
  status: FindingStatus;
  source: "agent" | "user";
  createdAt: number;
  resolvedAt?: number;
  /** git blob hash of `file` at creation — the change-detection baseline. */
  fileBlobAtCreate?: string;
  /** True once the file blob changed after creation (auto-detected). */
  changedSinceCreate?: boolean;
  lastCheckAt?: number;
}

export interface State {
  findings: Finding[];
}

const STATUS_ORDER: FindingStatus[] = ["open", "addressed", "resolved", "dismissed"];
const SEVERITY_ORDER: Severity[] = ["critical", "warning", "info"];

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

export function stateFilePath(): string {
  return (
    process.env.REVIEW_DEBT_STATE ??
    path.join(os.homedir(), ".pi", "agent", "review-debt", "state.json")
  );
}

let cachedState: State | null = null;
let writeChain: Promise<void> = Promise.resolve();

export async function loadState(): Promise<State> {
  if (cachedState) return cachedState;
  const file = stateFilePath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as State;
    cachedState = Array.isArray(parsed.findings) ? parsed : { findings: [] };
  } catch {
    cachedState = { findings: [] };
  }
  return cachedState;
}

/** Fire-and-forget atomic write; errors are logged, never thrown into pi. */
function persist(state: State): void {
  writeChain = writeChain.then(async () => {
    try {
      const file = stateFilePath();
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      console.error("[review-debt] persist failed:", err);
    }
  });
}

/** Await pending writes (used by tests and /debt check for deterministic reads). */
export async function flushState(): Promise<void> {
  await writeChain;
}

function newId(): string {
  return `rd-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      windowsHide: true,
      timeout: 10000,
    });
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/** git blob hash of a path (works for tracked and untracked files). */
export async function fileBlob(root: string, file: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["hash-object", "--", file], {
      cwd: root,
      windowsHide: true,
      timeout: 10000,
    });
    return stdout.trim();
  } catch {
    return null; // missing/unreadable file (or git error) → null
  }
}

// ---------------------------------------------------------------------------
// Finding operations
// ---------------------------------------------------------------------------

export interface NewFindingInput {
  title: string;
  severity: Severity;
  file?: string;
  line?: number;
  detail?: string;
  source: "agent" | "user";
  cwd: string;
}

export async function addFinding(input: NewFindingInput): Promise<Finding> {
  const state = await loadState();
  const root = await repoRoot(input.cwd);
  const file = input.file?.trim() ? input.file.trim() : undefined;
  let blob: string | undefined;
  if (file && root) {
    const b = await fileBlob(root, file);
    if (b) blob = b;
  }
  const finding: Finding = {
    id: newId(),
    title: input.title.trim(),
    severity: input.severity,
    file,
    line: input.line,
    detail: input.detail?.trim() ? input.detail.trim() : undefined,
    status: "open",
    source: input.source,
    createdAt: Date.now(),
    fileBlobAtCreate: blob,
  };
  state.findings.push(finding);
  persist(state);
  return finding;
}

/** Exact id match first, then a unique prefix match. */
export function findFinding(state: State, ref: string): Finding | undefined {
  const exact = state.findings.find((f) => f.id === ref);
  if (exact) return exact;
  const matches = state.findings.filter((f) => f.id.startsWith(ref));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function setFindingStatus(
  ref: string,
  status: "resolved" | "dismissed",
  cwd: string,
): Promise<Finding | null> {
  const state = await loadState();
  const finding = findFinding(state, ref);
  if (!finding) return null;
  finding.status = status;
  finding.resolvedAt = Date.now();
  persist(state);
  return finding;
}

/**
 * Auto-check: for every active finding that names a file, compare the file's
 * current blob against the blob captured at creation. A change (or the file's
 * disappearance) transitions open → addressed, pending verification.
 */
export async function checkFindings(cwd: string): Promise<{ changed: Finding[] }> {
  const state = await loadState();
  const active = state.findings.filter((f) => f.status === "open" || f.status === "addressed");
  if (active.length === 0) return { changed: [] };
  const root = await repoRoot(cwd);
  if (!root) return { changed: [] };

  const changed: Finding[] = [];
  for (const f of active) {
    if (!f.file || f.fileBlobAtCreate === undefined) continue;
    const blob = await fileBlob(root, f.file);
    f.lastCheckAt = Date.now();
    const deleted = blob === null;
    const contentChanged = blob !== null && blob !== f.fileBlobAtCreate;
    if ((deleted || contentChanged) && f.status === "open") {
      f.status = "addressed";
      f.changedSinceCreate = true;
      changed.push(f);
    }
  }
  if (changed.length > 0) persist(state);
  return { changed };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function describeFinding(f: Finding): string {
  const where = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "no file";
  const age = Math.max(1, Math.round((Date.now() - f.createdAt) / 86_400_000));
  return `${f.id} [${f.severity}] ${f.title} — ${where} · ${f.status} · ${age}d old`;
}

export function summarize(state: State): string {
  const counts: Record<FindingStatus, number> = { open: 0, addressed: 0, resolved: 0, dismissed: 0 };
  for (const f of state.findings) counts[f.status]++;
  const active = counts.open + counts.addressed;
  if (active > 0) {
    return `Review debt: ${counts.open} open, ${counts.addressed} awaiting verification (${state.findings.length} total on record)`;
  }
  if (state.findings.length === 0) return "Review debt: none";
  return `Review debt: none active (${state.findings.length} on record: ${counts.resolved} resolved, ${counts.dismissed} dismissed)`;
}

export function findingsMarkdown(findings: Finding[]): string {
  if (findings.length === 0) return "No review findings recorded.";
  return findings
    .map((f) => {
      const where = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "no file";
      return `- [${f.severity}] ${f.title} — ${where} (${f.status}, ${f.id})`;
    })
    .join("\n");
}

function listItems(findings: Finding[]): SelectItem[] {
  const sorted = [...findings].sort((a, b) => {
    const s = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (s !== 0) return s;
    return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  });
  return sorted.map((f) => ({
    value: f.id,
    label: `[${f.severity}] ${f.title}`,
    description: `${f.file ?? "no file"}${f.line ? ":" + f.line : ""} · ${f.status} · ${new Date(f.createdAt).toLocaleDateString()}`,
  }));
}

// ---------------------------------------------------------------------------
// Interactive /debt UI
// ---------------------------------------------------------------------------

type DebtAction = "resolve" | "dismiss" | "back";

async function showDebtList(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadState();
  const items = listItems(state.findings);
  if (items.length === 0) {
    ctx.ui.notify("Review debt: none 🎉", "info");
    return;
  }

  const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("Review debt"))));
    const list = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    list.onSelect = (item) => done(item.value as string);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "Enter: inspect · Esc: close")));
    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
  if (!picked) return;

  const finding = findFinding(state, picked);
  if (!finding) return;
  const action = await ctx.ui.custom<DebtAction | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(
      new Text(theme.fg("accent", theme.bold(`Finding ${finding.id} — ${finding.title}`))),
    );
    container.addChild(new Text(theme.fg("muted", describeFinding(finding))));
    if (finding.detail) container.addChild(new Text(theme.fg("muted", finding.detail)));
    const list = new SelectList(
      [
        { value: "resolve", label: "Resolve", description: "Verified fixed" },
        { value: "dismiss", label: "Dismiss", description: "Won't fix / not applicable" },
        { value: "back", label: "Back" },
      ],
      3,
      {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    );
    list.onSelect = (item) => done(item.value as DebtAction);
    list.onCancel = () => done(null);
    container.addChild(list);
    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
  if (!action || action === "back") return;
  const status = action === "resolve" ? "resolved" : "dismissed";
  await setFindingStatus(picked, status, ctx.cwd);
  ctx.ui.notify(`Finding ${picked} ${action === "resolve" ? "resolved" : "dismissed"}`, "info");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function reviewDebtExtension(pi: ExtensionAPI): void {
  // --- tools --------------------------------------------------------------

  pi.registerTool({
    name: "record_finding",
    label: "Record review finding",
    description:
      "Record a concrete code-review finding as review debt for the current repository. " +
      "Call this after a code review (e.g. /review) surfaces a real issue that should be " +
      "tracked and fixed, or when you notice a defect in a file you are working on. " +
      "The tracker will later detect when the affected file changes.",
    promptGuidelines: [
      "After a code review surfaces concrete issues, record each one with record_finding (repo-relative file path, severity).",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short, specific title of the issue (imperative)." }),
      severity: Type.Optional(
        Type.Union([
          Type.Literal("info"),
          Type.Literal("warning"),
          Type.Literal("critical"),
        ]),
      ),
      file: Type.Optional(
        Type.String({ description: "Repo-relative path of the affected file." }),
      ),
      line: Type.Optional(Type.Integer({ description: "Line number in the file, if known." })),
      detail: Type.Optional(Type.String({ description: "Extra context for fixing the issue." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const finding = await addFinding({
        title: params.title,
        severity: params.severity ?? "warning",
        file: params.file,
        line: params.line,
        detail: params.detail,
        source: "agent",
        cwd: ctx.cwd,
      });
      return {
        content: [
          {
            type: "text",
            text: `Recorded review finding ${finding.id} [${finding.severity}]${finding.file ? " in " + finding.file : ""}: ${finding.title}`,
          },
        ],
        details: { finding },
      };
    },
  });

  pi.registerTool({
    name: "list_findings",
    label: "List review findings",
    description:
      "List recorded review-debt findings (open and awaiting verification first) for the current " +
      "repository. Use before finishing a task to check whether open findings relevant to your " +
      "work have been addressed.",
    promptGuidelines: [
      "Before finishing a task, call list_findings to check open review debt in files you changed.",
    ],
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({
          description: "Filter: open | addressed | resolved | dismissed (default: open + addressed).",
        }),
      ),
      file: Type.Optional(
        Type.String({ description: "Filter by repo-relative path substring." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = await loadState();
      const wanted =
        params.status === "open" ||
        params.status === "addressed" ||
        params.status === "resolved" ||
        params.status === "dismissed"
          ? [params.status]
          : (["open", "addressed"] as FindingStatus[]);
      let findings = state.findings.filter((f) => wanted.includes(f.status));
      if (params.file) {
        const needle = params.file.toLowerCase();
        findings = findings.filter((f) => f.file?.toLowerCase().includes(needle));
      }
      findings.sort(
        (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
      );
      const text = findingsMarkdown(findings);
      return {
        content: [{ type: "text", text }],
        details: { count: findings.length },
      };
    },
  });

  // --- agent loop integration ---------------------------------------------

  // Surface open debt to the model every turn — short, transient, only when debt exists.
  pi.on("before_agent_start", async (event) => {
    try {
      const state = await loadState();
      const open = state.findings.filter(
        (f) => f.status === "open" || f.status === "addressed",
      );
      if (open.length === 0) return undefined;
      const o = open.filter((f) => f.status === "open").length;
      return {
        systemPrompt:
          event.systemPrompt +
          `\n\nOpen review debt in this repository: ${o} open + ${open.length - o} awaiting verification (${open.length} total). Call list_findings for details and address findings that touch your current work.`,
      };
    } catch {
      return undefined;
    }
  });

  // Detect likely-fixed findings after each run; notify once per transition.
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const { changed } = await checkFindings(ctx.cwd);
      if (changed.length > 0 && ctx.hasUI) {
        const ids = changed.map((f) => f.id).join(", ");
        ctx.ui.notify(
          `Review debt: ${changed.length} finding(s) likely fixed (file changed): ${ids}. Verify, then /debt resolve ${changed[0].id}`,
          "warning",
        );
      }
    } catch {
      // never break the agent loop
    }
  });

  // --- commands -------------------------------------------------------------

  pi.registerCommand("debt", {
    description:
      "Review-debt tracker: list findings, or add / resolve / dismiss / check / clear",
    getArgumentCompletions: async (prefix) => {
      const subs = ["add", "resolve", "dismiss", "check", "clear", "list"];
      const p = prefix.toLowerCase();
      const out = subs
        .filter((s) => s.startsWith(p))
        .map((s) => ({ value: s, label: s }));
      return out.length > 0 ? out : null;
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();

      switch (sub) {
        case "":
        case "list":
        case "-l":
          if (ctx.hasUI) await showDebtList(ctx);
          else ctx.ui.notify(summarize(await loadState()), "info");
          return;

        case "add": {
          // Flags: --sev=critical|warning|info --file=rel/path --line=N; rest = title
          let severity: Severity = "warning";
          let file: string | undefined;
          let line: number | undefined;
          const titleParts: string[] = [];
          for (const part of parts.slice(1)) {
            if (part.startsWith("--sev=")) {
              const v = part.slice(6).toLowerCase();
              severity = v === "critical" || v === "info" ? v : "warning";
            } else if (part.startsWith("--file=")) {
              file = part.slice(7);
            } else if (part.startsWith("--line=")) {
              line = Number.parseInt(part.slice(7), 10);
            } else {
              titleParts.push(part);
            }
          }
          const title = titleParts.join(" ");
          if (!title) {
            ctx.ui.notify(
              "Usage: /debt add <title> [--sev=warning|critical|info] [--file=path] [--line=N]",
              "error",
            );
            return;
          }
          const finding = await addFinding({ title, severity, file, line, source: "user", cwd: ctx.cwd });
          ctx.ui.notify(`Recorded finding ${finding.id} [${severity}]`, "info");
          return;
        }

        case "resolve":
        case "dismiss": {
          const ref = parts[1];
          if (!ref) {
            ctx.ui.notify(`Usage: /debt ${sub} <id>`, "error");
            return;
          }
          const status = sub === "resolve" ? "resolved" : "dismissed";
          const finding = await setFindingStatus(ref, status, ctx.cwd);
          if (!finding) {
            ctx.ui.notify(`No finding matches "${ref}"`, "error");
            return;
          }
          ctx.ui.notify(`Finding ${finding.id} ${sub === "resolve" ? "resolved" : "dismissed"}`, "info");
          return;
        }

        case "check": {
          const { changed } = await checkFindings(ctx.cwd);
          const state = await loadState();
          ctx.ui.notify(
            changed.length > 0
              ? `${summarize(state)} — ${changed.length} flagged as likely fixed: ${changed.map((f) => f.id).join(", ")}`
              : `${summarize(state)} — no changes detected`,
            changed.length > 0 ? "warning" : "info",
          );
          return;
        }

        case "clear": {
          // /debt clear [--days=N] — purge resolved/dismissed older than N days (default 14; 0 = all)
          const daysArg = parts.find((p) => p.startsWith("--days="));
          const days = daysArg ? Number.parseInt(daysArg.slice(7), 10) : 14;
          const cutoff = Date.now() - days * 86_400_000;
          const state = await loadState();
          const before = state.findings.length;
          state.findings = state.findings.filter(
            (f) =>
              (f.status !== "resolved" && f.status !== "dismissed") ||
              (f.resolvedAt !== undefined && f.resolvedAt >= cutoff),
          );
          const removed = before - state.findings.length;
          persist(state);
          ctx.ui.notify(
            removed > 0
              ? `Cleared ${removed} old resolved/dismissed finding(s)`
              : "Nothing to clear",
            "info",
          );
          return;
        }

        default:
          ctx.ui.notify(
            "Unknown subcommand. Try: list, add <title> [--sev=…] [--file=…], resolve <id>, dismiss <id>, check, clear [--days=N]",
            "error",
          );
      }
    },
  });
}
