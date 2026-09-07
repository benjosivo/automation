/**
 * tasks.tsx
 * One card per task: what it is, whether it is on, when it fires, how it went.
 *
 * The schedule rows show the raw expression and the next occurrences rather than
 * a paraphrase. The occurrences come from the same parser that guards writes, so
 * they cannot disagree with what will actually happen — a translated sentence
 * can, and would be believed.
 */

import { useMemo, useState } from 'react';
import { expandCron, isValidCron } from '../cron.js';
import type { AutomTask, AutomTaskRun } from '../types.js';
import { formatDuration, hhmm, runDurationMs, STATUS_ICON, TRIGGER_ICON } from './format.js';
import { busyKey, type PanelProps } from './shared.js';
import { Note, StatusChip, TaskDot } from './ui.js';

const SPARK_COUNT = 10;
const PREVIEW_COUNT = 3;

const STATUS_COLOR: Record<string, string> = {
    completed: 'var(--autom-success)',
    failed: 'var(--autom-danger)',
    timeout: 'var(--autom-danger)',
    running: 'var(--autom-info)',
    pending: 'var(--autom-warning)',
};

/** The next few firings, formatted. Empty when the expression is unusable — the
 *  caller shows the invalid-expression warning instead. */
function preview(cronExpression: string, locale: string, count = PREVIEW_COUNT): string[] {
    const from = new Date(Date.now() + 60_000);
    const to = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);
    const format = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
    return expandCron(cronExpression, from, to, count).map((date) => `${format.format(date)} ${hhmm(date)}`);
}

export default function Tasks({ data, actions, labels, locale, colorOf, busy }: PanelProps) {
    const [search, setSearch] = useState('');
    const [showInactive, setShowInactive] = useState(true);

    const runningTaskIds = useMemo(() => new Set(data.active.db.map((r) => r.Autom_Task_id)), [data.active.db]);

    const runsByTask = useMemo(() => {
        const map = new Map<number, AutomTaskRun[]>();
        for (const run of data.runs) {
            const list = map.get(run.Autom_Task_id);
            if (list) list.push(run);
            else map.set(run.Autom_Task_id, [run]);
        }
        return map;
    }, [data.runs]);

    const visible = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return data.tasks.filter((task) => {
            if (!showInactive && task.isActive !== 1) return false;
            if (!needle) return true;
            return `${task.Name} ${task.Description} ${task.ConcurrencyGroup ?? ''}`.toLowerCase().includes(needle);
        });
    }, [data.tasks, search, showInactive]);

    if (data.tasks.length === 0) return <Note>{labels.noTasks}</Note>;

    return (
        <>
            <div className="autom-toolbar">
                <input
                    className="autom-input"
                    type="search"
                    value={search}
                    placeholder={labels.searchTasks}
                    aria-label={labels.searchTasks}
                    onChange={(event) => setSearch(event.target.value)}
                />
                <label className="autom-tiny" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                    <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />
                    {labels.showInactive}
                </label>
            </div>

            {visible.map((task) => (
                <TaskCard
                    key={task.idAutom_Task}
                    task={task}
                    schedules={data.schedules.filter((s) => s.Autom_Task_id === task.idAutom_Task)}
                    runs={runsByTask.get(task.idAutom_Task) ?? []}
                    isRunning={runningTaskIds.has(task.idAutom_Task)}
                    actions={actions}
                    labels={labels}
                    locale={locale}
                    color={colorOf(task.idAutom_Task)}
                    busy={busy}
                />
            ))}
        </>
    );
}

function TaskCard({
    task,
    schedules,
    runs,
    isRunning,
    actions,
    labels,
    locale,
    color,
    busy,
}: {
    task: AutomTask;
    schedules: PanelProps['data']['schedules'];
    runs: AutomTaskRun[];
    isRunning: boolean;
    actions: PanelProps['actions'];
    labels: PanelProps['labels'];
    locale: string;
    color: string;
    busy: PanelProps['busy'];
}) {
    const taskBusy = busy.has(busyKey.task(task.idAutom_Task));
    const last = runs[0];
    const spark = runs.slice(0, SPARK_COUNT).reverse();
    const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });

    return (
        <article className={`autom-task${task.isActive === 1 ? '' : ' autom-task-off'}`}>
            <div className="autom-task-head">
                <div className="autom-task-meta">
                    <TaskDot color={color} pulsing={isRunning} />
                    <span className="autom-task-name">{task.Name}</span>
                    {task.ConcurrencyGroup && <span className="autom-chip">{task.ConcurrencyGroup}</span>}
                    {isRunning && <span className="autom-chip autom-chip-running">{labels.running}</span>}
                    {task.isActive !== 1 && <span className="autom-chip">{labels.inactive}</span>}
                </div>
                <div className="autom-task-actions">
                    <button type="button" className="autom-btn autom-btn-primary" disabled={taskBusy} onClick={() => actions.triggerTask(task.idAutom_Task)}>
                        ▶ {labels.run}
                    </button>
                    <button type="button" className="autom-btn" disabled={taskBusy} onClick={() => actions.toggleTask(task)}>
                        {task.isActive === 1 ? labels.deactivate : labels.activate}
                    </button>
                    <button type="button" className="autom-btn" onClick={() => actions.showTaskHistory(task.idAutom_Task)}>
                        {labels.taskHistory}
                    </button>
                </div>
            </div>

            <p className="autom-task-desc">{task.Description}</p>

            {schedules.length === 0 ? (
                <p className="autom-tiny autom-muted" style={{ marginTop: '0.5rem' }}>
                    {labels.noSchedule}
                </p>
            ) : (
                schedules.map((schedule) => {
                    const valid = isValidCron(schedule.CronExpression);
                    const upcoming = valid && schedule.isActive === 1 && task.isActive === 1 ? preview(schedule.CronExpression, locale, 1) : [];
                    const scheduleBusy = busy.has(busyKey.schedule(schedule.idAutom_Schedule));
                    return (
                        <div key={schedule.idAutom_Schedule} className={`autom-sched${schedule.isActive === 1 ? '' : ' autom-sched-off'}`}>
                            <code className="autom-sched-cron">{schedule.CronExpression}</code>
                            <span className="autom-sched-grow autom-tiny autom-muted">
                                {valid ? upcoming[0] && `${labels.next} · ${upcoming[0]}` : <span className="autom-table-err">{labels.invalidExpression}</span>}
                            </span>
                            <span className="autom-sched-actions">
                                <button type="button" className="autom-btn autom-btn-ghost" onClick={() => actions.editSchedule(task.idAutom_Task, schedule)}>
                                    {labels.edit}
                                </button>
                                <button type="button" className="autom-btn autom-btn-ghost" disabled={scheduleBusy} onClick={() => actions.toggleSchedule(schedule)}>
                                    {schedule.isActive === 1 ? labels.disable : labels.enable}
                                </button>
                                <button
                                    type="button"
                                    className="autom-btn autom-btn-ghost autom-btn-danger"
                                    disabled={scheduleBusy}
                                    onClick={() => actions.deleteSchedule(schedule)}
                                >
                                    {labels.remove}
                                </button>
                            </span>
                        </div>
                    );
                })
            )}

            <button type="button" className="autom-btn autom-btn-ghost" style={{ marginTop: '0.4rem' }} onClick={() => actions.editSchedule(task.idAutom_Task)}>
                + {labels.addSchedule}
            </button>

            <div className="autom-task-foot">
                {last ? (
                    <>
                        <span className="autom-muted">{labels.lastRun}</span>
                        <StatusChip status={last.Status} />
                        <span className="autom-muted">
                            {TRIGGER_ICON[last.TriggeredBy]} {last.TriggeredBy} · {dateTime.format(new Date(last.StartedAt))} · {formatDuration(runDurationMs(last))}
                        </span>
                        <button type="button" className="autom-btn autom-btn-ghost" onClick={() => actions.showRun(last)}>
                            {labels.view}
                        </button>
                    </>
                ) : (
                    <span className="autom-muted">{labels.never}</span>
                )}

                {spark.length > 0 && (
                    <span className="autom-spark" aria-hidden="true">
                        {spark.map((run) => (
                            <span
                                key={run.idAutom_Task_Run}
                                style={{ background: STATUS_COLOR[run.Status] ?? 'var(--autom-border)' }}
                                title={`${STATUS_ICON[run.Status]} ${run.Status}`}
                            />
                        ))}
                    </span>
                )}

                {task.RetryLimit > 0 && (
                    <span className="autom-muted">
                        {task.RetryLimit} {labels.retries} · {task.RetryDelaySeconds}s
                    </span>
                )}
            </div>
        </article>
    );
}
