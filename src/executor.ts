/**
 * executor.ts
 * The heart of the automation server.
 * Handles: ownership, lock acquisition, task module loading, heartbeat, retries, DB logging.
 */

import path from 'path';
import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';
import type { TaskRunContext, TriggerSource, ActiveRun, TaskRunResult, MysqlOptions } from './types.js';
import { cfg, runner } from './config.js';
import * as db from './db.js';
import * as redis from './redis.js';

// ─── In-memory registry of currently running tasks ────────────────────────────

const activeRuns = new Map<number, ActiveRun>(); // keyed by runId

export function getActiveRuns(): ActiveRun[] {
    return [...activeRuns.values()];
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface ExecuteOptions {
    taskId: number;
    scheduleId?: number | null;
    triggeredBy: TriggerSource;
    attempt?: number;
}

export async function executeTask(opts: ExecuteOptions): Promise<void> {
    const { taskId, scheduleId = null, triggeredBy, attempt = 1 } = opts;

    // 1. Load task definition
    const task = await db.getTaskById(taskId);
    if (!task) {
        console.error(`[Executor] Task ${taskId} not found.`);
        return;
    }

    // 2. Ownership. Schedules and the trigger queue are already scoped, so reaching
    //    here with a foreign task means something crossed the boundary anyway — a
    //    hand-written API call, a stale queue entry. Refuse before creating a run
    //    row: this process has no module to load, and the failure would surface as
    //    a nightly alert about a task that is not its business.
    if (task.Runner !== runner()) {
        console.log(`[Executor] Task "${task.Name}" belongs to runner "${task.Runner}", not "${runner()}" — skipping.`);
        return;
    }

    // 3. Check active flag — Redis first, fall back to DB
    const redisActive = await redis.isTaskActiveInRedis(taskId);
    const isActive = redisActive !== null ? redisActive : task.isActive === 1;
    if (!isActive) {
        console.log(`[Executor] Task "${task.Name}" is inactive — skipping.`);
        return;
    }

    // 4. Concurrency pre-check (best-effort, in-process only; step 6 is the atomic one)
    if (task.ConcurrencyGroup) {
        const existing = await db.getRunningTasks();
        const conflict = existing.find((r) => {
            const live = [...activeRuns.values()].find((ar) => ar.runId === r.idAutom_Task_Run);
            return live?.concurrencyGroup === task.ConcurrencyGroup;
        });
        if (conflict) {
            console.log(`[Executor] Task "${task.Name}" skipped — concurrency group "${task.ConcurrencyGroup}" is locked.`);
            return;
        }
    }

    // 5. Create DB run record
    const runId = await db.createTaskRun({ taskId, scheduleId, triggeredBy, attempt });

    // 6. Acquire DB lock (atomic)
    if (task.ConcurrencyGroup) {
        const acquired = await db.acquireLock(task.ConcurrencyGroup, runId);
        if (!acquired) {
            await db.failTaskRun(runId, 'Skipped — concurrency group lock not acquired');
            console.log(`[Executor] Task "${task.Name}" lost lock race — skipped.`);
            return;
        }
    }

    // 7. Register in activeRuns
    const abortController = new AbortController();
    const activeRun: ActiveRun = {
        runId,
        taskId,
        taskName: task.Name,
        concurrencyGroup: task.ConcurrencyGroup,
        startedAt: new Date(),
        attempt,
        abortController,
    };
    activeRuns.set(runId, activeRun);

    // 8. Start heartbeat
    const stopHeartbeat = redis.startHeartbeat(runId);

    console.log(`[Executor] Starting "${task.Name}" (run #${runId}, attempt ${attempt})`);

    try {
        // 9. Dynamically import the task module
        const modulePath = task.ModulePath.startsWith('file:') ? task.ModulePath : pathToFileURL(path.resolve(task.ModulePath)).href;
        const context: TaskRunContext = { taskId, taskName: task.Name, runId, attempt, triggeredBy };
        const result = await runInWorker(modulePath, context, cfg().mysql);

        // 10. Success
        await db.completeTaskRun(runId, result?.output);
        console.log(`[Executor] Completed : "${task.Name}" (run #${runId})`);
    } catch (err: any) {
        const errorMessage = err?.message ?? String(err);
        console.error(`[Executor] Failed : "${task.Name}" (run #${runId}, attempt ${attempt}): ${errorMessage}`);

        // 11. Retry logic
        if (attempt <= task.RetryLimit) {
            const delay = (task.RetryDelaySeconds ?? 60) * 1000;
            console.log(`[Executor] Retrying "${task.Name}" in ${task.RetryDelaySeconds}s (attempt ${attempt + 1}/${task.RetryLimit})`);
            await db.failTaskRun(runId, `${errorMessage} — retrying`);

            setTimeout(() => {
                executeTask({ taskId, scheduleId, triggeredBy, attempt: attempt + 1 }).catch(console.error);
            }, delay);
        } else {
            await db.failTaskRun(runId, errorMessage);
        }
    } finally {
        // 12. Always: stop heartbeat, release lock, remove from activeRuns
        stopHeartbeat();
        if (task.ConcurrencyGroup) {
            await db.releaseLock(task.ConcurrencyGroup, runId).catch(console.error);
        }
        activeRuns.delete(runId);
    }
}

/**
 * The bootstrap runs in a fresh worker with no module graph of its own, so it has
 * to initialise the MySQL pool before importing the task. Those options travel
 * through workerData rather than being read from process.env: the package does not
 * know which variable names its host uses.
 */
function runInWorker(modulePath: string, context: TaskRunContext, mysql: MysqlOptions): Promise<TaskRunResult> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(
            `import { workerData, parentPort } from 'worker_threads';
            import * as mysql from '@benjosivo/mysql';
            const { modulePath, context, mysqlOptions } = workerData;

            mysql.init(mysqlOptions)
                .then(() => import(modulePath))
                .then(async (mod) => {
                    console.log(\`[\${context.taskName}] Starting — task=\${context.taskId} run=\${context.runId} attempt=\${context.attempt} via=\${context.triggeredBy}\`);
                    return await mod.run(context);
                })
                .then((result) => parentPort.postMessage({ ok: true, result }))
                .catch((err) => parentPort.postMessage({ ok: false, error: err.message }));
            `,
            {
                eval: true,
                workerData: {
                    modulePath,
                    context,
                    mysqlOptions: { waitForConnections: true, connectionLimit: 50, queueLimit: 0, multipleStatements: true, ...mysql },
                },
            },
        );

        worker.on('message', (msg) => {
            worker.terminate();
            msg.ok ? resolve(msg.result) : reject(new Error(msg.error));
        });
        worker.on('error', (err) => {
            worker.terminate();
            reject(err);
        });
    });
}
