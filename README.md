# Coli — Scheduled Task Supervisor for pi

[中文文档](./README.zh-CN.md)

Coli is a `pi-coding-agent` extension for **deferred execution + multi-round supervision**:

- The working agent does the task with full tools/context.
- A different supervisor model evaluates each round (`done` / `continue` / `fail`).
- Supervision is bounded by `maxRounds` (default: `5`, range: `1-20`).

---

## Install

```bash
pi install git:github.com/cocolinfff/pi-coli
```

Then run `/reload` (or restart pi).

## Quick Start (Usage First)

### 1) Configure a supervisor model (required once)

```text
/coli setup model
```

This auto-discovers available models and prefers any model whose display name contains `[coli]`.

You can also set one explicitly:

```text
/coli setup model anthropic/claude-haiku-4-5
```

### 2) Schedule a task

```text
/coli schedule in 2 minutes Check and fix TypeScript errors under src/
```

Example output:

```text
✓ Coli task scheduled [a1b2c3d4]
Trigger: 14:32:00 (1m 58s)
Task: Check and fix TypeScript errors under src/
Supervisor: anthropic/claude-haiku-4-5
Max rounds: 5
```

After the trigger time, Coli injects the task into the current session as a follow-up message and starts supervision on each `agent_end` event.

---

## Command Reference

| Command | Description |
| --- | --- |
| `/coli help` | Show help |
| `/coli setup` | Show current config |
| `/coli setup model` | Auto-discover supervisor model (prefers `[coli]`) |
| `/coli setup model <provider>/<modelId>` | Set supervisor model explicitly |
| `/coli setup rounds <n>` | Set default max rounds (`1-20`) |
| `/coli setup reset` | Reset config |
| `/coli schedule <when> <task>` | Schedule a supervised task |
| `/coli list` | List all tasks |
| `/coli cancel <id>` | Cancel one task |

### Time formats for `/coli schedule`

| Format | Example |
| --- | --- |
| `in X minutes` | `in 10 minutes` |
| `in X hours` | `in 2 hours` |
| `in X seconds` | `in 30 seconds` |
| `at HH:MM` | `at 15:30` |
| Milliseconds delay | `300000` |

---

## Tool: `coli_schedule`

LLMs can schedule follow-up tasks directly via tool call.

| Parameter | Type | Description |
| --- | --- | --- |
| `delay_seconds` | `number` | Delay before trigger |
| `task_description` | `string` | Task for working agent |
| `max_rounds` | `number` (optional) | Max rounds override (`1-20`) |
| `supervisor_model` | `string` (optional) | Supervisor model in `provider/modelId` |

Example:

```json
coli_schedule({
  "delay_seconds": 300,
  "task_description": "Run npm test and fix failing cases"
})
```

---

## How It Works

```text
User / LLM -> schedule task (delay + supervisor) -> timer fires
                                                  |
                                                  v
                                     Working agent executes task
                                                  |
                                               agent_end
                                                  |
                                                  v
                                   Supervisor evaluates this round
                               -> done | continue | fail decision
```

### Model selection priority

1. Explicit config from `/coli setup model <provider>/<id>`
2. First available model whose name includes `[coli]`
3. First available model
4. Current session model (last fallback)

### Safety and limits

- Supervisor is evaluation-only (no file I/O, no command execution).
- Hard round cap (`maxRounds`) prevents infinite loops.
- Task timers are session-bound and in-memory.
- On `session_shutdown`, active timers are cleaned up.

---

## Practical Examples

### Delayed review

```text
/coli schedule in 5 minutes Review all changes under src/auth/, find security/logic issues, and fix them
```

### Nightly test-and-fix

```text
/coli schedule at 02:00 Run npm test, analyze failures, fix code, rerun until all tests pass
```

### Self-scheduled follow-up

Ask the working agent to refactor first, then let it call `coli_schedule` for post-check validation.

---

## Limitations

- Timer precision is second-level, not exact millisecond real-time.
- If pi stops, in-memory timers are lost.
- Supervision uses one-shot model calls and depends on provider/API availability.

## License

MIT
