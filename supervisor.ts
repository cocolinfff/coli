/**
 * Coli Extension – Supervisor
 *
 * Calls the supervisor model (a different model from the working agent)
 * via the pi-ai `complete()` function.  The supervisor is strictly
 * evaluation-only — it cannot read files or execute commands.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { complete } from "@mariozechner/pi-ai";
import {
  type ScheduledTask,
  type SupervisorDecision,
  type SupervisorUsage,
  SUPERVISOR_SYSTEM_PROMPT,
} from "./types.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MAX_SUMMARY_CHARS = 4000;
const MAX_TOOL_RESULT_CHARS = 800;
const MAX_ERROR_CHARS = 200;

// ---------------------------------------------------------------------------
// Build turn summary from AgentMessage[] (event.messages in agent_end)
// ---------------------------------------------------------------------------

/**
 * Walk the AgentMessage[] produced by the just-finished turn and build a
 * summary that includes tool calls WITH their results — so the supervisor
 * sees execution evidence, not just the final text.
 */
function buildTurnSummary(messages: AgentMessage[]): string {
  const toolCalls: Array<{ name: string; args: string; result: string }> = [];
  const assistantTexts: string[] = [];

  for (const msg of messages) {
    // AgentMessage has .role directly, not wrapped in SessionEntry
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text" && part.text.trim()) {
          assistantTexts.push(part.text.trim());
        } else if (part.type === "toolCall") {
          const args =
            part.name === "bash"
              ? (part.arguments as any)?.command ?? ""
              : part.name === "read" ||
                  part.name === "write" ||
                  part.name === "edit"
                ? (part.arguments as any)?.path ?? ""
                : "";
          const argsStr =
            typeof args === "string" ? args : JSON.stringify(args);
          toolCalls.push({
            name: part.name,
            args:
              argsStr.length > 200 ? argsStr.slice(0, 200) + "..." : argsStr,
            result: "",
          });
        }
      }
    }

    if (msg.role === "toolResult") {
      const toolName = msg.toolName || "";
      const resultText = (msg.content || [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join("\n");
      const truncated =
        resultText.length > MAX_TOOL_RESULT_CHARS
          ? resultText.slice(0, MAX_TOOL_RESULT_CHARS) +
            "\n[...result truncated...]"
          : resultText;

      for (let i = toolCalls.length - 1; i >= 0; i--) {
        if (toolCalls[i].name === toolName && !toolCalls[i].result) {
          toolCalls[i].result = truncated;
          break;
        }
      }
    }
  }

  // Assemble
  const lines: string[] = [];

  if (toolCalls.length > 0) {
    lines.push("Agent actions this round:");
    for (const tc of toolCalls) {
      const label = tc.name === "bash" ? "$" : tc.name;
      lines.push(`  → ${label} ${tc.args || "(no args)"}`);
      if (tc.result) {
        for (const l of tc.result.split("\n")) {
          lines.push("    " + l);
        }
      }
    }
    lines.push("");
  }

  const conclusion = assistantTexts.join("\n").trim();
  if (conclusion) {
    lines.push("Agent conclusion:");
    lines.push(conclusion);
  } else if (toolCalls.length === 0) {
    lines.push("(agent produced no text and no tool calls)");
  }

  const full = lines.join("\n");
  return full.length > MAX_SUMMARY_CHARS
    ? full.slice(0, MAX_SUMMARY_CHARS) +
        "\n\n[... summary truncated to " +
        MAX_SUMMARY_CHARS +
        " chars ...]"
    : full;
}

// ---------------------------------------------------------------------------
// Build supervisor prompt
// ---------------------------------------------------------------------------

function buildSupervisorPrompt(
  task: ScheduledTask,
  summary: string,
): string {
  const lines: string[] = [];

  lines.push(`Task: ${task.description}`);
  lines.push(`Round: ${task.currentRound}/${task.maxRounds}`);

  if (task.roundSummaries.length > 0) {
    const history = task.roundSummaries
      .map(
        (r) =>
          `R${r.round}: ${r.decision}${
            r.instruction ? " → " + r.instruction.slice(0, 80) : ""
          }`,
      )
      .join("\n");
    lines.push(`Prior rounds:\n${history}`);
  }

  lines.push("");
  lines.push(summary);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Parse supervisor response
// ---------------------------------------------------------------------------

function parseDecision(text: string): SupervisorDecision {
  const trimmed = text.trim();

  try {
    const obj = JSON.parse(trimmed) as {
      status?: string;
      instruction?: string;
    };
    return normalize(obj);
  } catch {
    /* fall through */
  }

  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as {
        status?: string;
        instruction?: string;
      };
      return normalize(obj);
    } catch {
      /* fall through */
    }
  }

  return {
    status: "fail",
    instruction:
      "Supervisor returned non-JSON: " + trimmed.slice(0, MAX_ERROR_CHARS),
  };
}

function normalize(obj: {
  status?: string;
  instruction?: string;
}): SupervisorDecision {
  const status = obj.status as SupervisorDecision["status"];
  if (!status || !["done", "continue", "fail"].includes(status)) {
    return {
      status: "fail",
      instruction: `Invalid status: ${obj.status ?? "missing"}`,
    };
  }
  return {
    status,
    instruction: (obj.instruction || "").slice(0, 200),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EvaluationResult {
  decision: SupervisorDecision;
  usage: SupervisorUsage;
}

export async function evaluate(
  task: ScheduledTask,
  agentEndMessages: AgentMessage[],
  ctx: ExtensionContext,
): Promise<EvaluationResult> {
  const zeroUsage: SupervisorUsage = { prompts: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  const summary = buildTurnSummary(agentEndMessages);

  const model = ctx.modelRegistry.find(
    task.supervisorProvider,
    task.supervisorModelId,
  );
  if (!model) {
    return {
      decision: {
        status: "fail",
        instruction: `Supervisor model not found: ${task.supervisorProvider}/${task.supervisorModelId}`,
      },
      usage: zeroUsage,
    };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return {
      decision: {
        status: "fail",
        instruction: `Supervisor API key missing: ${auth.error || "unknown"}`,
      },
      usage: zeroUsage,
    };
  }

  const prompt = buildSupervisorPrompt(task, summary);

  // Debug: log what the supervisor actually receives (to stderr)
  const preview =
    summary.length > 500 ? summary.slice(0, 500) + "..." : summary;
  console.error(
    `[coli] supervisor input (${summary.length} chars):\n---\n${preview}\n---`,
  );

  try {
    const response = await complete(
      model,
      {
        systemPrompt: SUPERVISOR_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: auth.apiKey, headers: auth.headers },
    );

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const usage: SupervisorUsage = {
      prompts: 1,
      inputTokens: response.usage?.input ?? 0,
      outputTokens: response.usage?.output ?? 0,
      cost: response.usage?.cost?.total ?? 0,
    };

    const decision = parseDecision(text);
    console.error(
      `[coli] supervisor: ${decision.status} | ↑${usage.inputTokens} ↓${usage.outputTokens} $${usage.cost.toFixed(4)} | "${decision.instruction.slice(0, 80)}"`,
    );
    return { decision, usage };
  } catch (err: any) {
    return {
      decision: {
        status: "fail",
        instruction: `Supervisor call failed: ${err?.message || String(err)}`.slice(
          0,
          MAX_ERROR_CHARS,
        ),
      },
      usage: zeroUsage,
    };
  }
}
