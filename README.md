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
| `sql/004_schedule_run_setnull.sql` | **Required if anything deletes a schedule.** See below |

## API

Mounted under `/api` by `startAutomationServer`, plus an unauthenticated `/healthcheck`. `GET|PATCH /tasks/:id`, `POST /tasks/:id/trigger`, `POST /tasks/trigger-by-name/:name`, CRUD on `/schedules` (mutations hot-reload the cron registry — no restart), `POST /schedules/reload`, `GET /runs`, `GET /runs/active`. Listing routes are runner-scoped; a task belonging to another runner answers `409`.

`GET /api/health` lives inside the router, so a host that mounts or proxies it has a liveness probe; `/healthcheck` remains outside for the standalone server.

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

It injects one stylesheet and reads every colour, font and radius from `--autom-*` custom properties whose defaults are declared on `:root`. Declare the same names on `.autom-root` to restyle it; a property set on the element beats one inherited from an ancestor, so the override wins whatever the stylesheet order. Under a CSP that forbids inline styles, import `AUTOM_CSS` and serve it yourself.

## Known defects

Carried over verbatim from the runner this package was extracted from. They are documented rather than silently fixed, because each fix changes what a machine does on an unattended nightly schedule.

- **The concurrency lock does not lock.** `Autom_Task_Lock.ConcurrencyGroup` carries no unique index, so `acquireLock()`'s `ON DUPLICATE KEY UPDATE` never fires: every acquisition inserts a fresh row and succeeds. Tasks sharing a `ConcurrencyGroup` run in parallel regardless. `sql/003_autom_lock_unique.sql` fixes it — read its comments first.
- **Heartbeat keys expire on write.** `setCache` treats `expirationMs` as an absolute epoch timestamp (Redis `PXAT`), but the heartbeat passes a duration (`90 * 1000`), so the key is written already expired. Nothing reads the heartbeat today, so nothing observably breaks.
- **The heartbeat renewal interval is 30 000 seconds**, not 30 — `HEARTBEAT_INTERVAL` is already in milliseconds and is multiplied by 1000 again.
- **Deleting a schedule fails once it has run**, until `sql/004_schedule_run_setnull.sql` is applied. The foreign key from `Autom_Task_Run` carries no `ON DELETE` clause, so MySQL restricts: every run the schedule produced holds it. The migration switches it to `SET NULL`, which keeps the runs — a run is a historical fact, and a manually triggered one already has no schedule.
- **The trigger queue is not concurrency-safe.** It is a JSON array read-modify-written through `setCache` and drained whole on each 2-second poll. Two processes polling the same runner's queue can lose entries.

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
