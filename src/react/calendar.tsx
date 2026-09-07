/**
 * calendar.tsx
 * Past runs and future occurrences on one timeline.
 *
 * The two halves come from different places and that is the point of the view:
 * everything before now is a row in Autom_Task_Run, everything after is computed
 * by expanding the cron expressions. Seeing them in the same grid is what makes
 * "it should have fired last night and did not" visible at a glance.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { expandCron } from '../cron.js';
import type { AutomTaskRun, TaskStatus } from '../types.js';
import { addDays, dayKey, formatDuration, hhmm, runDurationMs, startOfWeek, worstStatus } from './format.js';
import type { PanelProps } from './shared.js';
import { Modal, Note, StatusChip, TaskDot } from './ui.js';

export type CalView = 'month' | 'week' | 'task';

/** Hard stop on expansion. `* * * * *` over six weeks is 60 000 dates, and this
 *  feeds a grid — a truncated month is a bad view, a frozen tab is a bug. */
const EXPAND_CAP = 750;
const CHIPS_PER_DAY = 3;
const CHIPS_PER_DAY_COMPACT = 12;

interface CalEvent {
    kind: 'run' | 'planned';
    date: Date;
    taskId: number;
    taskName: string;
    scheduleId: number | null;
    cron?: string;
    run?: AutomTaskRun;
    status?: TaskStatus;
}

export interface CalendarProps extends PanelProps {
    anchor: Date;
    setAnchor: (date: Date) => void;
    view: CalView;
    setView: (view: CalView) => void;
}

function windowFor(view: CalView, anchor: Date): { start: Date; end: Date } {
    if (view === 'week') {
        const start = startOfWeek(anchor);
        return { start, end: addDays(start, 7) };
    }
    const firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    if (view === 'task') {
        return { start: firstOfMonth, end: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1) };
    }
    const start = startOfWeek(firstOfMonth);
    return { start, end: addDays(start, 42) };
}

export default function Calendar({ data, actions, labels, locale, colorOf, anchor, setAnchor, view, setView }: CalendarProps) {
    const [compact, setCompact] = useState(false);
    const [openDay, setOpenDay] = useState<Date | null>(null);

    const { start, end } = windowFor(view, anchor);

    const events = useMemo(() => {
        const taskName = new Map(data.tasks.map((t) => [t.idAutom_Task, t.Name]));
        const activeTaskIds = new Set(data.tasks.filter((t) => t.isActive === 1).map((t) => t.idAutom_Task));
        const out: CalEvent[] = [];

        for (const run of data.runs) {
            const date = new Date(run.StartedAt);
            if (date < start || date >= end) continue;
            out.push({
                kind: 'run',
                date,
                taskId: run.Autom_Task_id,
                taskName: run.TaskName ?? taskName.get(run.Autom_Task_id) ?? `#${run.Autom_Task_id}`,
                scheduleId: run.Autom_Schedule_id,
                run,
                status: run.Status,
            });
        }

        // Projection starts at now, never at the window start: replaying a cron
        // over days that already happened would draw "planned" beside the run it
        // actually produced, and over a day it did not fire it would claim a
        // future that is already past.
        const from = new Date(Math.max(start.getTime(), Date.now()));
        if (from < end) {
            for (const schedule of data.schedules) {
                if (schedule.isActive !== 1 || !activeTaskIds.has(schedule.Autom_Task_id)) continue;
                for (const date of expandCron(schedule.CronExpression, from, end, EXPAND_CAP)) {
                    out.push({
                        kind: 'planned',
                        date,
                        taskId: schedule.Autom_Task_id,
                        taskName: taskName.get(schedule.Autom_Task_id) ?? schedule.TaskName ?? `#${schedule.Autom_Task_id}`,
                        scheduleId: schedule.idAutom_Schedule,
                        cron: schedule.CronExpression,
                    });
                }
            }
        }

        return out.sort((a, b) => a.date.getTime() - b.date.getTime());
    }, [data.runs, data.schedules, data.tasks, start, end]);

    const byDay = useMemo(() => {
        const map = new Map<string, CalEvent[]>();
        for (const event of events) {
            const key = dayKey(event.date);
            const list = map.get(key);
            if (list) list.push(event);
            else map.set(key, [event]);
        }
        return map;
    }, [events]);

    const title = useMemo(() => {
        if (view === 'week') {
            const weekEnd = addDays(start, 6);
            const format = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
            return `${format.format(start)} – ${format.format(weekEnd)}`;
        }
        return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(anchor);
    }, [view, start, anchor, locale]);

    function shift(direction: -1 | 1) {
        if (view === 'week') return setAnchor(addDays(anchor, 7 * direction));
        setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1));
    }

    return (
        <>
            <div className="autom-cal-bar">
                <button type="button" className="autom-btn" onClick={() => shift(-1)} aria-label="←">
                    ‹
                </button>
                <button type="button" className="autom-btn" onClick={() => setAnchor(new Date())}>
                    {labels.today}
                </button>
                <button type="button" className="autom-btn" onClick={() => shift(1)} aria-label="→">
                    ›
                </button>
                <span className="autom-cal-title">{title}</span>

                <select className="autom-select" value={view} aria-label={labels.tabCalendar} onChange={(event) => setView(event.target.value as CalView)}>
                    <option value="month">{labels.month}</option>
                    <option value="week">{labels.week}</option>
                    <option value="task">{labels.byTask}</option>
                </select>

                {view === 'month' && (
                    <button type="button" className="autom-btn" onClick={() => setCompact((c) => !c)}>
                        {compact ? labels.detailed : labels.compact}
                    </button>
                )}
            </div>

            {view === 'month' && (
                <MonthView
                    start={start}
                    anchorMonth={anchor.getMonth()}
                    byDay={byDay}
                    locale={locale}
                    colorOf={colorOf}
                    compact={compact}
                    labels={labels}
                    onOpenDay={setOpenDay}
                />
            )}
            {view === 'week' && <WeekView start={start} byDay={byDay} locale={locale} colorOf={colorOf} onOpenDay={setOpenDay} />}
            {view === 'task' && <ByTaskView start={start} end={end} tasks={data.tasks} byDay={byDay} colorOf={colorOf} labels={labels} onOpenDay={setOpenDay} />}

            <div className="autom-legend">
                <span>
                    <span className="autom-dot" style={{ background: 'var(--autom-on-surface-muted)' }} /> {labels.past}
                </span>
                <span>
                    <span className="autom-cal-chip autom-cal-chip-planned" style={{ display: 'inline-block', padding: '0 0.4rem' }}>
                        {labels.planned}
                    </span>
                </span>
            </div>

            {openDay && (
                <DayModal
                    day={openDay}
                    events={byDay.get(dayKey(openDay)) ?? []}
                    labels={labels}
                    locale={locale}
                    colorOf={colorOf}
                    actions={actions}
                    onClose={() => setOpenDay(null)}
                />
            )}
        </>
    );
}

/** Several events of one task and one kind collapse into a single chip, carrying
 *  the worst status among them — otherwise a minutely task hides everything. */
function chipsFor(events: CalEvent[]): { key: string; kind: CalEvent['kind']; taskId: number; taskName: string; count: number; status?: TaskStatus }[] {
    const groups = new Map<string, CalEvent[]>();
    for (const event of events) {
        const key = `${event.kind}:${event.taskId}`;
        const list = groups.get(key);
        if (list) list.push(event);
        else groups.set(key, [event]);
    }
    return [...groups.entries()].map(([key, list]) => ({
        key,
        kind: list[0].kind,
        taskId: list[0].taskId,
        taskName: list[0].taskName,
        count: list.length,
        status: list[0].kind === 'run' ? worstStatus(list.map((e) => e.status!).filter(Boolean)) : undefined,
    }));
}

function MonthView({
    start,
    anchorMonth,
    byDay,
    locale,
    colorOf,
    compact,
    labels,
    onOpenDay,
}: {
    start: Date;
    anchorMonth: number;
    byDay: Map<string, CalEvent[]>;
    locale: string;
    colorOf: (id: number) => string;
    compact: boolean;
    labels: PanelProps['labels'];
    onOpenDay: (date: Date) => void;
}) {
    const dowFormat = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    const todayKey = dayKey(new Date());
    const max = compact ? CHIPS_PER_DAY_COMPACT : CHIPS_PER_DAY;

    return (
        <div className="autom-cal-grid">
            {Array.from({ length: 7 }, (_, i) => (
                <div key={`dow-${i}`} className="autom-cal-dow">
                    {dowFormat.format(addDays(start, i))}
                </div>
            ))}

            {Array.from({ length: 42 }, (_, i) => {
                const day = addDays(start, i);
                const key = dayKey(day);
                const events = byDay.get(key) ?? [];
                const chips = chipsFor(events);
                const outside = day.getMonth() !== anchorMonth;

                return (
                    <button
                        key={key}
                        type="button"
                        className={`autom-cal-day${outside ? ' autom-cal-day-out' : ''}${key === todayKey ? ' autom-cal-day-today' : ''}`}
                        onClick={() => onOpenDay(day)}
                    >
                        <span className="autom-cal-daynum">{day.getDate()}</span>
                        {chips.slice(0, max).map((chip) => (
                            <span key={chip.key} className={`autom-cal-chip${chip.kind === 'planned' ? ' autom-cal-chip-planned' : ''}`}>
                                <span
                                    className="autom-dot"
                                    style={{ background: colorOf(chip.taskId), width: '0.5rem', height: '0.5rem' }}
                                    aria-hidden="true"
                                />
                                {chip.taskName}
                                {chip.count > 1 && ` ×${chip.count}`}
                            </span>
                        ))}
                        {chips.length > max && (
                            <span className="autom-tiny autom-muted">
                                +{chips.length - max} {labels.more}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}

function WeekView({
    start,
    byDay,
    locale,
    colorOf,
    onOpenDay,
}: {
    start: Date;
    byDay: Map<string, CalEvent[]>;
    locale: string;
    colorOf: (id: number) => string;
    onOpenDay: (date: Date) => void;
}) {
    const dayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric' });

    const byDayHour = useMemo(() => {
        const map = new Map<string, CalEvent[]>();
        for (const [, events] of byDay) {
            for (const event of events) {
                const key = `${dayKey(event.date)}#${event.date.getHours()}`;
                const list = map.get(key);
                if (list) list.push(event);
                else map.set(key, [event]);
            }
        }
        return map;
    }, [byDay]);

    return (
        <div className="autom-week">
            <div className="autom-week-hour" />
            {Array.from({ length: 7 }, (_, d) => (
                <div key={`head-${d}`} className="autom-cal-dow">
                    {dayFormat.format(addDays(start, d))}
                </div>
            ))}

            {Array.from({ length: 24 }, (_, hour) => (
                <Row key={`h-${hour}`} hour={hour} start={start} byDayHour={byDayHour} colorOf={colorOf} onOpenDay={onOpenDay} />
            ))}
        </div>
    );
}

function Row({
    hour,
    start,
    byDayHour,
    colorOf,
    onOpenDay,
}: {
    hour: number;
    start: Date;
    byDayHour: Map<string, CalEvent[]>;
    colorOf: (id: number) => string;
    onOpenDay: (date: Date) => void;
}) {
    return (
        <>
            <div className="autom-week-hour">{String(hour).padStart(2, '0')}</div>
            {Array.from({ length: 7 }, (_, d) => {
                const day = addDays(start, d);
                const events = byDayHour.get(`${dayKey(day)}#${hour}`) ?? [];
                return (
                    <div key={`${d}-${hour}`} className="autom-week-cell" onClick={() => events.length && onOpenDay(day)}>
                        {events.map((event, i) => (
                            <span
                                key={`${event.kind}-${event.taskId}-${i}`}
                                className="autom-dot"
                                style={{
                                    background: event.kind === 'planned' ? 'transparent' : colorOf(event.taskId),
                                    border: event.kind === 'planned' ? `1px dashed ${colorOf(event.taskId)}` : undefined,
                                }}
                                title={`${event.taskName} ${hhmm(event.date)}`}
                            />
                        ))}
                    </div>
                );
            })}
        </>
    );
}

function ByTaskView({
    start,
    end,
    tasks,
    byDay,
    colorOf,
    labels,
    onOpenDay,
}: {
    start: Date;
    end: Date;
    tasks: PanelProps['data']['tasks'];
    byDay: Map<string, CalEvent[]>;
    colorOf: (id: number) => string;
    labels: PanelProps['labels'];
    onOpenDay: (date: Date) => void;
}) {
    const days = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));

    if (tasks.length === 0) return <Note>{labels.noTasks}</Note>;

    return (
        <div className="autom-bytask" style={{ gridTemplateColumns: `minmax(8rem, auto) repeat(${days}, minmax(1.1rem, 1fr))` }}>
            <div className="autom-bytask-name" />
            {Array.from({ length: days }, (_, i) => (
                <div key={`d-${i}`} className="autom-cal-dow">
                    {addDays(start, i).getDate()}
                </div>
            ))}

            {tasks.map((task) => (
                <Fragmentish key={task.idAutom_Task}>
                    <div className="autom-bytask-name">
                        <TaskDot color={colorOf(task.idAutom_Task)} /> {task.Name}
                    </div>
                    {Array.from({ length: days }, (_, i) => {
                        const day = addDays(start, i);
                        const events = (byDay.get(dayKey(day)) ?? []).filter((e) => e.taskId === task.idAutom_Task);
                        const runs = events.filter((e) => e.kind === 'run');
                        const status = runs.length ? worstStatus(runs.map((e) => e.status!).filter(Boolean)) : null;
                        const planned = events.some((e) => e.kind === 'planned');

                        return (
                            <div key={`${task.idAutom_Task}-${i}`} className="autom-bytask-cell" onClick={() => events.length && onOpenDay(day)}>
                                {status ? (
                                    <span
                                        className="autom-dot"
                                        style={{
                                            background:
                                                status === 'completed'
                                                    ? 'var(--autom-success)'
                                                    : status === 'running'
                                                      ? 'var(--autom-info)'
                                                      : status === 'pending'
                                                        ? 'var(--autom-warning)'
                                                        : 'var(--autom-danger)',
                                        }}
                                        title={status}
                                    />
                                ) : planned ? (
                                    <span className="autom-dot" style={{ background: 'transparent', border: `1px dashed ${colorOf(task.idAutom_Task)}` }} />
                                ) : null}
                            </div>
                        );
                    })}
                </Fragmentish>
            ))}
        </div>
    );
}

/** The grid needs the cells as direct children, so a task's row cannot be wrapped
 *  in an element — only in a fragment. */
function Fragmentish({ children }: { children: ReactNode }) {
    return <>{children}</>;
}

function DayModal({
    day,
    events,
    labels,
    locale,
    colorOf,
    actions,
    onClose,
}: {
    day: Date;
    events: CalEvent[];
    labels: PanelProps['labels'];
    locale: string;
    colorOf: (id: number) => string;
    actions: PanelProps['actions'];
    onClose: () => void;
}) {
    const title = `${labels.dayDetail} · ${new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(day)}`;

    return (
        <Modal title={title} labels={labels} onClose={onClose}>
            {events.length === 0 ? (
                <Note>{labels.noRuns}</Note>
            ) : (
                events.map((event, i) => (
                    <div key={`${event.kind}-${i}`} className="autom-sched">
                        <TaskDot color={colorOf(event.taskId)} />
                        <span className="autom-mono">{hhmm(event.date)}</span>
                        <span className="autom-sched-grow">{event.taskName}</span>

                        {event.kind === 'run' && event.run ? (
                            <>
                                <StatusChip status={event.run.Status} />
                                <span className="autom-tiny autom-muted">{formatDuration(runDurationMs(event.run))}</span>
                                <button type="button" className="autom-btn autom-btn-ghost" onClick={() => actions.showRun(event.run!)}>
                                    {labels.view}
                                </button>
                            </>
                        ) : (
                            <>
                                <span className="autom-chip">{labels.planned}</span>
                                <code className="autom-tiny autom-mono autom-muted">{event.cron}</code>
                                <button type="button" className="autom-btn autom-btn-ghost" onClick={() => actions.triggerTask(event.taskId)}>
                                    ▶ {labels.run}
                                </button>
                            </>
                        )}
                    </div>
                ))
            )}
        </Modal>
    );
}
