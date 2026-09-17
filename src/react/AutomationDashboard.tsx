/**
 * AutomationDashboard.tsx
 * The whole management surface, as one component.
 *
 *     <AutomationDashboard apiBase="/admin/api/automations" lang="fr" />
 *
 * It talks to one endpoint prefix — wherever the host mounted the proxy — and
 * expects that mount to be the thing enforcing who may call it. The component
 * itself assumes nothing about sessions; a host with its own fetch wrapper
 * (redirects on 401, version checks, credentials) passes it as `fetcher`.
 *
 * All four panels read one loaded window of runs rather than querying per view.
 * The runner has no aggregate endpoint, so a per-panel fetch would be the same
 * rows three times, and the calendar would disagree with the table it sits next
 * to whenever a run landed between two requests.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { expandCron, isValidCron } from '../cron.js';
import type { AutomSchedule, AutomTaskRun, TaskStatus } from '../types.js';
import Calendar, { type CalView } from './calendar.js';
import { createClient, type ActiveRunMemory, type AutomationClient, type Fetcher } from './client.js';
import History from './history.js';
import { LABELS, type Lang } from './i18n.js';
import Overview from './overview.js';
import { hhmm, taskColor } from './format.js';
import { busyKey, type DashboardActions, type DashboardData } from './shared.js';
import { injectAutomationStyles } from './styles.js';
import Tasks from './tasks.js';
import { ErrorState, Modal, Skeletons } from './ui.js';

/** How many runs the dashboard holds at once. Large enough for a month of
 *  calendar and a useful history, small enough to stay one quick request. */
const RUNS_WINDOW = 500;
const POLL_ACTIVE_MS = 8_000;
/** The fallback cadence while something is actually running. Only reached when
 *  the event stream is unavailable — see useRunStream. */
const POLL_RUNNING_MS = 1_500;
/** The reconciliation reload, when the stream is down and it is the only thing
 *  refreshing the run window. */
const POLL_ALL_MS = 60_000;
/**
 * The same reload while the stream is up, where it is a safety net rather than
 * the mechanism: the stream already reports everything the runner does, so what
 * is left to catch is a change no event can describe — a direct UPDATE in MySQL.
 *
 * Five minutes is not arbitrary. It is the TTL of the Redis active flag, so it
 * is the cadence at which the runner itself notices such a write. A dashboard
 * refreshing faster than the engine it watches would only display a change the
 * engine has not acted on yet.
 */
const POLL_ALL_STREAMING_MS = 5 * 60_000;
/** Log lines kept per run in the browser. Matches the runner's own ring, so the
 *  stream and a fresh /runs/active agree on what there is to show. */
const LOG_WINDOW = 200;
/** Coalescing window for stream-triggered reloads. Five crons firing on the same
 *  minute are five `start` events and one reload. */
const RESYNC_DEBOUNCE_MS = 400;
/** EventSource reconnects on its own, so one error is a reconnection, not a
 *  fault. Two in a row without an open in between is an outage. */
const STREAM_GIVE_UP = 2;

export interface AutomationDashboardProps {
    /** Where the host mounted the automation proxy, without a trailing slash —
     *  for example '/admin/api/automations'. */
    apiBase: string;
    /** Replacement for window.fetch. A host that handles sessions, redirects or
     *  deploy detection should pass its own wrapper. */
    fetcher?: Fetcher;
    /** Language of the interface. Default 'en'. */
    lang?: Lang;
    /** BCP-47 tag for dates and numbers. Defaults to the language. */
    locale?: string;
}

export default function AutomationDashboard({ apiBase, fetcher, lang = 'en', locale }: AutomationDashboardProps) {
    const labels = LABELS[lang];
    const resolvedLocale = locale ?? lang;
    const client = useMemo(() => createClient(apiBase, fetcher), [apiBase, fetcher]);

    injectAutomationStyles();

    const [data, setData] = useState<DashboardData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

    const [tab, setTab] = useState<'overview' | 'calendar' | 'tasks' | 'history'>('overview');
    const [anchor, setAnchor] = useState(() => new Date());
    const [calView, setCalView] = useState<CalView>('month');
    const [taskFilter, setTaskFilter] = useState<number | ''>('');
    const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>('');

    const [runModal, setRunModal] = useState<AutomTaskRun | null>(null);
    const [scheduleModal, setScheduleModal] = useState<{ taskId: number; schedule?: AutomSchedule } | null>(null);

    // Guards against a slow response from a previous mount overwriting a newer
    // one, and against setState after unmount during polling.
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const loadAll = useCallback(async () => {
        try {
            const [tasks, schedules, runs, active] = await Promise.all([
                client.tasks(),
                client.schedules(),
                client.runs({ limit: RUNS_WINDOW }),
                client.activeRuns(),
            ]);
            if (!alive.current) return;
            setData({ tasks, schedules, runs, active });
            setError(null);
        } catch (err) {
            if (!alive.current) return;
            setError(err instanceof Error ? err.message : labels.loadError);
        }
    }, [client, labels.loadError]);

    /** The cheap poll: what is running, and the task rows whose isActive may have
     *  changed underneath us. Deliberately does not touch the run window. */
    const loadLive = useCallback(async () => {
        try {
            const [active, tasks] = await Promise.all([client.activeRuns(), client.tasks()]);
            if (!alive.current) return;
            setData((current) => (current ? { ...current, active, tasks } : current));
        } catch {
            // A failed poll is not worth replacing a rendered dashboard with an
            // error; the next full reload will surface a lasting outage.
        }
    }, [client]);

    useEffect(() => {
        loadAll();
    }, [loadAll]);

    // The stream, and the polling it replaces. Two effects, not one: the live
    // cadence changes whenever a run starts, and re-creating a shared effect for
    // that would keep restarting the reconciliation reload, which would then
    // never fire.
    const streaming = useRunStream(apiBase, setData, loadAll);
    const hasRunning = (data?.active.memory.length ?? 0) > 0;

    useEffect(() => {
        if (streaming) return; // the stream already says everything this poll would ask for
        const live = setInterval(loadLive, hasRunning ? POLL_RUNNING_MS : POLL_ACTIVE_MS);
        return () => clearInterval(live);
    }, [loadLive, streaming, hasRunning]);

    useEffect(() => {
        const all = setInterval(loadAll, streaming ? POLL_ALL_STREAMING_MS : POLL_ALL_MS);
        return () => clearInterval(all);
    }, [loadAll, streaming]);

    /** Runs one mutation, keeps its target disabled meanwhile, and reloads rather
     *  than patching local state — the runner is the authority on what happened,
     *  and a trigger changes rows this component did not send. */
    const mutate = useCallback(
        async (key: string, action: () => Promise<unknown>) => {
            setBusy((current) => new Set(current).add(key));
            try {
                await action();
                await loadAll();
            } catch (err) {
                if (alive.current) setError(err instanceof Error ? err.message : labels.loadError);
            } finally {
                if (alive.current) {
                    setBusy((current) => {
                        const next = new Set(current);
                        next.delete(key);
                        return next;
                    });
                }
            }
        },
        [loadAll, labels.loadError],
    );

    const actions = useMemo<DashboardActions>(
        () => ({
            triggerTask: (taskId) => mutate(busyKey.task(taskId), () => client.triggerTask(taskId)),
            toggleTask: (task) => mutate(busyKey.task(task.idAutom_Task), () => client.setTaskActive(task.idAutom_Task, task.isActive !== 1)),
            editSchedule: (taskId, schedule) => setScheduleModal({ taskId, schedule }),
            toggleSchedule: (schedule) =>
                mutate(busyKey.schedule(schedule.idAutom_Schedule), () =>
                    client.updateSchedule(schedule.idAutom_Schedule, { isActive: schedule.isActive === 1 ? 0 : 1 }),
                ),
            deleteSchedule: (schedule) => {
                if (!window.confirm(labels.confirmDeleteSchedule)) return;
                mutate(busyKey.schedule(schedule.idAutom_Schedule), () => client.deleteSchedule(schedule.idAutom_Schedule));
            },
            showRun: setRunModal,
            showTaskHistory: (taskId) => {
                setTaskFilter(taskId);
                setStatusFilter('');
                setTab('history');
            },
            goToCalendar: (date) => {
                setAnchor(date);
                setCalView('week');
                setTab('calendar');
            },
        }),
        [client, mutate, labels.confirmDeleteSchedule],
    );

    const colorOf = useCallback(
        (taskId: number) => {
            const index = data?.tasks.findIndex((t) => t.idAutom_Task === taskId) ?? -1;
            return taskColor(taskId, index < 0 ? taskId : index);
        },
        [data?.tasks],
    );

    if (error && !data) {
        return (
            <div className="autom-root">
                <ErrorState message={error} labels={labels} onRetry={loadAll} />
            </div>
        );
    }

    if (!data) {
        return (
            <div className="autom-root">
                <Skeletons count={4} />
            </div>
        );
    }

    const panelProps = { data, actions, labels, locale: resolvedLocale, colorOf, busy };
    const runningCount = data.active.db.length;

    const TABS = [
        { id: 'overview', label: labels.tabOverview },
        { id: 'calendar', label: labels.tabCalendar },
        { id: 'tasks', label: labels.tabTasks },
        { id: 'history', label: labels.tabHistory },
    ] as const;

    return (
        <div className="autom-root">
            {error && (
                <p className="autom-note autom-note-error" style={{ marginBottom: '0.75rem' }}>
                    {error}
                </p>
            )}

            <div className="autom-tabs" role="tablist">
                {TABS.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === entry.id}
                        className="autom-tab"
                        onClick={() => setTab(entry.id)}
                    >
                        {entry.label}
                        {entry.id === 'overview' && runningCount > 0 && <span className="autom-tab-badge">{runningCount}</span>}
                    </button>
                ))}
            </div>

            {tab === 'overview' && <Overview {...panelProps} />}
            {tab === 'calendar' && <Calendar {...panelProps} anchor={anchor} setAnchor={setAnchor} view={calView} setView={setCalView} />}
            {tab === 'tasks' && <Tasks {...panelProps} />}
            {tab === 'history' && (
                <History
                    {...panelProps}
                    taskFilter={taskFilter}
                    setTaskFilter={setTaskFilter}
                    statusFilter={statusFilter}
                    setStatusFilter={setStatusFilter}
                    windowFull={data.runs.length >= RUNS_WINDOW}
                    onRefresh={loadAll}
                />
            )}

            {runModal && <RunModal run={runModal} client={client} labels={labels} onClose={() => setRunModal(null)} />}

            {scheduleModal && (
                <ScheduleModal
                    taskId={scheduleModal.taskId}
                    schedule={scheduleModal.schedule}
                    labels={labels}
                    locale={resolvedLocale}
                    onClose={() => setScheduleModal(null)}
                    onSave={async (cronExpression, isActive) => {
                        const existing = scheduleModal.schedule;
                        const key = existing ? busyKey.schedule(existing.idAutom_Schedule) : busyKey.task(scheduleModal.taskId);
                        setScheduleModal(null);
                        await mutate(key, () =>
                            existing
                                ? client.updateSchedule(existing.idAutom_Schedule, { CronExpression: cronExpression, isActive: isActive ? 1 : 0 })
                                : client.createSchedule(scheduleModal.taskId, cronExpression, isActive),
                        );
                    }}
                />
            )}
        </div>
    );
}

/**
 * The loaded window carries only a preview of `Output`, so this is where the
 * whole column is fetched. The row it was opened with renders straight away and
 * is replaced when the full one lands — a modal that opened empty and filled a
 * moment later would read as a bug on the common case, where the preview already
 * holds everything there is.
 */
function RunModal({ run, client, labels, onClose }: { run: AutomTaskRun; client: AutomationClient; labels: typeof LABELS.en; onClose: () => void }) {
    const [full, setFull] = useState(run);
    const runId = run.idAutom_Task_Run;

    useEffect(() => {
        let current = true;
        client
            .run(runId)
            .then((fetched) => {
                if (current) setFull(fetched);
            })
            .catch(() => {
                // Keep showing the preview. The runner being unreachable is already
                // surfaced by the panels behind this modal.
            });
        return () => {
            current = false;
        };
    }, [client, runId]);

    const isError = Boolean(full.ErrorMessage);
    return (
        <Modal title={isError ? labels.errorTitle : labels.outputTitle} labels={labels} onClose={onClose}>
            <pre className="autom-pre">{full.ErrorMessage ?? full.Output ?? '—'}</pre>
            {isError && full.Output && (
                <>
                    <p className="autom-field-label" style={{ marginTop: '0.75rem' }}>
                        {labels.outputTitle}
                    </p>
                    <pre className="autom-pre">{full.Output}</pre>
                </>
            )}
        </Modal>
    );
}

function ScheduleModal({
    schedule,
    labels,
    locale,
    onClose,
    onSave,
}: {
    taskId: number;
    schedule?: AutomSchedule;
    labels: typeof LABELS.en;
    locale: string;
    onClose: () => void;
    onSave: (cronExpression: string, isActive: boolean) => void;
}) {
    const [expression, setExpression] = useState(schedule?.CronExpression ?? '0 3 * * *');
    const [active, setActive] = useState(schedule ? schedule.isActive === 1 : true);

    const valid = isValidCron(expression.trim());
    const upcoming = useMemo(() => {
        if (!valid) return [];
        const from = new Date(Date.now() + 60_000);
        const to = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);
        const format = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
        // The same parser the server validates writes with, so the preview
        // cannot promise a firing the runner would refuse.
        return expandCron(expression.trim(), from, to, 4).map((date) => `${format.format(date)} ${hhmm(date)}`);
    }, [expression, valid, locale]);

    return (
        <Modal
            title={schedule ? labels.editSchedule : labels.newSchedule}
            labels={labels}
            onClose={onClose}
            footer={
                <>
                    <button type="button" className="autom-btn" onClick={onClose}>
                        {labels.cancel}
                    </button>
                    <button type="button" className="autom-btn autom-btn-primary" disabled={!valid} onClick={() => onSave(expression.trim(), active)}>
                        {labels.save}
                    </button>
                </>
            }
        >
            <label className="autom-field">
                <span className="autom-field-label">{labels.cronExpression}</span>
                <input
                    className={`autom-input autom-mono${valid ? '' : ' autom-input-invalid'}`}
                    style={{ width: '100%' }}
                    value={expression}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setExpression(event.target.value)}
                />
                <span className="autom-tiny autom-muted">minute hour day-of-month month day-of-week</span>
            </label>

            {!valid && <p className="autom-note autom-note-error">{labels.invalidExpression}</p>}

            {valid && (
                <div className="autom-field">
                    <span className="autom-field-label">{labels.nextOccurrences}</span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                        {upcoming.map((entry) => (
                            <span key={entry} className="autom-chip">
                                {entry}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
                {labels.activeImmediately}
            </label>
        </Modal>
    );
}

/**
 * The live stream, with the polling fallback it depends on.
 *
 * Returns whether the stream is currently carrying events. False means the
 * caller must poll — either because the browser has no EventSource, because the
 * host's authentication rejected the connection, or because the runner is
 * unreachable. Polling is not a nicety here: EventSource cannot carry a custom
 * header, so the `fetcher` prop does not apply to it, and a host authenticating
 * with an Authorization header will only ever see 401 on this route.
 *
 * `progress` and `log` are applied in place, with no request at all. The three
 * events that change rows the stream does not carry — `start` and `end`, which
 * add and settle run rows, and `snapshot`, which arrives on every reconnection —
 * each trigger one reload instead.
 *
 * That reload on `snapshot` is what keeps an incrementally-maintained state
 * honest. EventSource reconnects silently, and the events emitted while it was
 * away are gone: without a resynchronisation at exactly that moment, a laptop
 * waking from sleep would show a stale dashboard with nothing to say so.
 */
function useRunStream(apiBase: string, setData: Dispatch<SetStateAction<DashboardData | null>>, resync: () => void): boolean {
    const [streaming, setStreaming] = useState(false);

    useEffect(() => {
        if (typeof EventSource === 'undefined') return; // server-side render, or an old browser

        let failures = 0;
        const source = new EventSource(`${apiBase.replace(/\/+$/, '')}/runs/events`, { withCredentials: true });

        let resyncTimer: ReturnType<typeof setTimeout> | null = null;
        const resyncSoon = () => {
            if (resyncTimer) clearTimeout(resyncTimer);
            resyncTimer = setTimeout(() => {
                resyncTimer = null;
                resync();
            }, RESYNC_DEBOUNCE_MS);
        };

        const patch = (runId: number, change: (run: ActiveRunMemory) => ActiveRunMemory) =>
            setData((current) =>
                current
                    ? {
                          ...current,
                          active: { ...current.active, memory: current.active.memory.map((run) => (run.runId === runId ? change(run) : run)) },
                      }
                    : current,
            );

        const on = (event: string, handle: (payload: any) => void) => {
            const listener = (message: MessageEvent) => {
                try {
                    handle(JSON.parse(message.data));
                } catch {
                    // One malformed frame is not worth tearing the stream down for.
                }
            };
            source.addEventListener(event, listener);
            return () => source.removeEventListener(event, listener);
        };

        // The first snapshot arrives beside the mount's own load, which covers the
        // same ground. Every later one is a reconnection, and those are the ones
        // that have events to make up for.
        let reconnected = false;

        const detach = [
            on('snapshot', (memory: ActiveRunMemory[]) => {
                setData((current) => (current ? { ...current, active: { ...current.active, memory } } : current));
                if (reconnected) resyncSoon();
                reconnected = true;
            }),
            on('start', resyncSoon),
            on('end', resyncSoon),
            on('progress', (event) =>
                patch(event.runId, (run) => ({
                    ...run,
                    progress: { ...run.progress, percent: event.percent, step: event.step, current: event.current, total: event.total },
                })),
            ),
            on('log', (event) =>
                patch(event.runId, (run) => ({ ...run, progress: { ...run.progress, logs: [...run.progress.logs, event.line].slice(-LOG_WINDOW) } })),
            ),
        ];

        source.onopen = () => {
            failures = 0;
            setStreaming(true);
        };
        source.onerror = () => {
            setStreaming(false);
            if (++failures < STREAM_GIVE_UP) return; // EventSource is reconnecting by itself
            source.close();
        };

        return () => {
            if (resyncTimer) clearTimeout(resyncTimer);
            for (const off of detach) off();
            source.close();
            setStreaming(false);
        };
    }, [apiBase, setData, resync]);

    return streaming;
}
