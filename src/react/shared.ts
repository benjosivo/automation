/**
 * shared.ts
 * The shape the dashboard hands to each panel.
 *
 * One object rather than a dozen props: the panels all need the same four
 * collections and the same six actions, and a context would hide which of them a
 * panel actually touches.
 */

import type { AutomSchedule, AutomTask, AutomTaskRun } from '../types.js';
import type { ActiveRunsPayload } from './client.js';
import type { Labels } from './i18n.js';

export interface DashboardData {
    tasks: AutomTask[];
    schedules: AutomSchedule[];
    /** One history window, loaded once and filtered in the browser. The overview,
     *  the calendar and the history table all read this same list. */
    runs: AutomTaskRun[];
    active: ActiveRunsPayload;
}

export interface DashboardActions {
    triggerTask: (taskId: number) => void;
    toggleTask: (task: AutomTask) => void;
    /** Opens the editor: with a schedule to edit it, without to create one. */
    editSchedule: (taskId: number, schedule?: AutomSchedule) => void;
    toggleSchedule: (schedule: AutomSchedule) => void;
    deleteSchedule: (schedule: AutomSchedule) => void;
    showRun: (run: AutomTaskRun) => void;
    /** Switches to the history tab, filtered on that task. */
    showTaskHistory: (taskId: number) => void;
    goToCalendar: (date: Date) => void;
}

export interface PanelProps {
    data: DashboardData;
    actions: DashboardActions;
    labels: Labels;
    locale: string;
    /** Stable colour for a task, by its id. */
    colorOf: (taskId: number) => string;
    /** Ids of tasks and schedules with a request in flight, so their buttons
     *  can be disabled without a spinner per row. */
    busy: ReadonlySet<string>;
}

/** Keys used in PanelProps.busy — one namespace for tasks and schedules. */
export const busyKey = {
    task: (id: number) => `task:${id}`,
    schedule: (id: number) => `schedule:${id}`,
};
