/**
 * TaskTrigger.tsx
 * One button that starts a task by name, then shows where it has got to.
 *
 *     <TaskTrigger apiBase="/admin/api/automations" name="importRecettes" lang="fr" />
 *
 * For the host's own pages, beside whatever a task produces, where the whole
 * dashboard would be too much. Several can share a page.
 *
 * A task cannot be started twice through it. The button is disabled from the
 * click until the run ends; it adopts a run of the same task started elsewhere
 * (another tab, another person, a reloaded page); and the runner itself answers
 * 409 to a trigger for a task that is running, which is what holds when two of
 * those happen in the same instant.
 *
 * Progress arrives over GET /runs/events. Every instance on a page shares one
 * EventSource per apiBase: one each would soon use up the six connections a
 * browser allows per origin over HTTP/1.1, and the page would stop loading
 * anything else. When the stream cannot open — an EventSource carries no custom
 * header, so a host authenticating with one only ever gets 401 there — the
 * instance following a run polls /runs/active instead, through `fetcher`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskStatus } from '../types.js';
import { createClient, type ActiveRunMemory, type Fetcher } from './client.js';
import { LABELS, type Lang } from './i18n.js';
import { injectAutomationStyles } from './styles.js';
import { ProgressBar, StatusChip } from './ui.js';

/** Fallback cadence, only while the stream is down and a run is followed. */
const POLL_MS = 1_500;
/** EventSource reconnects on its own, so one error is a reconnection, not a
 *  fault. Two in a row without an open in between is an outage. */
const STREAM_GIVE_UP = 2;

// ─── One event stream per page ────────────────────────────────────────────────

interface StreamListener {
    event: (type: string, data: any) => void;
    status: (open: boolean) => void;
}

interface SharedStream {
    source: EventSource;
    listeners: Set<StreamListener>;
    open: boolean;
}

const streams = new Map<string, SharedStream>();

/** Joins the page's stream for this apiBase, opening it for the first listener
 *  and closing it after the last. A stream that gave up stays closed until then:
 *  its listeners poll meanwhile. */
function subscribe(apiBase: string, listener: StreamListener): () => void {
    const url = `${apiBase.replace(/\/+$/, '')}/runs/events`;
    let shared = streams.get(url);

    if (!shared) {
        const created: SharedStream = { source: new EventSource(url, { withCredentials: true }), listeners: new Set(), open: false };
        let failures = 0;

        for (const type of ['snapshot', 'start', 'progress', 'end']) {
            created.source.addEventListener(type, (message) => {
                let data: unknown;
                try {
                    data = JSON.parse((message as MessageEvent).data);
                } catch {
                    return; // one malformed frame is not worth tearing the stream down for
                }
                for (const l of created.listeners) l.event(type, data);
            });
        }
        created.source.onopen = () => {
            failures = 0;
            created.open = true;
            for (const l of created.listeners) l.status(true);
        };
        created.source.onerror = () => {
            created.open = false;
            for (const l of created.listeners) l.status(false);
            if (++failures >= STREAM_GIVE_UP) created.source.close();
        };

        streams.set(url, created);
        shared = created;
    }

    const joined = shared;
    joined.listeners.add(listener);
    listener.status(joined.open);

    return () => {
        joined.listeners.delete(listener);
        if (joined.listeners.size > 0) return;
        joined.source.close();
        streams.delete(url);
    };
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface TaskTriggerProps {
    /** Where the host mounted the automation proxy — see AutomationDashboard. */
    apiBase: string;
    /** Autom_Task.Name of the task to start. The run is recorded as triggered by 'api'. */
    name: string;
    /** Button text. Defaults to the dashboard's "Run". */
    label?: string;
    fetcher?: Fetcher;
    /** Default 'en'. */
    lang?: Lang;
}

interface Shown {
    percent: number | null;
    step: string | null;
}

type State =
    | { phase: 'idle' }
    | { phase: 'starting' }
    | { phase: 'running'; runId: number; progress: Shown }
    | { phase: 'done'; status: TaskStatus; text: string | null }
    | { phase: 'error'; message: string };

const NOTHING_YET: Shown = { percent: null, step: null };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function TaskTrigger({ apiBase, name, label, fetcher, lang = 'en' }: TaskTriggerProps) {
    const labels = LABELS[lang];
    const client = useMemo(() => createClient(apiBase, fetcher), [apiBase, fetcher]);
    const [state, setState] = useState<State>({ phase: 'idle' });
    const [streaming, setStreaming] = useState(false);

    injectAutomationStyles();

    // `disabled` only lands on the next render, and two clicks can arrive before
    // it does. This is what the second one meets.
    const inFlight = useRef(false);
    // The run shown, for the stream handlers: they are registered once and would
    // otherwise read the state of the render that registered them.
    const followed = useRef<number | null>(null);

    const follow = useCallback((runId: number, progress: Shown) => {
        inFlight.current = true;
        followed.current = runId;
        setState({ phase: 'running', runId, progress });
    }, []);

    /** Reads the settled row. Both the `end` event and the fallback poll call it;
     *  whichever comes second finds the run already let go. */
    const finish = useCallback(
        async (runId: number) => {
            if (followed.current !== runId) return;
            followed.current = null;
            try {
                // The executor writes the row's final status before it emits `end`
                // and before it drops the run from /runs/active.
                const row = await client.run(runId);
                setState({ phase: 'done', status: row.Status, text: row.Status === 'completed' ? row.Output : row.ErrorMessage });
            } catch (err) {
                setState({ phase: 'error', message: message(err) });
            }
            inFlight.current = false;
        },
        [client],
    );

    /** Follows a run of this task already in progress, if there is one. */
    const adopt = useCallback(async () => {
        const run = (await client.activeRuns()).memory.find((r) => r.taskName === name);
        if (!run) return false;
        if (followed.current !== run.runId) follow(run.runId, run.progress);
        return true;
    }, [client, name, follow]);

    // On mount rather than from the stream's snapshot: an instance mounting after
    // the page's stream opened gets no snapshot of its own.
    useEffect(() => {
        adopt().catch(() => {
            // Runner unreachable: the button stays usable and a click reports it.
        });
    }, [adopt]);

    useEffect(() => {
        if (typeof EventSource === 'undefined') return; // server-side render

        return subscribe(apiBase, {
            status: setStreaming,
            event: (type, data) => {
                if (type === 'start') {
                    if (data.taskName === name && followed.current === null) follow(data.runId, NOTHING_YET);
                } else if (type === 'progress') {
                    if (data.runId !== followed.current) return;
                    setState((s) => (s.phase === 'running' && s.runId === data.runId ? { ...s, progress: { percent: data.percent, step: data.step } } : s));
                } else if (type === 'end') {
                    finish(data.runId);
                } else if (type === 'snapshot') {
                    // Sent on every (re)connection, and what was emitted while the
                    // stream was away is lost: the followed run may have ended.
                    const memory = data as ActiveRunMemory[];
                    const current = followed.current;
                    if (current !== null && !memory.some((r) => r.runId === current)) finish(current);
                    if (current === null) {
                        const run = memory.find((r) => r.taskName === name);
                        if (run) follow(run.runId, run.progress);
                    }
                }
            },
        });
    }, [apiBase, name, follow, finish]);

    const start = async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        setState({ phase: 'starting' });
        try {
            const { runId } = await client.triggerTaskByName(name);
            // The `start` event may have got here first.
            if (Number.isInteger(runId)) {
                if (followed.current !== runId) follow(runId, NOTHING_YET);
                return;
            }
            // A runner older than this component answers without a runId.
            if (followed.current !== null || (await adopt())) return;
            throw new Error(labels.runnerOutdated);
        } catch (err) {
            // Most often a 409 because the task is already running: follow that
            // run rather than report it.
            if (followed.current !== null || (await adopt().catch(() => false))) return;
            inFlight.current = false;
            setState({ phase: 'error', message: message(err) });
        }
    };

    const runId = state.phase === 'running' ? state.runId : null;

    // The fallback, while the stream is down.
    useEffect(() => {
        if (runId === null || streaming) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;

        const tick = async () => {
            try {
                const live = (await client.activeRuns()).memory.find((r) => r.runId === runId);
                if (stopped) return;
                if (!live) return void finish(runId);
                setState((s) => (s.phase === 'running' && s.runId === runId ? { ...s, progress: live.progress } : s));
            } catch {
                // A missed poll is not a failed run; the next one decides.
            }
            if (!stopped) timer = setTimeout(tick, POLL_MS);
        };

        timer = setTimeout(tick, POLL_MS);
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [client, runId, streaming, finish]);

    const busy = state.phase === 'starting' || state.phase === 'running';
    const progress = state.phase === 'running' ? state.progress : NOTHING_YET;

    // Only offered once a run has settled: the run is let go of by then, so
    // idle holds nothing the stream could still be updating.
    const close = (
        <button type="button" className="autom-btn autom-btn-ghost" onClick={() => setState({ phase: 'idle' })} aria-label={labels.close} title={labels.close}>
            ✕
        </button>
    );

    return (
        <div className="autom-root autom-trigger">
            <button type="button" className="autom-btn autom-btn-primary" disabled={busy} onClick={start}>
                ▶ {busy ? labels.running : (label ?? labels.run)}
            </button>

            {busy && (
                <>
                    <ProgressBar percent={progress.percent} label={labels.progress} />
                    {(progress.step || progress.percent != null) && (
                        <p className="autom-trigger-step">
                            {progress.percent != null && `${Math.round(progress.percent)} %`}
                            {progress.percent != null && progress.step && ' — '}
                            {progress.step}
                        </p>
                    )}
                </>
            )}

            {state.phase === 'done' && (
                <>
                    <div className="autom-trigger-head">
                        <StatusChip status={state.status} />
                        {close}
                    </div>
                    {state.text && <pre className="autom-pre">{state.text}</pre>}
                </>
            )}

            {state.phase === 'error' && (
                <div className="autom-trigger-head">
                    <p className="autom-note autom-note-error">{state.message}</p>
                    {close}
                </div>
            )}
        </div>
    );
}
