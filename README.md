# @benjosivo/automation

A cron/task runner. Task definitions, schedules, run history and concurrency locks live in MySQL (`Autom_*` tables, DDL in `sql/`); Redis holds the fast-path flags, the on-demand trigger queue and a mirror of what a running task reports. Task *code* stays with the host and is loaded dynamically at run time — the `Autom_Task` row is what binds a schedule to a module.

```ts
import { startAutomationServer } from '@benjosivo/automation';

const port = Number(process.env.AUTOMATION_PORT);

startAutomationServer({
    runner: 'avosplats',
    port,
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

### Reporting progress

A long task can say where it has got to, and the dashboard shows it while the task runs:

```ts
export async function run(ctx: TaskRunContext): Promise<TaskRunResult> {
    const batches = await listBatches();
    for (const [i, batch] of batches.entries()) {
        ctx.progress?.({ percent: Math.round((i / batches.length) * 100), step: `batch ${i + 1}/${batches.length}` });
        await handle(batch);
    }
    return { output: `${batches.length} batches` };
}
```

`progress` is **optional and must be called with `?.`**: the executor builds it inside the worker, so a module imported and called directly — a test, a script, a host running the task outside the runner — gets a context without it. Every field of the update is optional too; a task that knows its step but not its share sends only `step`, and the bar reads as indeterminate rather than claiming a figure.

`console.log`, `console.error` and `console.warn` are forwarded as well, with no change to any task: they still reach the runner's stdout, and each line also becomes a dashboard line. A run keeps its last 200 lines; the percentage is coerced, clamped to `[0, 100]` and dropped if it is not a finite number.

None of this is persisted. It lives in the runner's memory, mirrored to `autom:run:<id>:progress` in Redis for ten minutes so that a dashboard opened just after a task finished still shows where it got to. The lasting record is the run row's `Output`.

### Notifying WebSocket clients

A task can push a message to the host's browsers, through the Redis channel its WebSocket server subscribes to:

```ts
ctx.notify?.({ data: { recipeId }, path: '/recettes', targetUserId: userId });
```

The worker does not publish itself: it hands the payload to the runner, which publishes it on `notifyChannel` (default `ws:broadcast`) over its one Redis connection, so a run opens no connection of its own. The payload is sent as `JSON.stringify` of `{ data, path, url, targetUserId }` — the same message the pre-package runner's `notifyClients` published — and routing it is the WebSocket server's business. `notify` is optional like `progress`, and fire-and-forget: a failed publish goes to `onError`, never to the task. Code running in the runner's own thread (`onCompleteFail`, a host route) imports `notifyClients` from the package instead.

`Autom_Task.ModulePath` is a path to **compiled JS**, resolved against the process working directory. Moving a task file means updating that column — nothing checks it until the task runs.

`@benjosivo/mysql` is a peer dependency: the host, the package and the tasks must share one pool. Its `executeMySQLQuery2` **returns** `{ error }` rather than throwing — check it or wrap it.

## Schema

| File | |
|---|---|
| `sql/001_autom_tables.sql` | The four tables |
| `sql/002_autom_runner.sql` | `Autom_Task.Runner`, required by this version |
| `sql/003_autom_lock_unique.sql` | **Required by any task with a `ConcurrencyGroup`**, and a no-op for the rest. See below |
| `sql/004_schedule_run_setnull.sql` | **Required if anything deletes a schedule.** See below |

## API

Mounted under `/api` by `startAutomationServer`, plus an unauthenticated `/healthcheck`. `GET|PATCH /tasks/:id`, `POST /tasks/:id/trigger`, `POST /tasks/trigger-by-name/:name`, CRUD on `/schedules` (mutations hot-reload the cron registry — no restart), `POST /schedules/reload`, `GET /runs`, `GET /runs/:id`, `GET /runs/active`, `GET /runs/events`, `GET /runs/:id/progress`. Listing routes are runner-scoped; a task belonging to another runner answers `409`.

`POST /tasks/:id/trigger` and `POST /tasks/trigger-by-name/:name` answer once the run row exists, with its `runId`, and **409 when no run was created**: the task is already running, inactive, or its concurrency lock is held, with the reason in `error`. Until 1.9.0 both answered 200 immediately and the executor skipped those cases silently, leaving the caller nothing to follow. "Already running" is refused for these two routes only, as a guard against a double click: a cron firing on top of a slow previous run behaves as it always has.

`GET /api/health` lives inside the router, so a host that mounts or proxies it has a liveness probe; `/healthcheck` remains outside for the standalone server.

`GET /runs/events` is a Server-Sent Events stream: a `snapshot` of what is running on connect, then `start`, `progress`, `log` and `end` as they happen. `GET /runs/:id/progress` answers the same state for one run, from memory while it runs and from Redis for ten minutes after, then `null`. A host that wraps the router in `compression()` **must exclude `/runs/events`** — compression buffers the stream, and no header from here turns that off.

`GET /runs` truncates `Output` to its first 200 characters. It is a `mediumtext`, and this listing is loaded five hundred rows at a time; what a list renders is the first line. **`GET /runs/:id` is where the column comes back whole** — that is what the dashboard's run modal opens. `GET /tasks/:id/runs` is not truncated: it defaults to twenty rows.

`POST /schedules` and `PATCH /schedules/:id` answer **400** on an expression that either node-cron or the five-field parser rejects. Before 1.1.0 an unusable expression was stored, listed as active, and never fired — `registerJob()` warned to the console and returned.

**There is no auth layer**: every `/api` route is open. Restrict what can reach it with `host` and put an authenticated host in front of it — see [Config](#config) for the two deployments. The CORS allowlist only constrains browsers, never a server-to-server call.

Import `automationRouter` instead of calling `startAutomationServer` to mount it on a server of your own.

## Driving a runner from another server

```ts
import { createAutomationProxyRouter } from '@benjosivo/automation/proxy';

app.use('/admin/api/automations', requireAdmin,
        createAutomationProxyRouter({ baseUrl: 'http://127.0.0.1:8500/api' }));
```

One catch-all handler forwards method, path and query string as received, so it covers every route the API has and every route it grows. It authenticates nothing — the guard you mount in front of it is the whole access control — and it needs `express.json()` upstream, since it re-serialises `req.body`. An unreachable runner answers `502` in the same `{ success, error }` envelope as the API's own failures, naming the base URL it dialled and the underlying cause:

```
Automation runner unreachable at http://127.0.0.1:8500/api: connect ECONNREFUSED 127.0.0.1:8500
```

`/runs/events` is forwarded chunk by chunk rather than buffered, and the `timeoutMs` deadline is dropped once a response turns out to be a stream — otherwise the dashboard's live updates would die after ten seconds.

**`127.0.0.1` in that example holds only while the runner shares a machine with the server mounting this.** `baseUrl` is dialled from inside the calling process: in separate containers it would name the *caller's own* loopback, where nothing listens, and every request would answer 502. Use the runner's internal service name there — see [Config](#config).

Mounting the router directly in an application process instead does not work: `executeTask` opens its worker in the calling process, and schedule mutations hot-reload the calling process's cron registry. The work would run in the web server and the runner's crons would not reload.

## Cron helpers

```ts
import { isValidCron, nextRuns, expandCron } from '@benjosivo/automation/cron';
```

A five-field parser with no imports at all, so a browser bundle can pull this subpath without dragging Express, Redis and MySQL in. It is what guards writes server-side and what previews occurrences client-side, which is why the preview cannot promise a firing the runner would refuse.

Deliberately absent: a function turning an expression into a sentence. Occurrences are computed and cannot be wrong; a paraphrase can, and would be believed.

## Dashboard

```tsx
import { AutomationDashboard } from '@benjosivo/automation/react';

<AutomationDashboard apiBase="/admin/api/automations" lang="fr" />
```

The whole management surface as one component: statistics, running tasks, recent failures, next occurrences, a month/week/by-task calendar overlaying past runs with projected ones, task cards with manual triggering and activation, schedule editing with live validation, and a filterable run history. `react >= 18` is an optional peer dependency; hosts that never import this subpath do not need it.

`apiBase` points at a `createAutomationProxyRouter` mount. Pass `fetcher` to reuse a host's own fetch wrapper — sessions, redirects, deploy detection.

A running task shows a progress bar, its current step and its last log line, fed by `GET /runs/events`. **`EventSource` cannot carry a custom header, so `fetcher` does not apply to that connection**: a host authenticating with an `Authorization` header will only ever see `401` there. That is why the stream is not the only path — when it fails twice in a row without opening, the dashboard falls back to polling `/runs/active`, every 1.5 s while something is running and every 8 s otherwise. Nothing has to be configured either way; a cookie-based session works over the stream unchanged.

While the stream is up, `progress` and `log` are applied with no request at all, and the full reload drops to one every five minutes. It is not there to keep up — it reconciles. An `EventSource` reconnects silently and the events emitted while it was away are gone, so the dashboard reloads on every reconnection, which is the moment state can have drifted. The five-minute timer then only catches what no event can describe: a direct `UPDATE` in MySQL. It matches the TTL of the Redis active flag, which is how long the runner itself takes to notice one.

### One task, on a host's own page

```tsx
import { TaskTrigger } from '@benjosivo/automation/react';

<TaskTrigger apiBase="/admin/api/automations" name="importRecettes" label="Importer" lang="fr" />
```

A button that starts the task named `name` (recorded as triggered by `api`), then shows its progress bar and current step while it runs, and its final status with the `Output` or the error once it ends. Several can share a page.

It cannot be started twice. The button is disabled from the click until the run ends; on mount it follows a run of that task already in progress, whoever started it; and the runner answers 409 to a trigger for a running task, which is what holds when two tabs click in the same instant — the component then follows that run rather than showing an error.

It polls `/runs/active` every second while it follows a run, and makes no request otherwise. Not the event stream: each instance would hold one, and browsers allow six connections per origin over HTTP/1.1. Polling also goes through `fetcher`.

It injects one stylesheet and reads every colour, font and radius from `--autom-*` custom properties whose defaults are declared on `:root`. Declare the same names on `.autom-root` to restyle it; a property set on the element beats one inherited from an ancestor, so the override wins whatever the stylesheet order. Under a CSP that forbids inline styles, import `AUTOM_CSS` and serve it yourself.

## Known defects

Carried over verbatim from the runner this package was extracted from. They are documented rather than silently fixed, because each fix changes what a machine does on an unattended nightly schedule.

- **The concurrency lock needs `sql/003_autom_lock_unique.sql` to lock at all.** Without the unique index on `ConcurrencyGroup`, every acquisition inserts its own row and finds it free. With the index applied, the lock works as of 1.1.2 — see below for what 1.1.1 and earlier did instead.
- **The heartbeat is written and read by nothing.** Two bugs kept it from even being stored until 1.2.0: `setCache` treats `expirationMs` as an absolute `PXAT` and the heartbeat passed a duration, so every key was written already expired; and the renewal interval was multiplied by 1000 a second time, giving 8 h 20 between beats for a 90 s TTL. Both are fixed, and `autom:run:<id>:heartbeat` now holds what it says. **No consumer has been written yet** — `timeoutStaleRuns()` sweeps every `running`/`pending` row of this runner at boot, on status alone, without consulting liveness. So a run whose worker dies mid-flight still shows as running until the next restart.
- **Deleting a schedule fails once it has run**, until `sql/004_schedule_run_setnull.sql` is applied. The foreign key from `Autom_Task_Run` carries no `ON DELETE` clause, so MySQL restricts: every run the schedule produced holds it. The migration switches it to `SET NULL`, which keeps the runs — a run is a historical fact, and a manually triggered one already has no schedule.
- **The trigger queue is not concurrency-safe.** It is a JSON array read-modify-written through `setCache` and drained whole on each 2-second poll. Two processes polling the same runner's queue can lose entries.

## Fixed in 1.1.2 — `ConcurrencyGroup` was unusable

Both defects were in the lock, and either one alone was enough to make the feature worse than not having it. Neither had been noticed in the wild: no task in the shared database had a `ConcurrencyGroup` set, so the code path had never run.

**Releasing a lock threw.** `releaseLock()` set `LockedAt = NULL` on a column `sql/001_autom_tables.sql` declares `NOT NULL`, which fails under `STRICT_TRANS_TABLES` — the default. `executeTask` swallows that rejection (`.catch(console.error)`), so the run looked healthy while the lock kept its holder forever and every later acquisition was refused. `clearAllLocks()` did the same thing at boot, awaited with no catch, so restarting — the one thing that should have cleared it — threw during startup instead. Neither call touches `LockedAt` now; the holder column alone says whether the group is free.

**Acquiring a lock always succeeded.** The old `INSERT IGNORE … ON DUPLICATE KEY UPDATE` read `affectedRows` as 1-took-it / 0-someone-else-has-it. That mapping holds only without `CLIENT_FOUND_ROWS`, and mysql2 enables that flag by default, which makes an unchanged row report 1 as well. Measured against MySQL 8 on 10 September 2026: insert 1, contended 1, re-acquire 2 — every branch above zero, so `acquireLock()` returned `true` to every caller. It is now an `INSERT IGNORE` that only guarantees the row exists, followed by an `UPDATE … WHERE Autom_Task_Run_id IS NULL` whose `WHERE` cannot match a held lock, whatever the client flags count.

## Platform

`scheduler.ts` returns before `cron.schedule()` on win32 — cron never fires on a Windows dev machine. Test with `POST /api/tasks/:id/trigger`, or the dashboard's Run button.

## Config

`host` chooses the interface the API binds to. It defaults to `0.0.0.0`, which is what 1.0.x did unconditionally.

Because the API has no authentication of its own, this option and `baseUrl` on the proxy are one decision, taken twice — they must agree, and how they agree depends on where the two processes run:

| | runner's `host` | proxy's `baseUrl` | what keeps the API private |
|---|---|---|---|
| One machine | `127.0.0.1` | `http://127.0.0.1:PORT/api` | the loopback: nothing off-host can address it |
| Separate containers | `0.0.0.0` | `http://<internal-service-name>:PORT/api` | the network only |

`127.0.0.1` is not an address that travels — it means "whoever is asking". A proxy in its own container that dials it reaches its own loopback, not the runner, so the pairing on the first row fails as a connection refusal and the proxy answers 502. That is the most common misconfiguration of this package.

The second row's cost is that the bind no longer guards anything. Keep the runner's port unpublished on the host and off any public domain: exposed, it lets anyone trigger tasks and edit schedules without ever meeting the guard in front of the proxy.
