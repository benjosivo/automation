# @benjosivo/automation

A cron/task runner. Task definitions, schedules, run history and concurrency locks live in MySQL (`Autom_*` tables, DDL in `sql/`); Redis holds the fast-path flags and the on-demand trigger queue. Task *code* stays with the host and is loaded dynamically at run time — the `Autom_Task` row is what binds a schedule to a module.

```ts
import { startAutomationServer } from '@benjosivo/automation';

startAutomationServer({
    runner: 'avosplats',
    port: Number(process.env.AUTOMATION_PORT),
    mysql: {
        host: process.env.MyDB_HOST,
        user: process.env.MyDB_USER,
        password: process.env.MyDB_PASSWORD,
        database: process.env.MyDB_NAME,
    },
    redisUrl: process.env.REDIS_URL,
    corsOrigins: [`http://localhost:${port}`],
    onError: handleError,
});
```

The package reads no environment variable of its own. Variable names, the alerting channel and the runner identity all belong to whoever embeds it, so they arrive through the config object.

## Several runners, one database

`runner` is the part worth understanding. Multiple runner processes may share a single database, each shipping a different set of task modules. `Autom_Task.Runner` says which process owns a row, and a runner only ever schedules, recovers and executes its own.

Without it, every runner loads every active schedule: each cron fires once per process, each runner tries to `import()` a module it does not ship — one failed run and one retry storm per night, for tasks that are not its business — and each boot marks the *other* runner's live runs as timed out. The scoping covers `getActiveSchedules`, `getAllTasks`, `timeoutStaleRuns`, `clearAllLocks`, the trigger queue key (`autom:trigger:queue:<runner>`), and a guard in `executeTask` that refuses a foreign task before creating a run row.

Two runners must not share a name.

## Writing a task

Export `run` matching `TaskModule`:

```ts
import type { TaskRunContext, TaskRunResult } from '@benjosivo/automation';

export async function run(ctx: TaskRunContext): Promise<TaskRunResult> {
    try {
        return { output: (await doTheWork()) ?? 'OK' };
    } catch (err: any) {
        throw new Error(`${ctx.taskName} failed: ${err.message}`); // let the executor retry
    }
}
```

The module is loaded in a `worker_threads` Worker whose bootstrap calls `init()` from `@benjosivo/mysql` with the options from your config, then imports the module and calls `run(context)`. Throw and the executor retries while `attempt <= RetryLimit`, spaced by `RetryDelaySeconds`, each attempt its own run row. Return and `output` is stored on the row.

`Autom_Task.ModulePath` is a path to **compiled JS**, resolved against the process working directory. Moving a task file means updating that column — nothing checks it until the task runs.

`@benjosivo/mysql` is a peer dependency: the host, the package and the tasks must share one pool. Its `executeMySQLQuery2` **returns** `{ error }` rather than throwing — check it or wrap it.

## Schema

| File | |
|---|---|
| `sql/001_autom_tables.sql` | The four tables |
| `sql/002_autom_runner.sql` | `Autom_Task.Runner`, required by this version |
| `sql/003_autom_lock_unique.sql` | **Optional, changes behaviour.** See below |

## API

Mounted under `/api` by `startAutomationServer`, plus an unauthenticated `/healthcheck`. `GET|PATCH /tasks/:id`, `POST /tasks/:id/trigger`, `POST /tasks/trigger-by-name/:name`, CRUD on `/schedules` (mutations hot-reload the cron registry — no restart), `POST /schedules/reload`, `GET /runs`, `GET /runs/active`. Listing routes are runner-scoped; a task belonging to another runner answers `409`.

**There is no auth layer**: every `/api` route is open, guarded only by the CORS allowlist. Do not expose it publicly.

Import `automationRouter` instead of calling `startAutomationServer` to mount it on a server of your own.

## Known defects

Carried over verbatim from the runner this package was extracted from. They are documented rather than silently fixed, because each fix changes what a machine does on an unattended nightly schedule.

- **The concurrency lock does not lock.** `Autom_Task_Lock.ConcurrencyGroup` carries no unique index, so `acquireLock()`'s `ON DUPLICATE KEY UPDATE` never fires: every acquisition inserts a fresh row and succeeds. Tasks sharing a `ConcurrencyGroup` run in parallel regardless. `sql/003_autom_lock_unique.sql` fixes it — read its comments first.
- **Heartbeat keys expire on write.** `setCache` treats `expirationMs` as an absolute epoch timestamp (Redis `PXAT`), but the heartbeat passes a duration (`90 * 1000`), so the key is written already expired. Nothing reads the heartbeat today, so nothing observably breaks.
- **The heartbeat renewal interval is 30 000 seconds**, not 30 — `HEARTBEAT_INTERVAL` is already in milliseconds and is multiplied by 1000 again.
- **The trigger queue is not concurrency-safe.** It is a JSON array read-modify-written through `setCache` and drained whole on each 2-second poll. Two processes polling the same runner's queue can lose entries.

## Platform

`scheduler.ts` returns before `cron.schedule()` on win32 — cron never fires on a Windows dev machine. Test with `POST /api/tasks/:id/trigger`.
