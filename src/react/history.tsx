/**
 * history.tsx
 * The run log, filtered in the browser.
 *
 * The filters do not refetch. One window of runs is loaded for the whole
 * dashboard and narrowed here, which keeps switching a filter instant and keeps
 * the calendar and the overview reading the same rows as this table.
 */

import { useMemo } from 'react';
import type { TaskStatus } from '../types.js';
import { formatDuration, runDurationMs, truncate } from './format.js';
import type { PanelProps } from './shared.js';
import { Note, StatusChip, TaskDot } from './ui.js';

const STATUSES: TaskStatus[] = ['completed', 'failed', 'timeout', 'running', 'pending'];

export interface HistoryProps extends PanelProps {
    taskFilter: number | '';
    setTaskFilter: (value: number | '') => void;
    statusFilter: TaskStatus | '';
    setStatusFilter: (value: TaskStatus | '') => void;
    /** True once the loaded window is full, so older runs exist but are not here. */
    windowFull: boolean;
    onRefresh: () => void;
}

export default function History({
    data,
    actions,
    labels,
    locale,
    colorOf,
    taskFilter,
    setTaskFilter,
    statusFilter,
    setStatusFilter,
    windowFull,
    onRefresh,
}: HistoryProps) {
    const rows = useMemo(
        () =>
            data.runs.filter((run) => {
                if (taskFilter !== '' && run.Autom_Task_id !== taskFilter) return false;
                if (statusFilter !== '' && run.Status !== statusFilter) return false;
                return true;
            }),
        [data.runs, taskFilter, statusFilter],
    );

    const summary = useMemo(() => {
        const counts: Partial<Record<TaskStatus, number>> = {};
        const durations: number[] = [];
        for (const run of rows) {
            counts[run.Status] = (counts[run.Status] ?? 0) + 1;
            const ms = runDurationMs(run);
            if (ms !== null) durations.push(ms);
        }
        const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
        return { counts, avg };
    }, [rows]);

    const scheduleCron = useMemo(() => new Map(data.schedules.map((s) => [s.idAutom_Schedule, s.CronExpression])), [data.schedules]);
    const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' });

    return (
        <>
            <div className="autom-toolbar">
                <select className="autom-select" value={statusFilter} aria-label={labels.status} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | '')}>
                    <option value="">{labels.allStatuses}</option>
                    {STATUSES.map((status) => (
                        <option key={status} value={status}>
                            {status}
                        </option>
                    ))}
                </select>

                <select
                    className="autom-select"
                    value={taskFilter}
                    aria-label={labels.colTask}
                    onChange={(event) => setTaskFilter(event.target.value === '' ? '' : Number(event.target.value))}
                >
                    <option value="">{labels.allTasks}</option>
                    {data.tasks.map((task) => (
                        <option key={task.idAutom_Task} value={task.idAutom_Task}>
                            {task.Name}
                        </option>
                    ))}
                </select>

                <button type="button" className="autom-btn" onClick={onRefresh}>
                    {labels.refresh}
                </button>

                <span className="autom-tiny autom-muted" style={{ marginLeft: 'auto' }}>
                    {STATUSES.filter((status) => summary.counts[status]).map((status) => (
                        <span key={status} style={{ marginLeft: '0.5rem' }}>
                            <StatusChip status={status} /> {summary.counts[status]}
                        </span>
                    ))}
                    {summary.avg !== null && <span style={{ marginLeft: '0.75rem' }}>{formatDuration(Math.round(summary.avg))}</span>}
                </span>
            </div>

            {rows.length === 0 ? (
                <Note>{labels.noRuns}</Note>
            ) : (
                <div className="autom-table-wrap">
                    <table className="autom-table">
                        <thead>
                            <tr>
                                <th>{labels.colTask}</th>
                                <th>{labels.colStatus}</th>
                                <th>{labels.colTrigger}</th>
                                <th>{labels.colAttempt}</th>
                                <th>{labels.colStarted}</th>
                                <th>{labels.colDuration}</th>
                                <th>{labels.colSchedule}</th>
                                <th>{labels.colOutput}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((run) => (
                                <tr key={run.idAutom_Task_Run}>
                                    <td style={{ whiteSpace: 'nowrap' }}>
                                        <TaskDot color={colorOf(run.Autom_Task_id)} /> {run.TaskName ?? `#${run.Autom_Task_id}`}
                                    </td>
                                    <td>
                                        <StatusChip status={run.Status} />
                                    </td>
                                    <td className="autom-tiny">{run.TriggeredBy}</td>
                                    <td className="autom-tiny">{run.Attempt}</td>
                                    <td className="autom-tiny autom-muted" style={{ whiteSpace: 'nowrap' }}>
                                        {dateTime.format(new Date(run.StartedAt))}
                                    </td>
                                    <td className="autom-tiny">{formatDuration(runDurationMs(run))}</td>
                                    <td className="autom-mono autom-tiny autom-muted">
                                        {run.Autom_Schedule_id === null ? '—' : (scheduleCron.get(run.Autom_Schedule_id) ?? `#${run.Autom_Schedule_id}`)}
                                    </td>
                                    <td>
                                        {run.ErrorMessage ? (
                                            <button type="button" className="autom-btn autom-btn-ghost autom-btn-danger" onClick={() => actions.showRun(run)}>
                                                {truncate(run.ErrorMessage, 40)}
                                            </button>
                                        ) : run.Output ? (
                                            <button type="button" className="autom-btn autom-btn-ghost" onClick={() => actions.showRun(run)}>
                                                {truncate(run.Output.split('\n')[0] ?? '', 40)}
                                            </button>
                                        ) : (
                                            <span className="autom-muted">—</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {windowFull && <p className="autom-tiny autom-muted" style={{ marginTop: '0.5rem' }}>{labels.limitReached}</p>}
        </>
    );
}
