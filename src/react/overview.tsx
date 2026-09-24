/**
 * overview.tsx
 * What is happening now, what failed lately, what fires next.
 *
 * Every figure is computed from the collections already loaded — the runner has
 * no statistics endpoint, and adding one would only move this arithmetic behind
 * a network call.
 */

import { useEffect, useMemo, useState } from 'react';
import { expandCron } from '../cron.js';
import type { AutomTaskRun, TriggerSource } from '../types.js';
import { addDays, dayKey, formatDuration, hhmm, relativeTime, runDurationMs, TRIGGER_ICON, truncate } from './format.js';
import { TRIGGER_SOURCES } from './filters.js';
import type { Labels } from './i18n.js';
import type { PanelProps } from './shared.js';
import { Note, Panel, ProgressBar, Stat, StatusChip, TaskDot } from './ui.js';

const NEXT_WINDOW_HOURS = 48;
const NEXT_COUNT = 12;
const FAILURE_COUNT = 10;
const RUNNING_LOG_LINES = 18;
const ACTIVITY_DAYS = 14;
/** How often the relative times ("in 3 minutes") are recomputed. The stream only
 *  re-renders on runner events, which can be an hour apart. */
const CLOCK_TICK_MS = 30_000;
/** The executor's marker on a failed attempt that will be retried. Such a row is
 *  an intermediate step, not a failure anyone has to act on — see executor.ts. */
const RETRYING_SUFFIX = '— retrying';

export interface OverviewProps extends PanelProps {
    /** The runs with the task filter applied but not the trigger one, so the
     *  breakdown can still count a source that is currently hidden. */
    triggerRuns: AutomTaskRun[];
    hiddenTriggers: ReadonlySet<TriggerSource>;
    toggleTrigger: (source: TriggerSource) => void;
    /** Start of the loaded run window when it is full, null when it holds every run.
     *  Days before it are drawn as not loaded rather than as empty. */
    loadedSince: Date | null;
}

function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(id);
    }, [intervalMs]);
    return now;
}

function dayLabel(date: Date, now: number, labels: Labels, locale: string): string {
    const today = new Date(now);
    if (dayKey(date) === dayKey(today)) return labels.today.toLowerCase();
    if (dayKey(date) === dayKey(addDays(today, 1))) return labels.tomorrow;
    return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
}

export default function Overview({ data, actions, labels, locale, colorOf, triggerRuns, hiddenTriggers, toggleTrigger, loadedSince }: OverviewProps) {
    const { tasks, schedules, runs, active } = data;
    const now = useNow(CLOCK_TICK_MS);

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

    // Dev runs are someone testing, and a retried attempt is not the last word on
    // its run: neither is a failure to act on.
    const failures = useMemo(
        () =>
            runs
                .filter((r) => (r.Status === 'failed' || r.Status === 'timeout') && r.TriggeredBy !== 'dev')
                .filter((r) => !r.ErrorMessage?.trimEnd().endsWith(RETRYING_SUFFIX))
                .slice(0, FAILURE_COUNT),
        [runs],
    );

    const breakdown = useMemo(() => {
        const since = Date.now() - 24 * 60 * 60 * 1000;
        const counts = new Map<TriggerSource, number>(TRIGGER_SOURCES.map((source) => [source, 0]));
        for (const run of triggerRuns) {
            if (new Date(run.StartedAt).getTime() < since) continue;
            counts.set(run.TriggeredBy, (counts.get(run.TriggeredBy) ?? 0) + 1);
        }
        return counts;
    }, [triggerRuns]);

    const activeTasks = tasks.filter((t) => t.isActive === 1).length;
    const activeSchedules = schedules.filter((s) => s.isActive === 1).length;

    // The DB list is what is running, including a run whose process died and left
    // its row behind. The progress lives in the runner's memory, so the two are
    // joined by runId rather than one replacing the other — a row with no match
    // simply has no bar.
    const running = active.db;
    const progressOf = new Map(active.memory.map((run) => [run.runId, run.progress]));

    const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });

    return (
        <>
            <div className="autom-stats">
                <Stat label={labels.activeTasks} value={activeTasks} sub={`${labels.of} ${tasks.length}`} />
                <Stat label={labels.activeSchedules} value={activeSchedules} sub={`${labels.of} ${schedules.length}`} />
                <Stat label={labels.runningNow} value={running.length} tone={running.length > 0 ? 'accent' : undefined} />
                <Stat label={labels.succeeded24h} value={stats.succeeded} tone="good" />
                <Stat label={labels.failed24h} value={stats.failed} tone={stats.failed > 0 ? 'bad' : undefined} />
                <Stat
                    label={labels.successRate}
                    value={stats.rate === null ? '—' : `${stats.rate} %`}
                    sub={stats.avg === null ? undefined : `${formatDuration(Math.round(stats.avg))} ${labels.avgDuration}`}
                />
            </div>

            <div className="autom-breakdown">
                {TRIGGER_SOURCES.map((source) => (
                    <button
                        key={source}
                        type="button"
                        className="autom-btn autom-breakdown-seg"
                        aria-pressed={!hiddenTriggers.has(source)}
                        onClick={() => toggleTrigger(source)}
                    >
                        <span aria-hidden="true">{TRIGGER_ICON[source]}</span>
                        {breakdown.get(source) ?? 0} {labels.triggers[source]}
                    </button>
                ))}
            </div>

            {running.length > 0 && (
                <Panel title={labels.runningNow}>
                    {running.map((run) => {
                        const progress = progressOf.get(run.idAutom_Task_Run);
                        return (
                            <div key={run.idAutom_Task_Run} className="autom-running">
                                <div className="autom-sched">
                                    <TaskDot color={colorOf(run.Autom_Task_id)} pulsing />
                                    <span className="autom-sched-grow">{run.TaskName ?? `#${run.Autom_Task_id}`}</span>
                                    {progress?.step && <span className="autom-tiny autom-running-step">{truncate(progress.step, 50)}</span>}
                                    <span className="autom-tiny autom-muted">
                                        {progress?.percent !== null && progress?.percent !== undefined && `${Math.round(progress.percent)} % · `}
                                        {labels.colStarted} {dateTime.format(new Date(run.StartedAt))} · {labels.colAttempt} {run.Attempt}
                                    </span>
                                </div>
                                <ProgressBar percent={progress?.percent ?? null} label={labels.progress} />
                                {progress?.logs.length ? (
                                    <div className="autom-tiny autom-muted autom-running-log">
                                        {progress.logs.slice(-RUNNING_LOG_LINES).map((line, i) => (
                                            <div key={i} className="autom-running-log-line">
                                                {truncate(line, 160)}
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                </Panel>
            )}

            <div className="autom-overview-grid">
                <Panel title={labels.nextUp} actions={<span className="autom-tiny autom-muted">{labels.next48h}</span>}>
                    {nextUp.length === 0 ? (
                        <Note>{labels.nothingScheduled}</Note>
                    ) : (
                        <div className="autom-rows">
                            {nextUp.map((occurrence, i) => (
                                <button
                                    key={`${occurrence.taskId}-${occurrence.date.getTime()}-${i}`}
                                    type="button"
                                    className="autom-row"
                                    onClick={() => actions.goToCalendar(occurrence.date)}
                                >
                                    <span className="autom-row-time autom-mono">
                                        {dayLabel(occurrence.date, now, labels, locale)} {hhmm(occurrence.date)}
                                    </span>
                                    <TaskDot color={colorOf(occurrence.taskId)} />
                                    <span className="autom-row-name">{occurrence.taskName}</span>
                                    <span className="autom-tiny autom-muted">{relativeTime(occurrence.date, now, locale)}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </Panel>

                <Panel title={labels.recentFailures}>
                    {failures.length === 0 ? (
                        <Note>{labels.noFailures}</Note>
                    ) : (
                        <div className="autom-rows">
                            {failures.map((run) => (
                                <div key={run.idAutom_Task_Run} className="autom-failure">
                                    <div className="autom-failure-head">
                                        <StatusChip status={run.Status} />
                                        <TaskDot color={colorOf(run.Autom_Task_id)} />
                                        <span className="autom-row-name">{run.TaskName ?? `#${run.Autom_Task_id}`}</span>
                                        <span className="autom-tiny autom-muted" title={dateTime.format(new Date(run.StartedAt))}>
                                            {relativeTime(new Date(run.StartedAt), now, locale)}
                                        </span>
                                    </div>
                                    <div className="autom-failure-head">
                                        <span className="autom-chip">
                                            {TRIGGER_ICON[run.TriggeredBy]} {labels.triggers[run.TriggeredBy]}
                                        </span>
                                        {run.Attempt > 1 && (
                                            <span className="autom-tiny autom-muted">
                                                {labels.colAttempt} {run.Attempt}
                                            </span>
                                        )}
                                        <button type="button" className="autom-btn autom-btn-ghost autom-btn-danger autom-failure-msg" onClick={() => actions.showRun(run)}>
                                            ⚠ {truncate(run.ErrorMessage ?? labels.view, 80)}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </Panel>
            </div>

            <Panel title={labels.activity} actions={<span className="autom-tiny autom-muted">{labels.last14Days}</span>}>
                <ActivityChart runs={runs} now={now} loadedSince={loadedSince} labels={labels} locale={locale} />
            </Panel>
        </>
    );
}

export function nextOccurrenceLabel(cronExpression: string, locale: string): string | null {
    const [next] = expandCron(cronExpression, new Date(Date.now() + 60_000), new Date(Date.now() + 366 * 24 * 60 * 60 * 1000), 1);
    if (!next) return null;
    return `${new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(next)} ${hhmm(next)}`;
}

/**
 * Fourteen days of settled runs, stacked succeeded / failed.
 *
 * Plain CSS rather than a chart library: the package has react as its only
 * front-end peer, and fourteen bars do not justify a second one. Dev runs are
 * left out, as in the failure list. A day older than the loaded window is drawn
 * as not loaded — showing it as zero would claim nothing ran.
 */
function ActivityChart({ runs, now, loadedSince, labels, locale }: { runs: AutomTaskRun[]; now: number; loadedSince: Date | null; labels: Labels; locale: string }) {
    // Keyed on the date rather than on `now`, which moves every tick: the list
    // only has to be rebuilt when the day changes.
    const todayKey = dayKey(new Date(now));
    const days = useMemo(() => {
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);
        const list = Array.from({ length: ACTIVITY_DAYS }, (_, i) => {
            const date = addDays(today, i - (ACTIVITY_DAYS - 1));
            return { date, key: dayKey(date), ok: 0, ko: 0, loaded: !loadedSince || dayKey(date) >= dayKey(loadedSince) };
        });
        const index = new Map(list.map((day, i) => [day.key, i]));
        for (const run of runs) {
            if (run.TriggeredBy === 'dev') continue;
            const i = index.get(dayKey(new Date(run.StartedAt)));
            if (i === undefined) continue;
            if (run.Status === 'completed') list[i].ok++;
            else if (run.Status === 'failed' || run.Status === 'timeout') list[i].ko++;
        }
        return list;
    }, [runs, loadedSince, todayKey]);

    // Even, so the middle gridline sits on a whole number rather than on 0.5.
    const tallest = Math.max(1, ...days.map((d) => d.ok + d.ko));
    const max = tallest % 2 ? tallest + 1 : tallest;
    const ticks = [max, max / 2, 0];
    const dayFormat = new Intl.DateTimeFormat(locale, { day: 'numeric', month: '2-digit' });
    const longFormat = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' });

    return (
        <>
            <div className="autom-legend" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
                <span className="autom-activity-key">
                    <span className="autom-activity-swatch" style={{ background: 'var(--autom-success)' }} />✓ {labels.succeeded}
                </span>
                <span className="autom-activity-key">
                    <span className="autom-activity-swatch" style={{ background: 'var(--autom-danger)' }} />✗ {labels.failed}
                </span>
            </div>
            <div className="autom-activity">
                <div className="autom-activity-axis autom-tiny autom-muted">
                    {ticks.map((tick, i) => (
                        <span key={i}>{tick}</span>
                    ))}
                </div>
                <div className="autom-activity-plot">
                    {days.map((day) => (
                        <div
                            key={day.key}
                            className={`autom-activity-col${day.loaded ? '' : ' autom-activity-unloaded'}`}
                            title={
                                day.loaded
                                    ? `${longFormat.format(day.date)}\n✓ ${labels.succeeded} : ${day.ok}\n✗ ${labels.failed} : ${day.ko}`
                                    : `${longFormat.format(day.date)} — ${labels.notLoaded}`
                            }
                        >
                            {day.loaded ? (
                                <div className="autom-activity-stack" style={{ height: `${((day.ok + day.ko) / max) * 100}%` }}>
                                    {day.ko > 0 && <span className="autom-activity-ko" style={{ flexGrow: day.ko }} />}
                                    {day.ok > 0 && <span className="autom-activity-ok" style={{ flexGrow: day.ok }} />}
                                </div>
                            ) : (
                                <span className="autom-tiny autom-muted autom-activity-na">{labels.notLoaded}</span>
                            )}
                        </div>
                    ))}
                </div>
                <div />
                <div className="autom-activity-labels autom-tiny autom-muted">
                    {days.map((day) => (
                        <span key={day.key}>{dayFormat.format(day.date)}</span>
                    ))}
                </div>
            </div>
            {loadedSince && (
                <p className="autom-tiny autom-muted" style={{ marginTop: '0.4rem' }}>
                    {labels.loadedSince} {longFormat.format(loadedSince)}.
                </p>
            )}
        </>
    );
}
