/**
 * @benjosivo/automation
 *
 * A cron/task runner whose definitions, schedules, run history and concurrency
 * locks live in MySQL (Autom_* tables, DDL in sql/), with Redis holding the
 * fast-path flags and the on-demand trigger queue. Task code stays with the host
 * and is loaded dynamically at run time — the Autom_Task row is what binds a
 * schedule to a module.
 *
 * Several runners may share one database. Each declares a `runner` name and only
 * ever schedules, recovers and executes the tasks bearing it.
 *
 *     import { startAutomationServer } from '@benjosivo/automation';
 *
 *     startAutomationServer({
 *         runner: 'avosplats',
 *         port: 3001,
 *         mysql: { host, user, password, database },
 *         redisUrl: process.env.REDIS_URL,
 *         onError: handleError,
 *     });
 */

import express from 'express';
import cors from 'cors';
import { init } from '@benjosivo/mysql';

import { setConfig, cfg, runner } from './config.js';
import { timeoutStaleRuns, clearAllLocks, getAllTasks } from './db.js';
import { setTaskActiveFlag, connectRedis } from './redis.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import routes from './api.js';
import type { AutomationConfig } from './types.js';

/**
 * Boot order:
 *   1. Configure, connect MySQL and Redis
 *   2. Mark this runner's stale runs as timeout
 *   3. Clear this runner's orphaned locks
 *   4. Sync this runner's Redis active flags from the DB
 *   5. Start the scheduler (crons + trigger queue poller)
 *   6. Start the Express API
 */
export async function startAutomationServer(config: AutomationConfig): Promise<void> {
    setConfig(config);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(` Automation Server — Starting (runner "${runner()}")`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    await init({ waitForConnections: true, connectionLimit: 50, queueLimit: 0, multipleStatements: true, ...cfg().mysql } as any);
    await connectRedis();

    // ── Recovery: runs that were still 'running' when this runner died ───────────
    const timedOut = await timeoutStaleRuns();
    if (timedOut > 0) {
        console.log(`[Boot] Marked ${timedOut} stale run(s) as timeout.`);
    }

    // ── Recovery: this runner's concurrency locks are stale after a crash ────────
    await clearAllLocks();
    console.log('[Boot] Cleared concurrency locks.');

    // ── Sync task active flags to Redis ──────────────────────────────────────────
    const tasks = await getAllTasks();
    await Promise.all(tasks.map((t) => setTaskActiveFlag(t.idAutom_Task, t.isActive === 1)));
    console.log(`[Boot] Synced ${tasks.length} task active flag(s) to Redis.`);

    await startScheduler();

    // ── API ──────────────────────────────────────────────────────────────────────
    const allowedOrigins = cfg().corsOrigins;
    const app = express();
    app.use(express.json());

    app.use(
        cors({
            origin: (origin, callback) => {
                if (!origin) return callback(null, true);
                callback(null, allowedOrigins.includes(origin));
            },
            credentials: true,
        }),
    );

    app.use('/api', routes);

    app.get('/healthcheck', (_req, res) => {
        res.json({ status: 'ok', runner: runner(), uptime: process.uptime() });
    });

    installShutdownHandlers();

    app.listen(cfg().port, () => {
        console.log(`[Boot] API listening on port ${cfg().port}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    });
}

/** Registered here rather than at import time: a package that hijacks SIGINT
 *  merely by being imported would surprise whoever imports it for its types. */
function installShutdownHandlers(): void {
    const shutdown = (signal: string) => {
        console.log(`[Server] ${signal} received — shutting down gracefully...`);
        stopScheduler();
        process.exit(0);
    };

    process.on('message', (msg) => {
        if (msg === 'shutdown') shutdown('shutdown');
    });
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

// ─── Pieces, for hosts that want to assemble their own server ─────────────────

export { executeTask, getActiveRuns } from './executor.js';
export { startScheduler, stopScheduler, reloadSchedule, reloadAllSchedules } from './scheduler.js';
export { router as automationRouter } from './api.js';
export { setTaskActiveFlag, isTaskActiveInRedis, closeRedis } from './redis.js';

export type {
    AutomationConfig,
    MysqlOptions,
    AutomTask,
    AutomSchedule,
    AutomTaskRun,
    AutomTaskLock,
    TaskModule,
    TaskRunContext,
    TaskRunResult,
    TaskStatus,
    TriggerSource,
    ActiveRun,
} from './types.js';
