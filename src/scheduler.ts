/**
 * scheduler.ts
 * Loads this runner's active schedules from the DB, registers node-cron jobs,
 * and polls its own Redis trigger queue for on-demand runs.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { getActiveSchedules } from './db.js';
import { popTriggers } from './redis.js';
import { executeTask } from './executor.js';
import { runner } from './config.js';
import type { AutomSchedule } from './types.js';

// ─── Registry of live cron jobs ───────────────────────────────────────────────

interface RegisteredJob {
    schedule: AutomSchedule;
    job: ScheduledTask;
}

const jobs = new Map<number, RegisteredJob>(); // keyed by idAutom_Schedule

// ─── Boot ─────────────────────────────────────────────────────────────────────

export async function startScheduler(): Promise<void> {
    console.log(`[Scheduler] Loading schedules for runner "${runner()}"...`);
    const schedules = await getActiveSchedules();

    for (const schedule of schedules) {
        registerJob(schedule);
    }

    console.log(`[Scheduler] ${jobs.size} schedule(s) registered.${process.platform === 'win32' ? ' (windows — cron disabled)' : ''}`);

    // Poll for on-demand triggers every 2 seconds
    startTriggerQueuePoller();
}

// ─── Register / unregister ────────────────────────────────────────────────────

function registerJob(schedule: AutomSchedule): void {
    if (jobs.has(schedule.idAutom_Schedule)) {
        // Already registered — destroy old one first
        unregisterJob(schedule.idAutom_Schedule);
    }

    if (!cron.validate(schedule.CronExpression)) {
        console.warn(`[Scheduler] Invalid cron expression "${schedule.CronExpression}" for schedule #${schedule.idAutom_Schedule} — skipping.`);
        return;
    }

    if (process.platform === 'win32') return;

    const job = cron.schedule(schedule.CronExpression, () => {
        console.log(`[Scheduler] Firing schedule #${schedule.idAutom_Schedule} for task #${schedule.Autom_Task_id}`);
        executeTask({
            taskId: schedule.Autom_Task_id,
            scheduleId: schedule.idAutom_Schedule,
            triggeredBy: 'scheduler',
        }).catch((err) => {
            console.error(`[Scheduler] Unhandled error for schedule #${schedule.idAutom_Schedule}:`, err);
        });
    });

    jobs.set(schedule.idAutom_Schedule, { schedule, job });
    console.log(`[Scheduler] Registered schedule #${schedule.idAutom_Schedule} → task #${schedule.Autom_Task_id} @ "${schedule.CronExpression}"`);
}

function unregisterJob(scheduleId: number): void {
    const entry = jobs.get(scheduleId);
    if (!entry) return;
    entry.job.stop();
    jobs.delete(scheduleId);
    console.log(`[Scheduler] Unregistered schedule #${scheduleId}`);
}

// ─── Hot reload (called by the API after schedule changes) ────────────────────

export async function reloadSchedule(scheduleId: number, schedule?: AutomSchedule | null): Promise<void> {
    if (!schedule || schedule.isActive === 0) {
        unregisterJob(scheduleId);
        return;
    }
    registerJob(schedule);
}

export async function reloadAllSchedules(): Promise<void> {
    console.log('[Scheduler] Reloading all schedules...');

    for (const id of jobs.keys()) {
        unregisterJob(id);
    }

    const schedules = await getActiveSchedules();
    for (const schedule of schedules) {
        registerJob(schedule);
    }

    console.log(`[Scheduler] Reloaded — ${jobs.size} schedule(s) active.`);
}

// ─── Redis trigger queue poller ───────────────────────────────────────────────

let pollerTimer: ReturnType<typeof setInterval> | null = null;

function startTriggerQueuePoller(): void {
    pollerTimer = setInterval(async () => {
        try {
            const triggers = await popTriggers();
            for (const trigger of triggers) {
                console.log(`[Scheduler] On-demand trigger for task #${trigger.taskId} via "${trigger.triggeredBy}"`);
                executeTask({
                    taskId: trigger.taskId,
                    scheduleId: trigger.scheduleId ?? null,
                    triggeredBy: trigger.triggeredBy,
                }).catch(console.error);
            }
        } catch (err) {
            console.error('[Scheduler] Trigger queue poll error:', err);
        }
    }, 2000);
}

export function stopScheduler(): void {
    for (const id of jobs.keys()) {
        unregisterJob(id);
    }
    if (pollerTimer) clearInterval(pollerTimer);
    console.log('[Scheduler] Stopped.');
}
