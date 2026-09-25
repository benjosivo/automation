/**
 * executor.ts
 * The heart of the automation server.
 * Handles: ownership, lock acquisition, task module loading, heartbeat, retries, DB logging.
 */

import path from 'path';
import { EventEmitter } from 'events';
import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';
import type { TaskRunContext, TriggerSource, ActiveRun, TaskRunResult, MysqlOptions, ProgressUpdate, RunProgress, TaskStatus, NotifyPayload } from './types.js';
import { cfg, runner } from './config.js';
import * as db from './db.js';
import * as redis from './redis.js';

// ─── In-memory registry of currently running tasks ────────────────────────────

const activeRuns = new Map<number, ActiveRun>(); // keyed by runId

export function getActiveRuns(): ActiveRun[] {
    return [...activeRuns.values()];
}

// ─── Live events ──────────────────────────────────────────────────────────────

/**
 * What the API's SSE stream subscribes to. Four events:
 *
 *   start     { runId, taskId, taskName, attempt, startedAt }
 *   progress  { runId, percent, step, current, total }
 *   log       { runId, line }
 *   end       { runId, taskId, taskName, status, error? }
 *
 * `progress` carries the delta without the log buffer: resending two hundred
 * lines on every percent would make the stream heavier than the polling it
 * replaces. A client connecting mid-run gets the full state from the snapshot
 * the stream opens with.
 */
export const runEvents = new EventEmitter();

// Four listeners per open dashboard tab, and Node warns past ten. The ceiling
// here is how many people have the page open, which is not this module's to cap.
runEvents.setMaxListeners(0);

// ─── Progress ─────────────────────────────────────────────────────────────────
// Memory is the source: the API and the executor share a process, so a reader
// never has to wait on Redis. Redis is a mirror, for whatever reads a run from
// outside this process, and it is written at most once a second — a task that
// calls progress() inside a hundred-thousand-iteration loop must not turn into a
// hundred thousand SETs.

/** How many log lines a live run keeps. Past that, the oldest go. */
const LOG_BUFFER = 200;
const STEP_MAX = 500;
const LINE_MAX = 2_000;
const REDIS_FLUSH_MS = 1_000;

function emptyProgress(): RunProgress {
    return { percent: null, step: null, current: null, total: null, logs: [], updatedAt: Date.now() };
}

function finiteOrNull(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Nothing arriving here is trusted: it crossed a worker boundary from code the
 *  package does not own. A percent of "42", of -3 or of NaN would each reach the
 *  dashboard as a broken bar. */
function applyUpdate(progress: RunProgress, update: ProgressUpdate): void {
    if (update.percent !== undefined) {
        const percent = finiteOrNull(update.percent);
        if (percent !== null) progress.percent = Math.min(100, Math.max(0, percent));
    }
    if (update.step !== undefined) progress.step = String(update.step).slice(0, STEP_MAX);
    if (update.current !== undefined) progress.current = finiteOrNull(update.current);
    if (update.total !== undefined) progress.total = finiteOrNull(update.total);
}

function appendLog(progress: RunProgress, line: string): void {
    progress.logs.push(line.slice(0, LINE_MAX));
    if (progress.logs.length > LOG_BUFFER) progress.logs.splice(0, progress.logs.length - LOG_BUFFER);
}

/** The throttle. `progress` is mutated in place, so a flush already queued picks
 *  up whatever the task reported meanwhile — there is never more than one timer,
 *  and the state it writes is always the newest. */
function mirrorToRedis(runId: number, progress: RunProgress) {
    let lastFlush = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
        pending = null;
        lastFlush = Date.now();
        redis.setRunProgress(runId, progress).catch(() => {});
    };

    return {
        touch() {
            progress.updatedAt = Date.now();
            if (pending) return;
            const since = Date.now() - lastFlush;
            if (since >= REDIS_FLUSH_MS) return flush();
            pending = setTimeout(flush, REDIS_FLUSH_MS - since);
        },
        /** Called from the run's finally. The last state always lands, however
         *  little time has passed since the previous write. */
        stop() {
            if (pending) clearTimeout(pending);
            flush();
        },
    };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface ExecuteOptions {
    taskId: number;
    scheduleId?: number | null;
    triggeredBy: TriggerSource;
    attempt?: number;
    /** Told once, as soon as it is known, whether this call started a run. The
     *  API waits on it to answer a trigger with the run it created — or with why
     *  none was, where the executor used to skip silently behind a 200.
     *  Retries do not carry it: they belong to the run that failed. */
    onStart?: (outcome: StartOutcome) => void;
}

export type StartOutcome = { runId: number } | { skipped: string };

export async function executeTask(opts: ExecuteOptions): Promise<void> {
    const { taskId, scheduleId = null, triggeredBy, attempt = 1 } = opts;
    const skip = (reason: string) => opts.onStart?.({ skipped: reason });

    // 1. Load task definition
    const task = await db.getTaskById(taskId);
    if (!task) {
        console.error(`[Executor] Task ${taskId} not found.`);
        return skip(`Task ${taskId} not found`);
    }

    // 2. Ownership. Schedules and the trigger queue are already scoped, so reaching
    //    here with a foreign task means something crossed the boundary anyway — a
    //    hand-written API call, a stale queue entry. Refuse before creating a run
    //    row: this process has no module to load, and the failure would surface as
    //    a nightly alert about a task that is not its business.
    if (task.Runner !== runner()) {
        console.log(`[Executor] Task "${task.Name}" belongs to runner "${task.Runner}", not "${runner()}" — skipping.`);
        return skip(`Task "${task.Name}" belongs to runner "${task.Runner}"`);
    }

    // 3. Check active flag — Redis first, fall back to DB
    const redisActive = await redis.isTaskActiveInRedis(taskId);
    const isActive = redisActive !== null ? redisActive : task.isActive === 1;
    if (!isActive) {
        console.log(`[Executor] Task "${task.Name}" is inactive — skipping.`);
        return skip(`Task "${task.Name}" is inactive`);
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
            return skip(`Concurrency group "${task.ConcurrencyGroup}" is locked`);
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
            return skip(`Concurrency group "${task.ConcurrencyGroup}" is locked`);
        }
    }

    // 7. Register in activeRuns
    const abortController = new AbortController();
    const progress = emptyProgress();
    const activeRun: ActiveRun = {
        runId,
        taskId,
        taskName: task.Name,
        concurrencyGroup: task.ConcurrencyGroup,
        startedAt: new Date(),
        attempt,
        abortController,
        progress,
    };
    activeRuns.set(runId, activeRun);
    runEvents.emit('start', { runId, taskId, taskName: task.Name, attempt, startedAt: activeRun.startedAt });
    opts.onStart?.({ runId });

    // 8. Start heartbeat and the Redis progress mirror
    const stopHeartbeat = redis.startHeartbeat(runId);
    const mirror = mirrorToRedis(runId, progress);

    // Settled by the try/catch below, read by the `end` event in the finally —
    // which is the only place that runs whichever way the task goes.
    let endStatus: TaskStatus = 'failed';
    let endError: string | undefined;

    console.log(`[Executor] Starting "${task.Name}" (run #${runId}, attempt ${attempt})`);

    // 9. Dynamically import the task module
    const modulePath = task.ModulePath.startsWith('file:') ? task.ModulePath : pathToFileURL(path.resolve(task.ModulePath)).href;
    const context: TaskRunContext = { taskId, taskName: task.Name, runId, attempt, triggeredBy };

    try {
        const result = await runInWorker(modulePath, context, cfg().mysql, {
            progress: (update) => {
                applyUpdate(progress, update);
                mirror.touch();
                runEvents.emit('progress', {
                    runId,
                    percent: progress.percent,
                    step: progress.step,
                    current: progress.current,
                    total: progress.total,
                });
            },
            log: (line) => {
                appendLog(progress, line);
                mirror.touch();
                // The stored line, not the raw one: the subscriber sees exactly
                // what the buffer holds, truncation included.
                runEvents.emit('log', { runId, line: progress.logs[progress.logs.length - 1] });
            },
            notify: (payload) => {
                redis.notifyClients(payload);
            },
        });

        // 10. Success
        endStatus = 'completed';
        await db.completeTaskRun(runId, result?.output);
        console.log(`[Executor] Completed : "${task.Name}" (run #${runId})`);
    } catch (err: any) {
        const errorMessage = err?.message ?? String(err);
        endError = errorMessage;
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
            cfg().onCompleteFail(errorMessage, context, task);
        }
    } finally {
        // 12. Always: stop heartbeat, flush the last progress, release lock,
        //     remove from activeRuns
        stopHeartbeat();
        mirror.stop();
        if (task.ConcurrencyGroup) {
            await db.releaseLock(task.ConcurrencyGroup, runId).catch(console.error);
        }
        activeRuns.delete(runId);
        runEvents.emit('end', { runId, taskId, taskName: task.Name, status: endStatus, error: endError });
    }
}

/** What the parent does with what a live worker says. */
interface WorkerReport {
    progress: (update: ProgressUpdate) => void;
    log: (line: string) => void;
    notify: (payload: NotifyPayload) => void;
}

/**
 * The bootstrap runs in a fresh worker with no module graph of its own, so it has
 * to initialise the MySQL pool before importing the task. Those options travel
 * through workerData rather than being read from process.env: the package does not
 * know which variable names its host uses.
 *
 * The worker now speaks more than once. Every message carries a `type`, and only
 * `done` ends the run — see the handler below, which used to terminate on the
 * first message of any shape.
 */
function runInWorker(modulePath: string, context: TaskRunContext, mysql: MysqlOptions, report: WorkerReport): Promise<TaskRunResult> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(
            `import { workerData, parentPort } from 'worker_threads';
            import { inspect } from 'node:util';
            import * as mysql from '@benjosivo/mysql';
            const { modulePath, context, mysqlOptions } = workerData;

            // postMessage throws once the worker is being torn down, and a task
            // logging on its way out must not turn into an unhandled rejection.
            const send = (msg) => { try { parentPort.postMessage(msg); } catch {} };

            // workerData is structured-cloned, so functions do not survive the
            // crossing: progress() and notify() have to be built on this side.
            const ctx = {
                ...context,
                progress: (update) => send({ type: 'progress', update }),
                notify: (payload) => send({ type: 'notify', payload }),
            };

            // The task's own console calls become dashboard lines without a single
            // task being modified. The original still writes to the runner's stdout,
            // so nothing is lost from the logs a host already collects.
            for (const level of ['log', 'error', 'warn']) {
                const original = console[level].bind(console);
                console[level] = (...args) => {
                    original(...args);
                    send({ type: 'log', line: args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 2 }))).join(' ') });
                };
            }

            mysql.init(mysqlOptions)
                .then(() => import(modulePath))
                .then(async (mod) => {
                    console.log(\`[\${context.taskName}] Starting — task=\${context.taskId} run=\${context.runId} attempt=\${context.attempt} via=\${context.triggeredBy}\`);
                    return await mod.run(ctx);
                })
                .then((result) => send({ type: 'done', ok: true, result }))
                .catch((err) => send({ type: 'done', ok: false, error: err.message }));
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
            if (msg?.type === 'progress') return report.progress(msg.update ?? {});
            if (msg?.type === 'log') return report.log(String(msg.line ?? ''));
            if (msg?.type === 'notify') return report.notify(msg.payload);

            // Anything else settles the run. Deliberately not a `type === 'done'`
            // check: a message of an unknown shape must not leave a worker alive
            // and a promise pending forever.
            worker.terminate();
            msg?.ok ? resolve(msg.result) : reject(new Error(msg?.error ?? 'Worker sent an unexpected message'));
        });
        worker.on('error', (err) => {
            worker.terminate();
            reject(err);
        });
    });
}
