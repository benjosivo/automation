/**
 * overview.tsx
 * What is happening now, what failed lately, what fires next.
 *
 * Every figure is computed from the collections already loaded — the runner has
 * no statistics endpoint, and adding one would only move this arithmetic behind
 * a network call.
 */

import { useMemo } from 'react';
import { expandCron } from '../cron.js';
import { formatDuration, hhmm, runDurationMs, truncate } from './format.js';
import type { PanelProps } from './shared.js';
import { Note, Panel, Stat, StatusChip, TaskDot } from './ui.js';

const NEXT_WINDOW_HOURS = 48;
const NEXT_COUNT = 12;
const FAILURE_COUNT = 10;

export default function Overview({ data, actions, labels, locale, colorOf }: PanelProps) {
    const { tasks, schedules, runs, active } = data;

    const stats = useMemo(() => {
        const since = Date.now() - 24 * 60 * 60 * 1000;
        const recent = runs.filter((r) => new Date(r.StartedAt).getTime() >= since);
        const succeeded = recent.filter((r) => r.Status === 'completed');
        const failed = recent.filter((r) => r.Status === 'failed' || r.Status === 'timeout');
        const settled = succeeded.length + failed.length;

        const durations = succeeded.map(runDurationMs).filter((d): d is number => d !== null);
        const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

        return {
            succeeded: succeeded.length,
            failed: failed.length,
            // Undefined rather than 0 % when nothing has settled: a fresh install
            // showing "0 %" reads as broken.
            rate: settled ? Math.round((succeeded.length / settled) * 100) : null,
            avg,
        };
    }, [runs]);

    const nextUp = useMemo(() => {
        const activeTaskIds = new Set(tasks.filter((t) => t.isActive === 1).map((t) => t.idAutom_Task));
        const from = new Date();
        const to = new Date(from.getTime() + NEXT_WINDOW_HOURS * 60 * 60 * 1000);

        const occurrences: { date: Date; taskId: number; taskName: string }[] = [];
        for (const schedule of schedules) {
            if (schedule.isActive !== 1 || !activeTaskIds.has(schedule.Autom_Task_id)) continue;
            const task = tasks.find((t) => t.idAutom_Task === schedule.Autom_Task_id);
            for (const date of expandCron(schedule.CronExpression, from, to, NEXT_COUNT)) {
                occurrences.push({ date, taskId: schedule.Autom_Task_id, taskName: task?.Name ?? schedule.TaskName ?? '—' });
            }
        }
        return occurrences.sort((a, b) => a.date.getTime() - b.date.getTime()).slice(0, NEXT_COUNT);
    }, [schedules, tasks]);

    const failures = useMemo(
        () => runs.filter((r) => r.Status === 'failed' || r.Status === 'timeout').slice(0, FAILURE_COUNT),
        [runs],
    );

    const activeTasks = tasks.filter((t) => t.isActive === 1).length;
    const activeSchedules = schedules.filter((s) => s.isActive === 1).length;
    const running = active.db;

    const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
    const dayTime = new Intl.DateTimeFormat(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

    return (
        <>
            <div className="autom-stats">
                <Stat label={labels.activeTasks} value={activeTasks} sub={`${labels.of} ${tasks.length}`} />
                <Stat label={labels.activeSchedules} value={activeSchedules} sub={`${labels.of} ${schedules.length}`} />
                <Stat label={labels.runningNow} value={running.length} />
                <Stat label={labels.succeeded24h} value={stats.succeeded} />
                <Stat label={labels.failed24h} value={stats.failed} />
                <Stat
                    label={labels.successRate}
                    value={stats.rate === null ? '—' : `${stats.rate} %`}
                    sub={stats.avg === null ? undefined : `${formatDuration(Math.round(stats.avg))} ${labels.avgDuration}`}
                />
            </div>

            {running.length > 0 && (
                <Panel title={labels.runningNow}>
                    {running.map((run) => (
                        <div key={run.idAutom_Task_Run} className="autom-sched">
                            <TaskDot color={colorOf(run.Autom_Task_id)} pulsing />
                            <span className="autom-sched-grow">{run.TaskName ?? `#${run.Autom_Task_id}`}</span>
                            <span className="autom-tiny autom-muted">
                                {labels.colStarted} {dateTime.format(new Date(run.StartedAt))} · {labels.colAttempt} {run.Attempt}
                            </span>
                        </div>
                    ))}
                </Panel>
            )}

            <Panel title={labels.nextUp}>
                {nextUp.length === 0 ? (
                    <Note>{labels.nothingScheduled}</Note>
                ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                        {nextUp.map((occurrence, i) => (
                            <button
                                key={`${occurrence.taskId}-${occurrence.date.getTime()}-${i}`}
                                type="button"
                                className="autom-btn"
                                onClick={() => actions.goToCalendar(occurrence.date)}
                            >
                                <TaskDot color={colorOf(occurrence.taskId)} />
                                <span className="autom-tiny">
                                    {dayTime.format(occurrence.date)} · {occurrence.taskName}
                                </span>
                            </button>
                        ))}
                    </div>
                )}
            </Panel>

            <Panel title={labels.recentFailures}>
                {failures.length === 0 ? (
                    <Note>{labels.noFailures}</Note>
                ) : (
                    <div className="autom-table-wrap">
                        <table className="autom-table">
                            <tbody>
                                {failures.map((run) => (
                                    <tr key={run.idAutom_Task_Run}>
                                        <td>
                                            <TaskDot color={colorOf(run.Autom_Task_id)} /> {run.TaskName ?? `#${run.Autom_Task_id}`}
                                        </td>
                                        <td>
                                            <StatusChip status={run.Status} />
                                        </td>
                                        <td className="autom-tiny autom-muted">{dateTime.format(new Date(run.StartedAt))}</td>
                                        <td className="autom-table-err autom-tiny">{truncate(run.ErrorMessage ?? '', 60)}</td>
                                        <td>
                                            <button type="button" className="autom-btn autom-btn-ghost" onClick={() => actions.showRun(run)}>
                                                {labels.view}
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Panel>
        </>
    );
}

export function nextOccurrenceLabel(cronExpression: string, locale: string): string | null {
    const [next] = expandCron(cronExpression, new Date(Date.now() + 60_000), new Date(Date.now() + 366 * 24 * 60 * 60 * 1000), 1);
    if (!next) return null;
    return `${new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(next)} ${hhmm(next)}`;
}
