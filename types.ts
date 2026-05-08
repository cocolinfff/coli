/**
 * Coli Extension – Type Definitions
 *
 * Coli is a scheduled-task supervisor for pi. It defers prompts to a
 * specified time, then uses a different model (the supervisor) to
 * evaluate the working agent's output across a limited number of rounds.
 */

/** Possible states of a scheduled task. */
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** Decision returned by the supervisor model after evaluating one round. */
export interface SupervisorDecision {
  status: "done" | "continue" | "fail";
  /** Human-readable reason / next instruction for the working agent. */
  instruction: string;
}

/** A scheduled task managed by the coli extension. */
export interface ScheduledTask {
  /** Unique identifier (auto-generated). */
  id: string;
  /** Human-readable description of what the working agent should accomplish. */
  description: string;
  /** UNIX timestamp (ms) when the task should be triggered. */
  triggerAt: number;
  /** Maximum number of supervisor evaluation rounds (default from config). */
  maxRounds: number;
  /** Current round number (0 = not started). */
  currentRound: number;
  /** Current status. */
  status: TaskStatus;
  /**
   * Provider and model ID for the supervisor.
   * The working agent uses whatever model is currently active in the pi session.
   */
  supervisorProvider: string;
  supervisorModelId: string;
  /** Optional: override the working model when the task triggers. */
  workingProvider?: string;
  workingModelId?: string;
  /** Summary of each completed round for display and recovery. */
  roundSummaries: RoundSummary[];
  /** When the task was created. */
  createdAt: number;
  /** Cumulative supervisor usage (tokens, prompts, cost). */
  supervisorUsage: SupervisorUsage;
}

/** Token / cost usage from one supervisor model call. */
export interface SupervisorUsage {
  /** Number of supervision prompts sent (cumulative across rounds). */
  prompts: number;
  /** Total input tokens across all supervision calls. */
  inputTokens: number;
  /** Total output tokens across all supervision calls. */
  outputTokens: number;
  /** Total estimated cost in USD (if available). */
  cost: number;
}

/** Summary of a single supervision round. */
export interface RoundSummary {
  round: number;
  workerOutputPreview: string;
  decision: "done" | "continue" | "fail";
  instruction: string;
  timestamp: number;
  /** Tokens used for this round's supervisor call. */
  inputTokens?: number;
  outputTokens?: number;
}

/** Serialised form persisted via pi.appendEntry / restored on session_start. */
export interface PersistedTask {
  id: string;
  description: string;
  triggerAt: number;
  maxRounds: number;
  currentRound: number;
  status: TaskStatus;
  supervisorProvider: string;
  supervisorModelId: string;
  workingProvider?: string;
  workingModelId?: string;
  roundSummaries: RoundSummary[];
  createdAt: number;
  supervisorUsage: SupervisorUsage;
}

// -------------------------------------------------------------------------
// Config
// -------------------------------------------------------------------------

/** Default config values. */
export const DEFAULT_MAX_ROUNDS = 5;

export interface ColiConfig {
  /** Default supervisor provider ("anthropic") */
  supervisorProvider: string;
  /** Default supervisor model id ("claude-haiku-4-5") */
  supervisorModelId: string;
  /** Default max supervision rounds (1-20). */
  maxRounds: number;
  /** Time of last setup. */
  updatedAt: number;
}

export function defaultConfig(): ColiConfig {
  return {
    supervisorProvider: "",
    supervisorModelId: "",
    maxRounds: DEFAULT_MAX_ROUNDS,
    updatedAt: 0,
  };
}

// -------------------------------------------------------------------------
// Supervisor system prompt – token-efficient, strictly evaluation-only
// -------------------------------------------------------------------------

export const SUPERVISOR_SYSTEM_PROMPT = `You are Coli, a task supervisor. Your ONLY job is to evaluate whether a WORKING AGENT (not you) has finished a given task. You are NOT the worker.

You will receive a turn summary showing:
- Tool calls the agent made (bash, read, write, edit, …)
- The output/results of those tool calls
- The agent's final text conclusion

CRITICAL RULES:
- You CANNOT read files, run commands, or do any work yourself.
- You are a PURE EVALUATOR. Look at the tool call evidence (bash output, file contents, etc.) to judge completion.
- If the agent's tool output clearly shows the task was done, mark "done" — do NOT ask for redundant re-execution.
- Keep your response EXTREMELY short — 1-3 sentences max.
- Reply with ONLY a JSON object, no other text:

{"status":"done|continue|fail","instruction":"short reason or next step"}

STATUS:
- "done" — task fully completed. Tool output shows clear evidence of success.
- "continue" — progress made but not done. Give ONE specific next action (≤1 sentence).
- "fail" — cannot complete (missing files, repeated errors, agent gave up). Brief reason.`;
