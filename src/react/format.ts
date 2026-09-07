/**
 * format.ts
 * Display helpers for the dashboard. Pure functions — no React, no DOM.
 */

import type { AutomTaskRun, TaskStatus, TriggerSource } from '../types.js';

/** Eight slots, then everyone else shares the ninth. Colours are hues on a fixed
 *  saturation so they stay distinguishable in both themes without a palette per
 *  theme; the CSS supplies the lightness through --autom-task-l. */
const TASK_HUES = [152, 210, 32, 280, 0, 190, 60, 320];

export function taskHue(taskId: number, index: number): number {
    return TASK_HUES[index % TASK_HUES.length] ?? TASK_HUES[taskId % TASK_HUES.length];
}

export function taskColor(taskId: number, index: number): string {
    return `hsl(${taskHue(taskId, index)} 45% var(--autom-task-l, 42%))`;
}

/** Worst-wins, for a chip that stands for several runs at once. */
export const STATUS_SEVERITY: Record<TaskStatus, number> = {
    failed: 4,
    timeout: 4,
    running: 3,
    pending: 2,
    completed: 1,
};

export function worstStatus(statuses: TaskStatus[]): TaskStatus {
    return statuses.reduce((worst, s) => (STATUS_SEVERITY[s] > STATUS_SEVERITY[worst] ? s : worst), 'completed' as TaskStatus);
}

export const STATUS_ICON: Record<TaskStatus, string> = {
    completed: '✓',
    failed: '✗',
    timeout: '⏱',
    running: '⟳',
    pending: '…',
};

export const TRIGGER_ICON: Record<TriggerSource, string> = {
    scheduler: '🕒',
    manual: '▶',
    api: '⚡',
};

/** Milliseconds a run took, or null while it is still going. */
export function runDurationMs(run: AutomTaskRun): number | null {
    if (!run.FinishedAt) return null;
    const started = new Date(run.StartedAt).getTime();
    const finished = new Date(run.FinishedAt).getTime();
    if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
    return Math.max(0, finished - started);
}

export function formatDuration(ms: number | null): string {
    if (ms === null) return '—';
    if (ms < 1000) return `${ms} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = Math.floor(s / 60);
    const rest = Math.round(s % 60);
    if (m < 60) return `${m} min ${rest}s`;
    const h = Math.floor(m / 60);
    return `${h} h ${m % 60}min`;
}

/** Local YYYY-MM-DD. Not toISOString(), which would shift the day near midnight
 *  for anyone east or west of UTC and put runs in the wrong calendar cell. */
export function dayKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function hhmm(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Monday-first, matching the calendar grid. */
export function startOfWeek(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const shift = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - shift);
    return d;
}

export function addDays(date: Date, days: number): Date {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

export function sameDay(a: Date, b: Date): boolean {
    return dayKey(a) === dayKey(b);
}

export function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
}
