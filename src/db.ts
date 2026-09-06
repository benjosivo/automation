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
        query: `SELECT r.*, t.Name AS TaskName
                  FROM Autom_Task_Run r
                  JOIN Autom_Task t ON t.idAutom_Task = r.Autom_Task_id
                 WHERE ${conditions.join(' AND ')}
              ORDER BY r.StartedAt DESC
                 LIMIT ?`,
        values,
    });
    return assertRows<AutomTaskRun>(result, 'getAllRuns');
}

export async function getRunsForTask(taskId: number, limit = 20): Promise<AutomTaskRun[]> {
    const result = await executeMySQLQuery2({
        query: `SELECT * FROM Autom_Task_Run
                 WHERE Autom_Task_id = ?
              ORDER BY StartedAt DESC
                 LIMIT ?`,
        values: [taskId.toString(), limit.toString()],
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

export async function acquireLock(group: string, runId: number): Promise<boolean> {
    // INSERT IGNORE: an existing row does not throw, it comes back with affectedRows = 0
    const result = (await executeMySQLQuery2({
        query: `INSERT IGNORE INTO Autom_Task_Lock (ConcurrencyGroup, Autom_Task_Run_id, LockedAt)
                VALUES (?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    Autom_Task_Run_id = IF(Autom_Task_Run_id IS NULL, VALUES(Autom_Task_Run_id), Autom_Task_Run_id),
                    LockedAt          = IF(Autom_Task_Run_id IS NULL, NOW(), LockedAt)`,
        values: [group, runId],
    })) as any;
    assertOk(result, 'acquireLock');
    // affectedRows = 1 means this run took the lock, 0 means someone else holds it
    return (result.affectedRows as number) > 0;
}

export async function releaseLock(group: string, runId: number): Promise<void> {
    const result = await executeMySQLQuery2({
        query: `UPDATE Autom_Task_Lock
                   SET Autom_Task_Run_id = NULL, LockedAt = NULL
                 WHERE ConcurrencyGroup = ? AND Autom_Task_Run_id = ?`,
        values: [group, runId],
    });
    assertOk(result, 'releaseLock');
}

/** Boot recovery: locks are stale after a crash. Only this runner's, for the
 *  same reason as timeoutStaleRuns — another process's locks are live, not stale. */
export async function clearAllLocks(): Promise<void> {
    const result = await executeMySQLQuery2({
        query: `UPDATE Autom_Task_Lock l
                  JOIN Autom_Task_Run r ON r.idAutom_Task_Run = l.Autom_Task_Run_id
                  JOIN Autom_Task t ON t.idAutom_Task = r.Autom_Task_id
                   SET l.Autom_Task_Run_id = NULL, l.LockedAt = NULL
                 WHERE t.Runner = ?`,
        values: [runner()],
    });
    assertOk(result, 'clearAllLocks');
}
