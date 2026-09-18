export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout';
export type TriggerSource = 'scheduler' | 'api' | 'manual' | 'dev';

export interface AutomTask {
    idAutom_Task: number;
    Name: string;
    /** Which runner process owns this task. Several runners share one database;
     *  each one only schedules, recovers and executes the tasks bearing its name. */
    Runner: string;
    Description: string;
    ModulePath: string;
    isActive: 0 | 1;
    ConcurrencyGroup: string | null;
    RetryLimit: number;
    RetryDelaySeconds: number;
    CreatedAt: Date;
    UpdatedAt: Date;
}

export interface AutomSchedule {
    idAutom_Schedule: number;
    Autom_Task_id: number;
    CronExpression: string;
    isActive: 0 | 1;
    CreatedAt: Date;
    UpdatedAt: Date;
    /** Joined in by getAllSchedules(); absent from a bare row. */
    TaskName?: string;
}

export interface AutomTaskRun {
    idAutom_Task_Run: number;
    Autom_Task_id: number;
    Autom_Schedule_id: number | null;
    Status: TaskStatus;
    /** PascalCase because the column is: sql/001 declares `TriggeredBy`, and rows
     *  come back keyed by the column's own case. The lowercase spelling this field
     *  carried until 1.1.0 was simply absent at run time. */
    TriggeredBy: TriggerSource;
    Attempt: number;
    StartedAt: Date;
    FinishedAt: Date | null;
    ErrorMessage: string | null;
    Output: string | null;
    /** Joined in by getAllRuns() and getRunningTasks(); absent from getRunsForTask(). */
    TaskName?: string;
}

export interface AutomTaskLock {
    idAutom_Task_Lock: number;
    ConcurrencyGroup: string;
    /** NULL means the group is free. This column alone decides that — see db.releaseLock(). */
    Autom_Task_Run_id: number | null;
    /** When this group was last taken. NOT NULL in 001_autom_tables.sql, and never cleared;
     *  the `| null` this used to carry is what made writing NULL to it look allowed. */
    LockedAt: Date;
}

// ─── Runtime Types ────────────────────────────────────────────────────────────

/** Every task module must export a function matching this signature */
export interface TaskModule {
    run: (context: TaskRunContext) => Promise<TaskRunResult>;
}

export interface TaskRunContext {
    taskId: number;
    taskName: string;
    runId: number;
    attempt: number;
    triggeredBy: TriggerSource;
    /** Publishes where the task has got to, for the dashboard to show while it runs.
     *
     *  Optional, and it has to stay that way: the executor builds it inside the
     *  worker, so a module imported and called directly — a test, a script, a host
     *  running the task outside the runner — receives a context without it. Call it
     *  as `context.progress?.({ … })`. */
    progress?: (update: ProgressUpdate) => void;
}

/** What a task reports. Every field is optional: a task that knows its step but
 *  not its share of the whole sends only `step`. */
export interface ProgressUpdate {
    /** 0–100. Values outside that range, and anything that is not a number, are
     *  dropped by the executor rather than rendered as a broken bar. */
    percent?: number;
    step?: string;
    current?: number;
    total?: number;
}

/** What the executor keeps, and what /runs/active and /runs/:id/progress return.
 *  Null means "never reported", which the dashboard draws as indeterminate — as
 *  opposed to 0, which means the task said it was at zero. */
export interface RunProgress {
    percent: number | null;
    step: string | null;
    current: number | null;
    total: number | null;
    /** The last lines only — the executor keeps a ring of LOG_BUFFER entries, so a
     *  chatty task cannot fill the runner's memory. */
    logs: string[];
    updatedAt: number;
}

export interface TaskRunResult {
    output?: string;
    error?: string;
}

/** Internal representation used by the executor while a task is live */
export interface ActiveRun {
    runId: number;
    taskId: number;
    taskName: string;
    concurrencyGroup: string | null;
    startedAt: Date;
    attempt: number;
    abortController: AbortController;
    /** Mutated in place as the worker reports. Not serialisable as-is alongside
     *  `abortController` — the API maps an ActiveRun field by field. */
    progress: RunProgress;
}

// ─── Host configuration ───────────────────────────────────────────────────────

/** Connection options forwarded verbatim to init() of @benjosivo/mysql. */
export interface MysqlOptions {
    host: string;
    user: string;
    password: string;
    database: string;
    [option: string]: unknown;
}

export interface AutomationConfig {
    /** This process's identity, matched against Autom_Task.Runner. Two runners
     *  sharing a database must not share a name, or each would fire the other's
     *  crons and mark the other's live runs as timed out on boot. */
    runner: string;
    port: number;
    /** Interface the API binds to. Defaults to 0.0.0.0 — every interface, which is
     *  what 1.0.x did unconditionally. This API has no auth layer of its own, so
     *  what may reach this interface is the whole of its protection:
     *
     *    - sharing a machine with the server that proxies it → '127.0.0.1', and
     *      nothing else on the host can address it;
     *    - in its own container → '0.0.0.0' is required, since the proxying
     *      container cannot reach a loopback that is not its own. Isolation then
     *      rests on the network: keep the port unpublished and off any public
     *      domain, or the proxy's guard becomes bypassable by addressing it. */
    host?: string;
    mysql: MysqlOptions;
    redisUrl: string;
    /** Exact origins allowed by CORS. Empty or omitted allows none. */
    corsOrigins?: string[];
    /** Where the runner reports what it could not handle itself. Defaults to
     *  console.error — a host with an alerting channel should pass its own. */
    onError?: (error: unknown, context: string) => void;
    onCompleteFail?: (errorMessage: string, ctx: TaskRunContext, task: AutomTask) => void;
}
