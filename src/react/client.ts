/**
 * client.ts
 * Typed access to the runner's API as exposed by a host's proxy mount.
 *
 * Unwraps the { success, data } envelope so callers deal in rows, and turns
 * every failure into a thrown Error carrying a message worth showing. Bodies are
 * read as text first: between the host's own auth layer and the proxy's 502, a
 * response that is not JSON is a normal occurrence here, not a bug.
 */

import type { AutomSchedule, AutomTask, AutomTaskRun, TaskStatus } from '../types.js';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ActiveRunsPayload {
    db: AutomTaskRun[];
    memory: {
        runId: number;
        taskId: number;
        taskName: string;
        attempt: number;
        startedAt: string;
        concurrencyGroup: string | null;
    }[];
}

const defaultFetcher: Fetcher = (url, init) => fetch(url, { credentials: 'same-origin', ...init });

export function createClient(apiBase: string, fetcher: Fetcher = defaultFetcher) {
    const base = apiBase.replace(/\/+$/, '');

    async function request<T>(path: string, init?: RequestInit): Promise<T> {
        const response = await fetcher(`${base}${path}`, init);
        const text = await response.text();

        let payload: any = null;
        try {
            payload = text ? JSON.parse(text) : null;
        } catch {
            // Not JSON: an HTML error page from the host or an upstream 404.
            throw new Error(`HTTP ${response.status}`);
        }

        if (payload && payload.success === false) throw new Error(String(payload.error ?? `HTTP ${response.status}`));
        if (!response.ok) throw new Error(String(payload?.error ?? `HTTP ${response.status}`));
        return payload?.data as T;
    }

    function send<T>(method: string, path: string, body?: unknown): Promise<T> {
        return request<T>(path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }

    return {
        health: () => request<{ runner: string; uptime: number }>('/health'),
        tasks: () => request<AutomTask[]>('/tasks'),
        schedules: () => request<AutomSchedule[]>('/schedules'),
        activeRuns: () => request<ActiveRunsPayload>('/runs/active'),

        runs: (opts: { limit?: number; status?: TaskStatus | ''; taskId?: number | '' } = {}) => {
            const params = new URLSearchParams();
            if (opts.limit) params.set('limit', String(opts.limit));
            if (opts.status) params.set('status', opts.status);
            if (opts.taskId) params.set('taskId', String(opts.taskId));
            const query = params.toString();
            return request<AutomTaskRun[]>(`/runs${query ? `?${query}` : ''}`);
        },

        runsForTask: (taskId: number, limit = 20) => request<AutomTaskRun[]>(`/tasks/${taskId}/runs?limit=${limit}`),

        setTaskActive: (taskId: number, active: boolean) => send<{ updated: number }>('PATCH', `/tasks/${taskId}`, { isActive: active ? 1 : 0 }),

        triggerTask: (taskId: number) => send<{ message: string }>('POST', `/tasks/${taskId}/trigger`, { triggeredBy: 'manual' }),

        createSchedule: (taskId: number, cronExpression: string, isActive: boolean) =>
            send<{ created: number }>('POST', '/schedules', { taskId, cronExpression, isActive: isActive ? 1 : 0 }),

        updateSchedule: (scheduleId: number, fields: { CronExpression?: string; isActive?: 0 | 1 }) =>
            send<{ updated: number }>('PATCH', `/schedules/${scheduleId}`, fields),

        deleteSchedule: (scheduleId: number) => send<{ deleted: number }>('DELETE', `/schedules/${scheduleId}`),
    };
}

export type AutomationClient = ReturnType<typeof createClient>;
