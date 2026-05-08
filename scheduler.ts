/**
 * Coli Extension – Scheduler
 *
 * Manages in-memory task timers with a setTimeout + polling fallback
 * to survive OS sleep / hibernation.
 */

import type { ScheduledTask } from "./types.js";

/** Running timers keyed by task id. */
const timers = new Map<string, NodeJS.Timeout>();
/** Polling intervals keyed by task id. */
const intervals = new Map<string, NodeJS.Timeout>();

/**
 * Schedule a task for execution.
 * @param task    The task to schedule.
 * @param execute Callback invoked when the trigger time is reached.
 */
export function schedule(
  task: ScheduledTask,
  execute: (task: ScheduledTask) => void,
): void {
  cancel(task.id);

  const delay = Math.max(0, task.triggerAt - Date.now());

  // Primary timer
  const timerId = setTimeout(() => {
    clearInterval(intervals.get(task.id));
    intervals.delete(task.id);
    timers.delete(task.id);
    execute(task);
  }, delay);
  timers.set(task.id, timerId);

  // Polling fallback every 30 s – catches OS sleep / hibernation drift
  const intervalId = setInterval(() => {
    if (task.status === "pending" && Date.now() >= task.triggerAt) {
      clearTimeout(timers.get(task.id)!);
      clearInterval(intervalId);
      timers.delete(task.id);
      intervals.delete(task.id);
      execute(task);
    }
  }, 30_000);
  intervals.set(task.id, intervalId);
}

/** Cancel a scheduled task (remove its timers). */
export function cancel(taskId: string): void {
  const timerId = timers.get(taskId);
  if (timerId) {
    clearTimeout(timerId);
    timers.delete(taskId);
  }
  const intervalId = intervals.get(taskId);
  if (intervalId) {
    clearInterval(intervalId);
    intervals.delete(taskId);
  }
}

/** Cancel all timers (called on session_shutdown). */
export function cancelAll(): void {
  for (const id of timers.keys()) cancel(id);
}
