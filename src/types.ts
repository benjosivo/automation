export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout';
export type TriggerSource = 'scheduler' | 'api' | 'manual';

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
    Autom_Task_Run_id: number | null;
    LockedAt: Date | null;
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
}
