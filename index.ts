/**
 * Coli Extension – Scheduled Task Supervisor
 *
 * Defer prompts to a specified time.  A **different model** (the supervisor)
 * evaluates the working agent's output across a limited number of rounds.
 * The supervisor is a pure evaluator — it cannot read files or run commands.
 *
 * ## Quick Reference
 *
 *   /coli setup                      Configure defaults (model, rounds)
 *   /coli schedule <when> <task>     Schedule a supervised task
 *   /coli list                       List all tasks
 *   /coli cancel <id>                Cancel a task
 *   /coli help                       Show help
 *
 *   Tool: coli_schedule              LLM can self-schedule follow-up tasks
 */

import * as crypto from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { cancel, cancelAll, schedule } from "./scheduler.js";
import { evaluate } from "./supervisor.js";
import type {
  ColiConfig,
  PersistedTask,
  RoundSummary,
  ScheduledTask,
} from "./types.js";
import { DEFAULT_MAX_ROUNDS, defaultConfig } from "./types.js";

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const ENTRY_TYPE_TASK = "coli-task";
const ENTRY_TYPE_CONFIG = "coli-config";

/** All tasks, keyed by id. */
const tasks = new Map<string, ScheduledTask>();
/** Current config (runtime, backed by session persistence). */
let config: ColiConfig = defaultConfig();
/** Guard against concurrent supervision loops. */
let supervisionActive = false;

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function uid(): string {
  return crypto.randomUUID().slice(0, 8);
}

function persistConfig(pi: ExtensionAPI): void {
  pi.appendEntry(ENTRY_TYPE_CONFIG, {
    ...config,
    updatedAt: Date.now(),
  });
}

function persistTask(pi: ExtensionAPI, task: ScheduledTask): void {
  const p: PersistedTask = {
    id: task.id,
    description: task.description,
    triggerAt: task.triggerAt,
    maxRounds: task.maxRounds,
    currentRound: task.currentRound,
    status: task.status,
    supervisorProvider: task.supervisorProvider,
    supervisorModelId: task.supervisorModelId,
    workingProvider: task.workingProvider,
    workingModelId: task.workingModelId,
    roundSummaries: task.roundSummaries,
    createdAt: task.createdAt,
    supervisorUsage: task.supervisorUsage,
  };
  pi.appendEntry(ENTRY_TYPE_TASK, p);
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtCountdown(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const m = Math.floor(diff / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const STATUS_ICON: Record<string, string> = {
  pending: "\u23F3",
  running: "\uD83D\uDD04",
  completed: "\u2713",
  failed: "\u2717",
  cancelled: "\u2298",
};

// ---------------------------------------------------------------------------
// Time-spec parser
// ---------------------------------------------------------------------------

function parseTimeSpec(spec: string): number | null {
  const now = Date.now();
  let m: RegExpMatchArray | null;

  m = spec.match(/^in\s+(\d+)\s*(minute|min|m)s?\s*$/i);
  if (m) return now + parseInt(m[1], 10) * 60_000;

  m = spec.match(/^in\s+(\d+)\s*(hour|hr|h)s?\s*$/i);
  if (m) return now + parseInt(m[1], 10) * 3600_000;

  m = spec.match(/^in\s+(\d+)\s*(second|sec|s)s?\s*$/i);
  if (m) return now + parseInt(m[1], 10) * 1000;

  m = spec.match(/^at\s+(\d{1,2}):(\d{2})\s*$/i);
  if (m) {
    const target = new Date();
    target.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    if (target.getTime() <= now) target.setDate(target.getDate() + 1);
    return target.getTime();
  }

  m = spec.match(/^(\d+)\s*$/);
  if (m) return now + parseInt(m[1], 10);

  return null;
}

// ---------------------------------------------------------------------------
// Supervisor model resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which model to use as supervisor.
 *
 * Priority:
 *   1. Explicit config (set via /coli setup model)
 *   2. First available model whose `name` contains "[coli]"
 *   3. First available model (any provider)
 *   4. Current pi session model (last resort)
 */
async function resolveSupervisorModel(
  ctx: ExtensionContext,
): Promise<{ provider: string; id: string; display: string } | null> {
  // 1. Saved config
  if (config.supervisorProvider && config.supervisorModelId) {
    const m = ctx.modelRegistry.find(
      config.supervisorProvider,
      config.supervisorModelId,
    );
    if (m) {
      return {
        provider: m.provider,
        id: m.id,
        display: `${m.provider}/${m.id}`,
      };
    }
  }

  // 2. Scan available models for [coli] prefix in name
  try {
    const available = await ctx.modelRegistry.getAvailable();
    if (available.length > 0) {
      const coliModel = available.find((m) =>
        (m.name || m.id).includes("[coli]"),
      );
      const chosen = coliModel ?? available[0];
      return {
        provider: chosen.provider,
        id: chosen.id,
        display: `${chosen.provider}/${chosen.id} (${chosen.name || chosen.id})`,
      };
    }
  } catch {
    // getAvailable may fail if no keys are configured
  }

  // 3. Fall back to current pi session model
  if (ctx.model) {
    return {
      provider: ctx.model.provider,
      id: ctx.model.id,
      display: `${ctx.model.provider}/${ctx.model.id} (current)`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

function fireTask(pi: ExtensionAPI, task: ScheduledTask): void {
  if (task.status !== "pending") return;
  task.status = "running";
  task.currentRound = 1;
  persistTask(pi, task);

  const prompt = [
    `## Coli 定时任务`,
    ``,
    task.description,
    ``,
    `这是第 1/${task.maxRounds} 轮。请尽力完成该任务。`,
  ].join("\n");

  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

async function runSupervisionRound(
  pi: ExtensionAPI,
  task: ScheduledTask,
  messages: AgentMessage[],
  ctx: ExtensionContext,
): Promise<void> {
  const { decision, usage } = await evaluate(task, messages, ctx);

  // Accumulate supervisor usage
  task.supervisorUsage.prompts++;
  task.supervisorUsage.inputTokens += usage.inputTokens;
  task.supervisorUsage.outputTokens += usage.outputTokens;
  task.supervisorUsage.cost += usage.cost;

  const summary: RoundSummary = {
    round: task.currentRound,
    workerOutputPreview: "",
    decision: decision.status,
    instruction: decision.instruction,
    timestamp: Date.now(),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  task.roundSummaries.push(summary);

  // Format usage line
  const usageLine = `↑${task.supervisorUsage.inputTokens} ↓${task.supervisorUsage.outputTokens} prompts:${task.supervisorUsage.prompts} $${task.supervisorUsage.cost.toFixed(4)}`;

  // --- done ---
  if (decision.status === "done") {
    task.status = "completed";
    persistTask(pi, task);
    if (ctx.hasUI)
      ctx.ui.notify(
        `\u2713 Coli done: ${task.description}\n   监督用量: ${usageLine}`,
        "success",
      );
    return;
  }

  // --- fail ---
  if (decision.status === "fail") {
    task.status = "failed";
    persistTask(pi, task);
    if (ctx.hasUI)
      ctx.ui.notify(
        `\u2717 Coli failed: ${decision.instruction}\n   监督用量: ${usageLine}`,
        "error",
      );
    return;
  }

  // --- out of rounds ---
  if (task.currentRound >= task.maxRounds) {
    task.status = "failed";
    persistTask(pi, task);
    if (ctx.hasUI)
      ctx.ui.notify(
        `\u2717 Coli max rounds (${task.maxRounds}): ${task.description}\n   监督用量: ${usageLine}`,
        "error",
      );
    return;
  }

  // --- continue ---
  task.currentRound++;
  persistTask(pi, task);

  const feedback = [
    `## Coli 监督反馈 (轮次 ${task.currentRound}/${task.maxRounds})`,
    ``,
    `上一轮: **未完成**`,
    ``,
    decision.instruction,
    ``,
    `原始任务:`,
    task.description,
  ].join("\n");

  pi.sendUserMessage(feedback, { deliverAs: "followUp" });
}

// ---------------------------------------------------------------------------
// State restoration
// ---------------------------------------------------------------------------

function restoreFromSession(
  pi: ExtensionAPI,
  entries: Iterable<SessionEntry>,
): void {
  for (const entry of entries) {
    if (entry.type !== "custom") continue;

    // Restore config (last one wins)
    if (entry.customType === ENTRY_TYPE_CONFIG) {
      const data = entry.data as ColiConfig | undefined;
      if (data) {
        config = {
          supervisorProvider: data.supervisorProvider || "",
          supervisorModelId: data.supervisorModelId || "",
          maxRounds: data.maxRounds || DEFAULT_MAX_ROUNDS,
          updatedAt: data.updatedAt || 0,
        };
      }
      continue;
    }

    // Restore tasks
    if (entry.customType === ENTRY_TYPE_TASK) {
      const data = entry.data as PersistedTask | undefined;
      if (!data?.id) continue;
      if (data.status === "completed" || data.status === "cancelled") continue;

      const task: ScheduledTask = {
        id: data.id,
        description: data.description,
        triggerAt: data.triggerAt,
        maxRounds: data.maxRounds,
        currentRound: data.currentRound,
        status: data.status,
        supervisorProvider: data.supervisorProvider,
        supervisorModelId: data.supervisorModelId,
        workingProvider: data.workingProvider,
        workingModelId: data.workingModelId,
        roundSummaries: data.roundSummaries || [],
        createdAt: data.createdAt,
        supervisorUsage: data.supervisorUsage || { prompts: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
      };
      tasks.set(task.id, task);

      if (task.status === "pending" && task.triggerAt > Date.now()) {
        schedule(task, () => fireTask(pi, task));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// /coli setup handler
// ---------------------------------------------------------------------------

async function handleSetup(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  parts: string[],
): Promise<void> {
  // /coli setup
  if (parts.length === 1) {
    const sup = config.supervisorProvider
      ? `${config.supervisorProvider}/${config.supervisorModelId}`
      : "(auto-discover)";
    ctx.ui.notify(
      [
        "Coli 配置",
        `  监督模型:  ${sup}`,
        `  默认轮次:  ${config.maxRounds}`,
        `  更新于:    ${config.updatedAt ? new Date(config.updatedAt).toLocaleString() : "never"}`,
        "",
        "子命令:",
        "  /coli setup model             自动发现监督模型 (优先 [coli] 前缀)",
        "  /coli setup model <pv>/<id>   指定监督模型",
        "  /coli setup rounds <n>        设置默认最大轮次 (1-20)",
        "  /coli setup reset             恢复默认",
      ].join("\n"),
      "info",
    );
    return;
  }

  const sub = parts[1].toLowerCase();

  // --- model ---
  if (sub === "model") {
    if (parts.length >= 3) {
      // Explicit model
      const raw = parts.slice(2).join("/");
      const idx = raw.indexOf("/");
      if (idx <= 0) {
        ctx.ui.notify('格式: /coli setup model <provider>/<modelId>', "error");
        return;
      }
      const prov = raw.slice(0, idx);
      const mid = raw.slice(idx + 1);
      const m = ctx.modelRegistry.find(prov, mid);
      if (!m) {
        ctx.ui.notify(`模型未找到: ${prov}/${mid}`, "error");
        return;
      }
      config.supervisorProvider = prov;
      config.supervisorModelId = mid;
      persistConfig(pi);
      ctx.ui.notify(
        `监督模型已设为: ${prov}/${mid}`,
        "success",
      );
      return;
    }

    // Auto-discover
    ctx.ui.notify("正在扫描可用模型...", "info");

    // Scan for models with [coli] prefix
    let found: { provider: string; id: string; name: string } | null = null;
    const all: string[] = [];

    try {
      const available = await ctx.modelRegistry.getAvailable();
      for (const m of available) {
        all.push(`${m.provider}/${m.id}  (${m.name || m.id})`);
        if (!found && (m.name || m.id).includes("[coli]")) {
          found = { provider: m.provider, id: m.id, name: m.name || m.id };
        }
      }
    } catch {
      // getAvailable may fail
    }

    if (found) {
      config.supervisorProvider = found.provider;
      config.supervisorModelId = found.id;
      persistConfig(pi);
      ctx.ui.notify(
        `监督模型已设为: ${found.provider}/${found.id}  (匹配 [coli] 前缀)`,
        "success",
      );
    } else if (all.length > 0) {
      // Take first available
      const first = all[0];
      const midx = first.indexOf("/");
      const prov = first.slice(0, midx);
      const mid = first.slice(midx + 1, first.indexOf("  ("));
      config.supervisorProvider = prov;
      config.supervisorModelId = mid.trim();
      persistConfig(pi);
      ctx.ui.notify(
        `监督模型已设为: ${config.supervisorProvider}/${config.supervisorModelId}  (第一个可用, 未找到 [coli] 前缀模型)\n\n可用模型:\n${all.join("\n")}`,
        "warning",
      );
    } else {
      ctx.ui.notify(
        "未找到可用模型。请先配置 API key (/login 或设置环境变量)，然后重试。",
        "error",
      );
    }
    return;
  }

  // --- rounds ---
  if (sub === "rounds") {
    const n = parseInt(parts[2], 10);
    if (isNaN(n) || n < 1 || n > 20) {
      ctx.ui.notify("轮次范围: 1-20", "error");
      return;
    }
    config.maxRounds = n;
    persistConfig(pi);
    ctx.ui.notify(`默认最大轮次已设为: ${n}`, "success");
    return;
  }

  // --- reset ---
  if (sub === "reset") {
    config = defaultConfig();
    persistConfig(pi);
    ctx.ui.notify("Coli 配置已恢复默认", "info");
    return;
  }

  ctx.ui.notify(`未知子命令: ${sub}。使用 /coli setup 查看帮助`, "error");
}

// ---------------------------------------------------------------------------
// /coli schedule handler
// ---------------------------------------------------------------------------

async function handleSchedule(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rest: string,
): Promise<void> {
  let timeSpec = "";
  let description = "";

  const inMatch = rest.match(
    /^(in\s+\d+\s*(?:minute|min|m|hour|hr|h|second|sec|s)s?\s+)/i,
  );
  const atMatch = rest.match(/^(at\s+\d{1,2}:\d{2}\s+)/i);
  const msMatch = rest.match(/^(\d+)\s+/);

  if (inMatch) {
    timeSpec = inMatch[1].trim();
    description = rest.slice(inMatch[0].length).trim();
  } else if (atMatch) {
    timeSpec = atMatch[1].trim();
    description = rest.slice(atMatch[0].length).trim();
  } else if (msMatch) {
    timeSpec = msMatch[1].trim();
    description = rest.slice(msMatch[0].length).trim();
  } else {
    ctx.ui.notify(
      '用法: /coli schedule <when> <task>\n  例: /coli schedule in 10 minutes 修复 auth.ts 的类型错误\n  时间格式: in X minutes | in X hours | at HH:MM | 毫秒数',
      "error",
    );
    return;
  }

  if (!description) {
    ctx.ui.notify("请提供任务描述", "error");
    return;
  }

  const triggerAt = parseTimeSpec(timeSpec);
  if (triggerAt === null) {
    ctx.ui.notify(`无法解析时间: "${timeSpec}"`, "error");
    return;
  }
  if (triggerAt <= Date.now()) {
    ctx.ui.notify("触发时间必须在将来", "error");
    return;
  }

  const sup = await resolveSupervisorModel(ctx);
  if (!sup) {
    ctx.ui.notify(
      "没有可用的监督模型。请先配置 API key 或运行 /coli setup model",
      "error",
    );
    return;
  }

  const task: ScheduledTask = {
    id: uid(),
    description,
    triggerAt,
    maxRounds: config.maxRounds,
    currentRound: 0,
    status: "pending",
    supervisorProvider: sup.provider,
    supervisorModelId: sup.id,
    roundSummaries: [],
    createdAt: Date.now(),
    supervisorUsage: { prompts: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
  };

  tasks.set(task.id, task);
  persistTask(pi, task);
  schedule(task, () => fireTask(pi, task));

  ctx.ui.notify(
    [
      `\u2713 Coli 任务已创建 [${task.id}]`,
      `触发: ${fmtTime(triggerAt)}  (${fmtCountdown(triggerAt)})`,
      `描述: ${description}`,
      `监督: ${sup.display}  (最多 ${task.maxRounds} 轮)`,
    ].join("\n"),
    "success",
  );
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // =========================================================================
  // Command: /coli
  // =========================================================================

  pi.registerCommand("coli", {
    description:
      "Scheduled task supervisor. /coli setup | schedule <when> <task> | list | cancel <id> | help",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || "").toLowerCase();
      const rest = parts.slice(1).join(" ");

      // --- help ---
      if (!sub || sub === "help") {
        ctx.ui.notify(
          [
            "Coli \u2014 定时任务监督器",
            "",
            "  /coli setup                    配置默认监督模型和轮次",
            "  /coli schedule <when> <task>   安排定时任务",
            '    when: "in 10 minutes" | "in 2 hours" | "at 15:30" | 300000',
            "  /coli list                    列出所有任务",
            "  /coli cancel <id>             取消任务",
            "",
            "LLM 也可调用 coli_schedule 工具自行安排子任务。",
          ].join("\n"),
          "info",
        );
        return;
      }

      // --- setup ---
      if (sub === "setup") {
        await handleSetup(pi, ctx, parts);
        return;
      }

      // --- list ---
      if (sub === "list") {
        if (tasks.size === 0) {
          ctx.ui.notify("没有 Coli 任务", "info");
          return;
        }
        const lines: string[] = [];
        for (const t of tasks.values()) {
          lines.push(
            `${STATUS_ICON[t.status] ?? "?"} [${t.id}] ${t.status}  ${t.description.slice(0, 60)}`,
          );
          if (t.status === "pending") {
            lines.push(
              `   触发: ${fmtTime(t.triggerAt)}  (${fmtCountdown(t.triggerAt)})`,
            );
          }
          lines.push(
            `   监督: ${t.supervisorProvider}/${t.supervisorModelId}  轮次: ${t.currentRound}/${t.maxRounds}`,
          );
          if (t.supervisorUsage && t.supervisorUsage.prompts > 0) {
            lines.push(
              `   监督用量: ↑${t.supervisorUsage.inputTokens} ↓${t.supervisorUsage.outputTokens} prompts:${t.supervisorUsage.prompts} $${t.supervisorUsage.cost.toFixed(4)}`,
            );
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // --- cancel ---
      if (sub === "cancel") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("用法: /coli cancel <id>", "error");
          return;
        }
        const task = tasks.get(id);
        if (!task) {
          ctx.ui.notify(`任务 [${id}] 未找到`, "error");
          return;
        }
        task.status = "cancelled";
        cancel(task.id);
        persistTask(pi, task);
        tasks.delete(id);
        ctx.ui.notify(`任务 [${id}] 已取消`, "info");
        return;
      }

      // --- schedule ---
      if (sub === "schedule") {
        await handleSchedule(pi, ctx, rest);
        return;
      }

      ctx.ui.notify(
        `未知子命令 "${sub}"。使用 /coli help 查看帮助`,
        "error",
      );
    },
  });

  // =========================================================================
  // Tool: coli_schedule (LLM can self-schedule)
  // =========================================================================

  pi.registerTool({
    name: "coli_schedule",
    label: "Coli Schedule",
    description: [
      "安排一个延时任务，由监督模型在多个轮次中评估工作 Agent 的完成情况。",
      "监督模型仅评估，不执行任何文件读写或命令。",
    ].join(" "),
    promptSnippet: "安排延时任务，由另一个模型在最多 N 轮内监督完成",
    promptGuidelines: [
      "当你想在稍后执行某任务（如代码生成完成后验证、等待外部变更稳定、批量任务），使用 coli_schedule。监督模型只做评估，任务由当前工作 Agent 实际执行。",
    ],
    parameters: Type.Object({
      delay_seconds: Type.Number({
        description: "触发前的延迟秒数",
      }),
      task_description: Type.String({
        description: "工作 Agent 应完成的任务描述",
      }),
      max_rounds: Type.Optional(
        Type.Number({
          description: `最大监督轮次（默认 ${config.maxRounds}，范围 1-20）`,
          default: config.maxRounds,
        }),
      ),
      supervisor_model: Type.Optional(
        Type.String({
          description:
            '监督模型 "provider/modelId"（默认使用 /coli setup 配置的模型）',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const delayMs = params.delay_seconds * 1000;
      const triggerAt = Date.now() + delayMs;
      const maxRounds = Math.max(1, Math.min(20, params.max_rounds ?? config.maxRounds));

      // Resolve supervisor model
      let sp = "";
      let sm = "";
      if (params.supervisor_model) {
        const idx = params.supervisor_model.indexOf("/");
        if (idx > 0) {
          sp = params.supervisor_model.slice(0, idx);
          sm = params.supervisor_model.slice(idx + 1);
        }
      }

      if (sp && sm) {
        // Explicit model from params
        const m = ctx.modelRegistry.find(sp, sm);
        if (!m) {
          return {
            content: [
              {
                type: "text" as const,
                text: `监督模型未找到: ${sp}/${sm}。任务未创建。`,
              },
            ],
            details: {},
          };
        }
      } else {
        // Use configured or auto-discovered
        const sup = await resolveSupervisorModel(ctx);
        if (!sup) {
          return {
            content: [
              {
                type: "text" as const,
                text: "没有可用的监督模型。请先运行 /coli setup model。",
              },
            ],
            details: {},
          };
        }
        sp = sup.provider;
        sm = sup.id;
      }

      const task: ScheduledTask = {
        id: uid(),
        description: params.task_description,
        triggerAt,
        maxRounds,
        currentRound: 0,
        status: "pending",
        supervisorProvider: sp,
        supervisorModelId: sm,
        roundSummaries: [],
        createdAt: Date.now(),
        supervisorUsage: { prompts: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
      };

      tasks.set(task.id, task);
      persistTask(pi, task);
      schedule(task, () => fireTask(pi, task));

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `\u2713 Coli task scheduled [${task.id}]`,
              `Trigger: ${fmtTime(triggerAt)} (in ${params.delay_seconds}s)`,
              `Task: ${params.task_description}`,
              `Supervisor: ${sp}/${sm}`,
              `Max rounds: ${maxRounds}`,
            ].join("\n"),
          },
        ],
        details: { taskId: task.id, triggerAt, status: "pending" },
      };
    },
  });

  // =========================================================================
  // Events
  // =========================================================================

  pi.on("session_start", (_event, ctx) => {
    restoreFromSession(pi, ctx.sessionManager.getEntries());
  });

  pi.on("session_shutdown", () => {
    cancelAll();
    tasks.clear();
  });

  pi.on("agent_end", async (event, ctx) => {
    const running = Array.from(tasks.values()).filter(
      (t) => t.status === "running",
    );
    if (running.length === 0) return;
    if (supervisionActive) return;

    supervisionActive = true;
    try {
      for (const task of running) {
        if (task.status !== "running") continue;
        await runSupervisionRound(pi, task, event.messages, ctx);
      }
    } finally {
      supervisionActive = false;
    }
  });
}
