/**
 * filters.tsx
 * Which tasks and which trigger sources the whole dashboard shows.
 *
 * The state holds what is hidden rather than what is shown, so a task created
 * after the page loaded appears without anyone having to tick it. The filtering
 * itself happens once, in AutomationDashboard, before any panel sees the data —
 * a panel never has to know a filter exists.
 *
 * The hidden tasks survive a reload: they are kept in localStorage, keyed by
 * apiBase because task ids only mean something within one runner's database.
 */

import { useEffect, useState } from 'react';
import type { AutomTask, TriggerSource } from '../types.js';
import { TRIGGER_ICON } from './format.js';
import type { Labels } from './i18n.js';
import { TaskDot } from './ui.js';

export const TRIGGER_SOURCES: TriggerSource[] = ['scheduler', 'manual', 'api', 'dev'];

export interface FilterBarProps {
    tasks: AutomTask[];
    hiddenTasks: ReadonlySet<number>;
    setHiddenTasks: (next: Set<number>) => void;
    hiddenTriggers: ReadonlySet<TriggerSource>;
    toggleTrigger: (source: TriggerSource) => void;
    colorOf: (taskId: number) => string;
    labels: Labels;
}

function readHiddenTasks(key: string): Set<number> {
    try {
        const ids: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
        return new Set(Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : []);
    } catch {
        return new Set();
    }
}

/** The hidden-task set, restored from and saved to the browser. Storage that is
 *  missing or refuses (SSR, private mode, quota) only means nothing is remembered. */
export function useStoredHiddenTasks(apiBase: string) {
    const key = `autom:hiddenTasks:${apiBase}`;
    const [hiddenTasks, setHiddenTasks] = useState<ReadonlySet<number>>(() => readHiddenTasks(key));
    useEffect(() => {
        try {
            window.localStorage.setItem(key, JSON.stringify([...hiddenTasks]));
        } catch {
            // Nothing to do: the filter still works for this page.
        }
    }, [key, hiddenTasks]);
    return [hiddenTasks, setHiddenTasks] as const;
}

export function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
}

export default function FilterBar({ tasks, hiddenTasks, setHiddenTasks, hiddenTriggers, toggleTrigger, colorOf, labels }: FilterBarProps) {
    const shown = tasks.filter((t) => !hiddenTasks.has(t.idAutom_Task)).length;

    return (
        <div className="autom-filters">
            <div className="autom-filter-row">
                <span className="autom-filter-label">{labels.filterTasks}</span>
                <div className="autom-filter-chips">
                    {tasks.map((task) => {
                        const on = !hiddenTasks.has(task.idAutom_Task);
                        return (
                            <button
                                key={task.idAutom_Task}
                                type="button"
                                className="autom-filter-chip"
                                aria-pressed={on}
                                style={{ ['--autom-chip-color' as string]: colorOf(task.idAutom_Task) }}
                                onClick={() => setHiddenTasks(toggled(hiddenTasks, task.idAutom_Task))}
                            >
                                <TaskDot color={on ? colorOf(task.idAutom_Task) : 'var(--autom-border)'} />
                                {task.Name}
                            </button>
                        );
                    })}
                </div>
                <span className="autom-filter-actions">
                    <span className="autom-tiny autom-muted">
                        {shown}/{tasks.length} {labels.filterTasks.toLowerCase()}
                    </span>
                    <button type="button" className="autom-btn autom-btn-ghost" onClick={() => setHiddenTasks(new Set())}>
                        {labels.all}
                    </button>
                    <button type="button" className="autom-btn autom-btn-ghost" onClick={() => setHiddenTasks(new Set(tasks.map((t) => t.idAutom_Task)))}>
                        {labels.none}
                    </button>
                </span>
            </div>
            <div className="autom-filter-row">
                <span className="autom-filter-label">{labels.filterTriggers}</span>
                <div className="autom-filter-chips">
                    {TRIGGER_SOURCES.map((source) => (
                        <button
                            key={source}
                            type="button"
                            className="autom-filter-chip"
                            aria-pressed={!hiddenTriggers.has(source)}
                            onClick={() => toggleTrigger(source)}
                        >
                            <span aria-hidden="true">{TRIGGER_ICON[source]}</span>
                            {labels.triggers[source]}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
