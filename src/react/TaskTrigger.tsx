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
 * click until the run ends; on mount it adopts a run of the same task already in
 * progress (another tab, another person, a reloaded page); and the runner itself
 * answers 409 to a trigger for a task that is running, which is what holds when
 * two of those happen in the same instant.
 *
 * It polls /runs/active rather than listening to /runs/events. Each instance
 * would hold a stream of its own, and a browser allows six connections per
 * origin over HTTP/1.1: a page with six of these would stop loading anything
 * else. Polling also goes through `fetcher`, which an EventSource cannot. It
 * only polls while it follows a run; an idle instance makes no request.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunProgress, TaskStatus } from '../types.js';
import { createClient, type Fetcher } from './client.js';
import { LABELS, type Lang } from './i18n.js';
import { injectAutomationStyles } from './styles.js';
import { ProgressBar, StatusChip } from './ui.js';

const POLL_MS = 1_000;

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

type State =
    | { phase: 'idle' }
    | { phase: 'starting' }
    | { phase: 'running'; runId: number; progress: RunProgress | null }
    | { phase: 'done'; status: TaskStatus; text: string | null }
    | { phase: 'error'; message: string };

export default function TaskTrigger({ apiBase, name, label, fetcher, lang = 'en' }: TaskTriggerProps) {
    const labels = LABELS[lang];
    const client = useMemo(() => createClient(apiBase, fetcher), [apiBase, fetcher]);
    const [state, setState] = useState<State>({ phase: 'idle' });

    injectAutomationStyles();

    // `disabled` only lands on the next render, and two clicks can arrive before
    // it does. This is what the second one meets.
    const inFlight = useRef(false);

    /** Follows a run of this task already in progress, if there is one. */
    const adopt = useCallback(async () => {
        const run = (await client.activeRuns()).memory.find((r) => r.taskName === name);
        if (!run) return false;
        inFlight.current = true;
        setState({ phase: 'running', runId: run.runId, progress: run.progress });
        return true;
    }, [client, name]);

    useEffect(() => {
        adopt().catch(() => {
            // Runner unreachable: the button stays usable and a click reports it.
        });
    }, [adopt]);

    const start = async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        setState({ phase: 'starting' });
        try {
            const { runId } = await client.triggerTaskByName(name);
            setState({ phase: 'running', runId, progress: null });
        } catch (err) {
            // Most often a 409 because the task is already running: follow that
            // run rather than report it.
            if (await adopt().catch(() => false)) return;
            inFlight.current = false;
            setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
        }
    };

    const runId = state.phase === 'running' ? state.runId : null;

    useEffect(() => {
        if (runId === null) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;

        const tick = async () => {
            try {
                const live = (await client.activeRuns()).memory.find((r) => r.runId === runId);
                if (stopped) return;
                if (live) {
                    setState({ phase: 'running', runId, progress: live.progress });
                } else {
                    // Gone from memory means settled: the executor writes the row's
                    // final status before it drops the run.
                    const row = await client.run(runId);
                    if (stopped) return;
                    inFlight.current = false;
                    setState({ phase: 'done', status: row.Status, text: row.Status === 'completed' ? row.Output : row.ErrorMessage });
                    return;
                }
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
    }, [client, runId]);

    const busy = state.phase === 'starting' || state.phase === 'running';
    const progress = state.phase === 'running' ? state.progress : null;

    return (
        <div className="autom-root autom-trigger">
            <button type="button" className="autom-btn autom-btn-primary" disabled={busy} onClick={start}>
                ▶ {busy ? labels.running : (label ?? labels.run)}
            </button>

            {busy && (
                <>
                    <ProgressBar percent={progress?.percent ?? null} label={labels.progress} />
                    {(progress?.step || progress?.percent != null) && (
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
                    <StatusChip status={state.status} />
                    {state.text && <pre className="autom-pre">{state.text}</pre>}
                </>
            )}

            {state.phase === 'error' && <p className="autom-note autom-note-error">{state.message}</p>}
        </div>
    );
}
