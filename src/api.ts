/**
 * api.ts
 * All REST endpoints for the automation server, as a mountable Router.
 *
 * Listing routes are scoped to this runner by db.ts. The two trigger routes
 * are the exception: they take an id or a name a caller chose, so they check
 * ownership themselves and answer 409 rather than letting the executor drop
 * the request silently.
 */

import { Router, type Request, type Response } from 'express';
import * as db from './db.js';
import * as redis from './redis.js';
import { executeTask, getActiveRuns } from './executor.js';
import { reloadSchedule, reloadAllSchedules } from './scheduler.js';
import { runner } from './config.js';

export const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(res: Response, data: unknown) {
    res.json({ success: true, data });
}

function fail(res: Response, message: string, status = 400) {
    res.status(status).json({ success: false, error: message });
}

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
        const task = await db.getTaskById(Number(req.params.id));
        if (!task) return fail(res, 'Task not found', 404);
        if (task.Runner !== runner()) return fail(res, `Task belongs to runner "${task.Runner}"`, 409);
        ok(res, task);
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// PATCH /tasks/:id — update isActive, RetryLimit, RetryDelaySeconds, Description
router.patch('/tasks/:id', async (req: Request, res: Response) => {
    try {
        const id = Number(req.params.id);
        const task = await db.getTaskById(id);
        if (!task) return fail(res, 'Task not found', 404);
        if (task.Runner !== runner()) return fail(res, `Task belongs to runner "${task.Runner}"`, 409);

        const allowed = ['isActive', 'RetryLimit', 'RetryDelaySeconds', 'Description'] as const;
        const fields: Record<string, unknown> = {};

        for (const key of allowed) {
            if (key in req.body) fields[key] = req.body[key];
        }

        if (Object.keys(fields).length === 0) return fail(res, 'No valid fields to update');

        await db.updateTask(id, fields as any);

        // Sync Redis active flag if isActive changed
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
        const taskId = Number(req.params.id);
        const task = await db.getTaskById(taskId);
        if (!task) return fail(res, 'Task not found', 404);
        if (task.Runner !== runner()) {
            return fail(res, `Task "${task.Name}" belongs to runner "${task.Runner}" — trigger it on that runner.`, 409);
        }
        const triggeredBy = req.body?.triggeredBy === 'manual' ? 'manual' : 'api';

        // Fire-and-forget — don't await, return immediately
        executeTask({ taskId, triggeredBy }).catch(console.error);

        ok(res, { message: `Task "${task.Name}" triggered`, taskId });
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

        const task = await db.getTaskById(Number(taskId));
        if (!task) return fail(res, 'Task not found', 404);
        if (task.Runner !== runner()) return fail(res, `Task belongs to runner "${task.Runner}"`, 409);

        const id = await db.createSchedule(Number(taskId), cronExpression, isActive);

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
        const id = Number(req.params.id);
        const allowed = ['CronExpression', 'isActive'] as const;
        const fields: Record<string, unknown> = {};

        for (const key of allowed) {
            if (key in req.body) fields[key] = req.body[key];
        }

        if (Object.keys(fields).length === 0) return fail(res, 'No valid fields to update');

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
        const id = Number(req.params.id);
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
        const taskId = Number(req.params.id);
        const limit = Number(req.query.limit ?? 20);
        const runs = await db.getRunsForTask(taskId, limit);
        ok(res, runs);
    } catch (err: any) {
        fail(res, err.message, 500);
    }
});

// GET /runs?limit=100&status=&taskId= — run history across this runner's tasks
router.get('/runs', async (req: Request, res: Response) => {
    try {
        const limit = Math.min(Number(req.query.limit ?? 100), 10_000);
        const statusFilter = req.query.status as string | undefined;
        const taskIdFilter = req.query.taskId ? Number(req.query.taskId) : undefined;
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
