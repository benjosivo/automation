/**
 * api.ts
 * All REST endpoints for the automation server, as a mountable Router.
 *
 * Listing routes are scoped to this runner by db.ts. Routes that take an id or a
 * name the caller chose check ownership themselves and answer 409, rather than
 * letting the executor drop the request silently or letting one runner edit
 * another's rows.
 *
 * Nothing here authenticates anything. A host that exposes these routes is the
 * one responsible for deciding who may reach them — see proxy.ts.
 */

import { Router, type Request, type Response } from 'express';
import cron from 'node-cron';
import * as db from './db.js';
import * as redis from './redis.js';
import { executeTask, getActiveRuns } from './executor.js';
import { reloadSchedule, reloadAllSchedules } from './scheduler.js';
import { runner } from './config.js';
import { isValidCron } from './cron.js';

export const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(res: Response, data: unknown) {
    res.json({ success: true, data });
}

function fail(res: Response, message: string, status = 400) {
    res.status(status).json({ success: false, error: message });
}

/** A positive integer, or null. Number('abc') is NaN, and a NaN that reaches a
 *  LIMIT or a WHERE comes back as a raw MySQL error inside a 500. */
function posInt(raw: unknown): number | null {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Two graders, and both have to pass.
 *
 * node-cron decides whether the scheduler will register the job at all:
 * registerJob() warns and returns on an expression it refuses, which leaves a
 * schedule reading as active in every listing and never firing. That silent
 * state is what this guard exists to make unreachable.
 *
 * parseCron decides whether the five-field form the rest of the package speaks —
 * previews, next occurrences, the calendar — can hold it. node-cron would also
 * take a sixth seconds field, which nothing else here understands and which a
 * two-second trigger poller could not honour anyway.
 */
function cronError(expr: unknown): string | null {
    if (typeof expr !== 'string' || !cron.validate(expr) || !isValidCron(expr)) {
        return `Invalid cron expression ${JSON.stringify(expr)} — five fields expected: minute hour day-of-month month day-of-week`;
    }
    return null;
}

/** The ownership preamble every id-addressed task route shares. Answers on the
 *  response and returns null when the caller may not have this task. */
async function ownedTask(res: Response, rawId: unknown) {
    const id = posInt(rawId);
    if (id === null) {
        fail(res, 'Task id must be a positive integer');
        return null;
    }
    const task = await db.getTaskById(id);
    if (!task) {
        fail(res, 'Task not found', 404);
        return null;
    }
    if (task.Runner !== runner()) {
        fail(res, `Task belongs to runner "${task.Runner}"`, 409);
        return null;
    }
    return task;
}

/** Same, for a schedule — whose runner comes from its parent task. */
async function ownedSchedule(res: Response, rawId: unknown) {
    const id = posInt(rawId);
    if (id === null) {
        fail(res, 'Schedule id must be a positive integer');
        return null;
    }
    const schedule = await db.getScheduleById(id);
    if (!schedule) {
        fail(res, 'Schedule not found', 404);
        return null;
    }
    if (schedule.Runner !== runner()) {
        fail(res, `Task belongs to runner "${schedule.Runner}"`, 409);
        return null;
    }
    return schedule;
}

// ─── Health ───────────────────────────────────────────────────────────────────

/** Inside the router, unlike the standalone server's /healthcheck, so that a host
 *  mounting or proxying this router has a reachable liveness probe. */
router.get('/health', (_req: Request, res: Response) => {
    ok(res, { runner: runner(), uptime: process.uptime() });
});

// ─── Tasks ────────────────────────────────────────────────────────────────────

// GET /tasks — this runner's tasks
router.get('/tasks', async (_req: Request, res: Response) => {
    try {
        const tasks = await db.getAllTasks();
        ok(res, tasks);
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// GET /tasks/:id — single task detail
router.get('/tasks/:id', async (req: Request, res: Response) => {
    try {
        const task = await ownedTask(res, req.params.id);
        if (task) ok(res, task);
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// PATCH /tasks/:id — update isActive, RetryLimit, RetryDelaySeconds, Description
router.patch('/tasks/:id', async (req: Request, res: Response) => {
    try {
        const task = await ownedTask(res, req.params.id);
        if (!task) return;
        const id = task.idAutom_Task;

        const allowed = ['isActive', 'RetryLimit', 'RetryDelaySeconds', 'Description'] as const;
        const fields: Record<string, unknown> = {};

        for (const key of allowed) {
            if (key in req.body) fields[key] = req.body[key];
        }

        if (Object.keys(fields).length === 0) return fail(res, 'No valid fields to update');

        // Normalised before anything is written. A client sending {"isActive":true}
        // used to store 1 in MySQL (mysql2 converts) while the Redis flag below
        // took `false` — and the executor reads Redis first, so the task showed as
        // active and never ran again.
        if ('isActive' in fields) {
            fields.isActive = Number(fields.isActive) === 1 ? 1 : 0;
        }

        await db.updateTask(id, fields as any);

        if ('isActive' in fields) {
            await redis.setTaskActiveFlag(id, fields.isActive === 1);
        }

        ok(res, { updated: id });
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// POST /tasks/:id/trigger — immediately run a task
router.post('/tasks/:id/trigger', async (req: Request, res: Response) => {
    try {
        const task = await ownedTask(res, req.params.id);
        if (!task) return;

        const triggeredBy = req.body?.triggeredBy === 'manual' ? 'manual' : 'api';

        // Fire-and-forget — don't await, return immediately
        executeTask({ taskId: task.idAutom_Task, triggeredBy }).catch(console.error);

        ok(res, { message: `Task "${task.Name}" triggered`, taskId: task.idAutom_Task });
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// POST /tasks/trigger-by-name/:name
router.post('/tasks/trigger-by-name/:name', async (req: Request, res: Response) => {
    try {
        const name = String(req.params.name);
        const task = await db.getTaskByName(name);
        if (!task) return fail(res, `Task "${name}" not found`, 404);
        if (task.Runner !== runner()) {
            return fail(res, `Task "${task.Name}" belongs to runner "${task.Runner}" — trigger it on that runner.`, 409);
        }
        executeTask({ taskId: task.idAutom_Task, triggeredBy: 'api' }).catch(console.error);
        ok(res, { message: `Task "${task.Name}" triggered` });
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// ─── Schedules ────────────────────────────────────────────────────────────────

// GET /schedules — this runner's schedules
router.get('/schedules', async (_req: Request, res: Response) => {
    try {
        const schedules = await db.getAllSchedules();
        ok(res, schedules);
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// POST /schedules — add a schedule
router.post('/schedules', async (req: Request, res: Response) => {
    try {
        const { taskId, cronExpression, isActive = 1 } = req.body;
        if (!taskId || !cronExpression) return fail(res, 'taskId and cronExpression are required');

        const task = await ownedTask(res, taskId);
        if (!task) return;

        const cronIssue = cronError(cronExpression);
        if (cronIssue) return fail(res, cronIssue);

        const active = Number(isActive) === 1 ? 1 : 0;
        const id = await db.createSchedule(task.idAutom_Task, cronExpression, active);

        // Hot-load the new schedule
        const schedules = await db.getAllSchedules();
        const created = schedules.find((s) => s.idAutom_Schedule === id) ?? null;
        if (created?.isActive) await reloadSchedule(id, created);

        ok(res, { created: id });
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// PATCH /schedules/:id — update cron or isActive
router.patch('/schedules/:id', async (req: Request, res: Response) => {
    try {
        const schedule = await ownedSchedule(res, req.params.id);
        if (!schedule) return;
        const id = schedule.idAutom_Schedule;

        const allowed = ['CronExpression', 'isActive'] as const;
        const fields: Record<string, unknown> = {};

        for (const key of allowed) {
            if (key in req.body) fields[key] = req.body[key];
        }

        if (Object.keys(fields).length === 0) return fail(res, 'No valid fields to update');

        if ('CronExpression' in fields) {
            const cronIssue = cronError(fields.CronExpression);
            if (cronIssue) return fail(res, cronIssue);
        }
        if ('isActive' in fields) {
            fields.isActive = Number(fields.isActive) === 1 ? 1 : 0;
        }

        await db.updateSchedule(id, fields as any);

        // Hot-reload affected schedule
        const schedules = await db.getAllSchedules();
        const updated = schedules.find((s) => s.idAutom_Schedule === id) ?? null;
        await reloadSchedule(id, updated);

        ok(res, { updated: id });
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// DELETE /schedules/:id — remove a schedule
router.delete('/schedules/:id', async (req: Request, res: Response) => {
    try {
        // Ownership before reloadSchedule, not after: unregistering first meant a
        // call on an unknown id answered 200 {deleted} having deleted nothing.
        const schedule = await ownedSchedule(res, req.params.id);
        if (!schedule) return;
        const id = schedule.idAutom_Schedule;

        await reloadSchedule(id, null); // unregister from cron first
        await db.deleteSchedule(id);
        ok(res, { deleted: id });
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// POST /schedules/reload — force full reload (useful after bulk changes)
router.post('/schedules/reload', async (_req: Request, res: Response) => {
    try {
        await reloadAllSchedules();
        ok(res, { message: 'Schedules reloaded' });
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// ─── Runs ─────────────────────────────────────────────────────────────────────

// GET /tasks/:id/runs — last N runs for a task
router.get('/tasks/:id/runs', async (req: Request, res: Response) => {
    try {
        const task = await ownedTask(res, req.params.id);
        if (!task) return;

        const limit = Math.min(posInt(req.query.limit) ?? 20, 10_000);
        const runs = await db.getRunsForTask(task.idAutom_Task, limit);
        ok(res, runs);
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// GET /runs?limit=100&status=&taskId= — run history across this runner's tasks
router.get('/runs', async (req: Request, res: Response) => {
    try {
        const limit = Math.min(posInt(req.query.limit) ?? 100, 10_000);
        const statusFilter = req.query.status ? String(req.query.status) : undefined;
        const taskIdFilter = req.query.taskId ? posInt(req.query.taskId) ?? undefined : undefined;
        const runs = await db.getAllRuns({ limit, statusFilter, taskIdFilter });
        ok(res, runs);
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// GET /runs/active — currently running tasks (DB + in-memory)
router.get('/runs/active', async (_req: Request, res: Response) => {
    try {
        const [dbRuns, memRuns] = await Promise.all([db.getRunningTasks(), Promise.resolve(getActiveRuns())]);
        ok(res, {
            db: dbRuns,
            memory: memRuns.map((r) => ({
                runId: r.runId,
                taskId: r.taskId,
                taskName: r.taskName,
                attempt: r.attempt,
                startedAt: r.startedAt,
                concurrencyGroup: r.concurrencyGroup,
            })),
        });
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

export default router;
