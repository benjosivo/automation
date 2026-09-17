/**
 * db.ts
 * Every Autom_* query. Several runners share one database, so anything that
 * schedules, recovers or reports is scoped to cfg().runner — see the Runner
 * column added by sql/002_autom_runner.sql.
 */

import { executeMySQLQuery2 } from '@benjosivo/mysql';
import { runner } from './config.js';
import type { AutomTask, AutomSchedule, AutomTaskRun, TriggerSource } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isQueryError(result: unknown): result is { error: string } {
    return typeof result === 'object' && result !== null && 'error' in result;
}

function assertRows<T>(result: unknown, context: string): T[] {
    if (isQueryError(result)) throw new Error(`[DB:${context}] ${result.error}`);
    return result as T[];
}

function assertSingle<T>(result: unknown, context: string): T | null {
    const rows = assertRows<T>(result, context);
    return rows[0] ?? null;
}

function assertOk(result: unknown, context: string): void {
    if (isQueryError(result)) throw new Error(`[DB:${context}] ${result.error}`);
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

/** This runner's tasks only — the boot sync must not publish Redis active flags
 *  for tasks another process owns. */
export async function getAllTasks(): Promise<AutomTask[]> {
    const result = await executeMySQLQuery2({
        query: 'SELECT * FROM Autom_Task WHERE Runner = ? ORDER BY Name ASC',
        values: [runner()],
    });
    return assertRows<AutomTask>(result, 'getAllTasks');
}

/** Deliberately unscoped: the executor and the API need to read a foreign task's
 *  row in order to recognise it as foreign and refuse it. */
export async function getTaskById(id: number): Promise<AutomTask | null> {
    const result = await executeMySQLQuery2({
        query: 'SELECT * FROM Autom_Task WHERE idAutom_Task = ?',
        values: [id],
    });
    return assertSingle<AutomTask>(result, 'getTaskById');
}

export async function getTaskByName(Name: string): Promise<AutomTask | null> {
    const result = await executeMySQLQuery2({
        query: 'SELECT * FROM Autom_Task WHERE Name = ?',
        values: [Name],
    });
    return assertSingle<AutomTask>(result, 'getTaskByName');
}

export async function updateTask(
    id: number,
    fields: Partial<Pick<AutomTask, 'isActive' | 'RetryLimit' | 'RetryDelaySeconds' | 'Description'>>,
): Promise<void> {
    const sets = Object.keys(fields)
        .map((k) => `${k} = ?`)
        .join(', ');
    const values = [...Object.values(fields), id];
    const result = await executeMySQLQuery2({
        query: `UPDATE Autom_Task SET ${sets} WHERE idAutom_Task = ?`,
        values,
    });
    assertOk(result, 'updateTask');
}

// ─── Schedules ────────────────────────────────────────────────────────────────

export async function getAllSchedules(): Promise<AutomSchedule[]> {
    const result = await executeMySQLQuery2({
        query: `SELECT s.*, t.Name AS TaskName
                  FROM Autom_Schedule s
                  JOIN Autom_Task t ON t.idAutom_Task = s.Autom_Task_id
                 WHERE t.Runner = ?
              ORDER BY s.Autom_Task_id ASC`,
        values: [runner()],
    });
    return assertRows<AutomSchedule>(result, 'getAllSchedules');
}

/** Without the Runner filter every runner registers every cron, so each schedule
 *  fires once per process and each one tries to load modules it does not ship. */
export async function getActiveSchedules(): Promise<AutomSchedule[]> {
    const result = await executeMySQLQuery2({
        query: `SELECT s.* FROM Autom_Schedule s
                  JOIN Autom_Task t ON t.idAutom_Task = s.Autom_Task_id
                 WHERE s.isActive = 1 AND t.isActive = 1 AND t.Runner = ?`,
        values: [runner()],
    });
    return assertRows<AutomSchedule>(result, 'getActiveSchedules');
}

/** Deliberately unscoped, for the same reason as getTaskById: the API has to read
 *  a foreign schedule's row in order to recognise it as foreign and refuse it.
 *  Runner comes from the parent task — a schedule has no runner of its own. */
export async function getScheduleById(id: number): Promise<(AutomSchedule & { Runner: string }) | null> {
    const result = await executeMySQLQuery2({
        query: `SELECT s.*, t.Runner, t.Name AS TaskName
                  FROM Autom_Schedule s
                  JOIN Autom_Task t ON t.idAutom_Task = s.Autom_Task_id
                 WHERE s.idAutom_Schedule = ?`,
        values: [id],
    });
    return assertSingle<AutomSchedule & { Runner: string }>(result, 'getScheduleById');
}

export async function createSchedule(taskId: number, cronExpression: string, isActive: 0 | 1 = 1): Promise<number> {
    const result = (await executeMySQLQuery2({
        query: 'INSERT INTO Autom_Schedule (Autom_Task_id, CronExpression, isActive) VALUES (?, ?, ?)',
        values: [taskId, cronExpression, isActive],
    })) as any;
    assertOk(result, 'createSchedule');
    return result.insertId as number;
}

export async function updateSchedule(id: number, fields: Partial<Pick<AutomSchedule, 'CronExpression' | 'isActive'>>): Promise<void> {
    const sets = Object.keys(fields)
        .map((k) => `${k} = ?`)
        .join(', ');
    const values = [...Object.values(fields), id];
    const result = await executeMySQLQuery2({
        query: `UPDATE Autom_Schedule SET ${sets} WHERE idAutom_Schedule = ?`,
        values,
    });
    assertOk(result, 'updateSchedule');
}

export async function deleteSchedule(id: number): Promise<void> {
    const result = await executeMySQLQuery2({
        query: 'DELETE FROM Autom_Schedule WHERE idAutom_Schedule = ?',
        values: [id],
    });
    assertOk(result, 'deleteSchedule');
}

// ─── Task Runs ────────────────────────────────────────────────────────────────

export async function createTaskRun(opts: { taskId: number; scheduleId: number | null; triggeredBy: TriggerSource; attempt: number }): Promise<number> {
    const result = (await executeMySQLQuery2({
        query: `INSERT INTO Autom_Task_Run
                    (Autom_Task_id, Autom_Schedule_id, Status, triggeredBy, Attempt, StartedAt)
                VALUES (?, ?, 'running', ?, ?, NOW())`,
        values: [opts.taskId, opts.scheduleId, opts.triggeredBy, opts.attempt],
    })) as any;
    assertOk(result, 'createTaskRun');
    return result.insertId as number;
}

export async function completeTaskRun(runId: number, output?: string): Promise<void> {
    const result = await executeMySQLQuery2({
        query: `UPDATE Autom_Task_Run
                   SET Status = 'completed', FinishedAt = NOW(), Output = ?
                 WHERE idAutom_Task_Run = ?`,
        values: [output ?? null, runId],
    });
    assertOk(result, 'completeTaskRun');
}

export async function failTaskRun(runId: number, errorMessage: string, output?: string): Promise<void> {
    const result = await executeMySQLQuery2({
        query: `UPDATE Autom_Task_Run
                   SET Status = 'failed', FinishedAt = NOW(), ErrorMessage = ?, Output = ?
                 WHERE idAutom_Task_Run = ?`,
        values: [errorMessage, output ?? null, runId],
    });
    assertOk(result, 'failTaskRun');
}

/** Boot recovery, this runner's rows only. Unscoped, it would declare another
 *  runner's live tasks dead every time this one restarts. */
export async function timeoutStaleRuns(): Promise<number> {
    const result = (await executeMySQLQuery2({
        query: `UPDATE Autom_Task_Run r
                  JOIN Autom_Task t ON t.idAutom_Task = r.Autom_Task_id
                   SET r.Status = 'timeout', r.FinishedAt = NOW(),
                       r.ErrorMessage = 'Server restarted — run was still in progress'
                 WHERE r.Status IN ('running', 'pending') AND t.Runner = ?`,
        values: [runner()],
    })) as any;
    assertOk(result, 'timeoutStaleRuns');
    return result.affectedRows as number;
}

/**
 * How much of `Output` a listed run carries.
 *
 * `Output` is a mediumtext, and this listing is loaded five hundred rows at a
 * time by the dashboard, so `SELECT r.*` meant re-sending every task's whole
 * output on every reload. What a list actually renders is the first line cut to
 * forty characters, which always fits well inside this.
 *
 * Whoever needs the text in full asks for one run — getRunById() does not
 * truncate.
 */
const OUTPUT_PREVIEW_CHARS = 200;

/** Every column of the run, with `Output` cut to OUTPUT_PREVIEW_CHARS. Spelled
 *  out rather than `r.*` precisely so that adding a column to the table does not
 *  silently put it back in a five-hundred-row payload. */
const RUN_LIST_COLUMNS = `r.idAutom_Task_Run, r.Autom_Task_id, r.Autom_Schedule_id, r.Status, r.TriggeredBy,
                          r.Attempt, r.StartedAt, r.FinishedAt, r.ErrorMessage,
                          LEFT(r.Output, ${OUTPUT_PREVIEW_CHARS}) AS Output`;

export async function getAllRuns(opts: { limit: number; statusFilter?: string; taskIdFilter?: number }): Promise<AutomTaskRun[]> {
    const { limit, statusFilter, taskIdFilter } = opts;
    const conditions: string[] = ['t.Runner = ?'];
    const values: any[] = [runner()];

    if (statusFilter) {
        conditions.push('r.Status = ?');
        values.push(statusFilter.toString());
    }
    if (taskIdFilter) {
        conditions.push('r.Autom_Task_id = ?');
        values.push(taskIdFilter.toString());
    }
    values.push(limit.toString());

    const result = await executeMySQLQuery2({
        query: `SELECT ${RUN_LIST_COLUMNS}, t.Name AS TaskName
                  FROM Autom_Task_Run r
                  JOIN Autom_Task t ON t.idAutom_Task = r.Autom_Task_id
                 WHERE ${conditions.join(' AND ')}
              ORDER BY r.StartedAt DESC
                 LIMIT ?`,
        values,
    });
    return assertRows<AutomTaskRun>(result, 'getAllRuns');
}

/** One run, `Output` included in full. Runner-scoped through the join, like
 *  every other listing here. */
export async function getRunById(id: number): Promise<AutomTaskRun | null> {
    const result = await executeMySQLQuery2({
        query: `SELECT r.*, t.Name AS TaskName
                  FROM Autom_Task_Run r
                  JOIN Autom_Task t ON t.idAutom_Task = r.Autom_Task_id
                 WHERE r.idAutom_Task_Run = ? AND t.Runner = ?`,
        values: [id.toString(), runner()],
    });
    return assertSingle<AutomTaskRun>(result, 'getRunById');
}

export async function getRunsForTask(taskId: number, limit = 20): Promise<AutomTaskRun[]> {
    const result = await executeMySQLQuery2({
        query: `SELECT r.*, t.Name AS TaskName
                  FROM Autom_Task_Run r
                  JOIN Autom_Task t ON t.idAutom_Task = r.Autom_Task_id
                 WHERE r.Autom_Task_id = ? AND t.Runner = ?
              ORDER BY r.StartedAt DESC
                 LIMIT ?`,
        values: [taskId.toString(), runner(), limit.toString()],
    });
    return assertRows<AutomTaskRun>(result, 'getRunsForTask');
}

export async function getRunningTasks(): Promise<AutomTaskRun[]> {
    const result = await executeMySQLQuery2({
        query: `SELECT r.*, t.Name AS TaskName
                  FROM Autom_Task_Run r
                  JOIN Autom_Task t ON t.idAutom_Task = r.Autom_Task_id
                 WHERE r.Status = 'running' AND t.Runner = ?
              ORDER BY r.StartedAt ASC`,
        values: [runner()],
    });
    return assertRows<AutomTaskRun>(result, 'getRunningTasks');
}

// ─── Locks ────────────────────────────────────────────────────────────────────

/**
 * Take the group's lock for this run, or report that someone else holds it.
 *
 * TWO STATEMENTS, BECAUSE affectedRows CANNOT BE ASKED THE QUESTION
 * -----------------------------------------------------------------
 * This used to be one `INSERT IGNORE … ON DUPLICATE KEY UPDATE` whose result was read as
 * "affectedRows = 1 took the lock, 0 means someone else holds it". MySQL does document 1 for an
 * insert, 2 for a real update and 0 for an existing row set to its current values — but only
 * without CLIENT_FOUND_ROWS, and mysql2 turns that flag on by default
 * (`getDefaultFlags()` lists FOUND_ROWS). With it, an unchanged row also reports 1.
 *
 * Measured against MySQL 8 through mysql2 on 10 September 2026: insert 1, contended 1,
 * re-acquire 2. Every branch was therefore > 0, so acquireLock() returned true to *every*
 * caller and ConcurrencyGroup excluded nothing at all. Nothing in the wild had noticed because
 * no task in that database had a ConcurrencyGroup set — the feature had never actually run.
 *
 * The form below never asks a count to mean something subtle. The INSERT only guarantees a row
 * exists; the UPDATE's WHERE is what decides, and it cannot match a lock somebody holds. Two
 * runners racing both reach the UPDATE, InnoDB serialises them on the row, and the second one
 * finds nothing to match. Locking happens once per run — the extra round trip is not a cost
 * worth trading correctness for.
 */
export async function acquireLock(group: string, runId: number): Promise<boolean> {
    // A concurrent runner having created the row first is the normal case, not an error:
    // IGNORE turns that duplicate-key collision into a no-op.
    const ensured = await executeMySQLQuery2({
        query: `INSERT IGNORE INTO Autom_Task_Lock (ConcurrencyGroup, Autom_Task_Run_id, LockedAt)
                VALUES (?, NULL, NOW())`,
        values: [group],
    });
    assertOk(ensured, 'acquireLock (ensure row)');

    // `Autom_Task_Run_id IS NULL` is the whole test — a held lock matches no row, so
    // affectedRows is 0 whatever the client flags say about counting.
    const taken = (await executeMySQLQuery2({
        query: `UPDATE Autom_Task_Lock
                   SET Autom_Task_Run_id = ?, LockedAt = NOW()
                 WHERE ConcurrencyGroup = ? AND Autom_Task_Run_id IS NULL`,
        values: [runId, group],
    })) as any;
    assertOk(taken, 'acquireLock');
    return (taken.affectedRows as number) > 0;
}

/**
 * Releasing clears the holder and nothing else.
 *
 * `LockedAt` is declared NOT NULL by sql/001_autom_tables.sql, so setting it to NULL fails
 * outright under STRICT_TRANS_TABLES (MySQL 1048, "Column 'LockedAt' cannot be null") — which
 * is the default. This function used to do exactly that, and the damage was quiet: the caller
 * in executor.ts swallows the rejection (`.catch(console.error)`), so the run looked fine while
 * the lock row kept its holder forever. Every later acquireLock() on that group then returned
 * false, and the task never ran again. clearAllLocks() below made the same mistake, but awaited
 * without a catch in startAutomationServer() — so a restart, the one thing that should have
 * recovered from it, threw during boot instead.
 *
 * The holder column alone decides whether the lock is free: acquireLock() branches on
 * `Autom_Task_Run_id IS NULL` and never reads `LockedAt`. Leaving the timestamp in place costs
 * nothing and needs no migration on databases already created from 001 — it just means
 * `LockedAt` reads as "when this group was last taken", not "when the current holder took it".
 */
export async function releaseLock(group: string, runId: number): Promise<void> {
    const result = await executeMySQLQuery2({
        query: `UPDATE Autom_Task_Lock
                   SET Autom_Task_Run_id = NULL
                 WHERE ConcurrencyGroup = ? AND Autom_Task_Run_id = ?`,
        values: [group, runId],
    });
    assertOk(result, 'releaseLock');
}

/** Boot recovery: locks are stale after a crash. Only this runner's, for the
 *  same reason as timeoutStaleRuns — another process's locks are live, not stale.
 *  `LockedAt` is left alone here for the reason given on releaseLock(). */
export async function clearAllLocks(): Promise<void> {
    const result = await executeMySQLQuery2({
        query: `UPDATE Autom_Task_Lock l
                  JOIN Autom_Task_Run r ON r.idAutom_Task_Run = l.Autom_Task_Run_id
                  JOIN Autom_Task t ON t.idAutom_Task = r.Autom_Task_id
                   SET l.Autom_Task_Run_id = NULL
                 WHERE t.Runner = ?`,
        values: [runner()],
    });
    assertOk(result, 'clearAllLocks');
}
