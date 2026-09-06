/**
 * redis.ts
 * The lazily-reconnecting client, plus the automation keys layered on top:
 *   autom:task:<id>:active        fast path for Autom_Task.isActive
 *   autom:run:<id>:heartbeat      liveness of a run
 *   autom:trigger:queue:<runner>  on-demand triggers, one queue per runner
 */

import { createClient, type RedisClientType } from 'redis';
import { cfg, handleError, runner } from './config.js';

let client: RedisClientType | null = null;
let lastConnectionCheck = 0;
const CONNECTION_CHECK_INTERVAL = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function createRedisClient(): RedisClientType {
    const c = createClient({ url: cfg().redisUrl }) as RedisClientType;
    c.on('error', (err) => handleError(err, 'Redis client error'));
    c.on('end', () => console.log('[Redis] Connection closed.'));
    return c;
}

async function ensureConnected(): Promise<RedisClientType> {
    const now = Date.now();
    if (client?.isOpen && now - lastConnectionCheck < CONNECTION_CHECK_INTERVAL) return client;

    try {
        if (!client?.isOpen) {
            client = createRedisClient();
            await client.connect();
        }
        if ((await client.ping()) === 'PONG') lastConnectionCheck = now;
        return client;
    } catch (err) {
        handleError(err, 'Redis: ensureConnected');
        throw err;
    }
}

/** Connects eagerly at boot so a bad REDIS_URL surfaces there rather than on the
 *  first trigger poll. Called by startAutomationServer, not at import time — the
 *  URL comes from the config, which does not exist yet when this module loads. */
export async function connectRedis(): Promise<void> {
    try {
        await ensureConnected();
    } catch (err) {
        handleError(err, 'Redis: initial connection');
    }
}

export async function closeRedis(): Promise<void> {
    if (client?.isOpen) await client.close();
    client = null;
}

/** `expirationMs` is an absolute epoch timestamp (Redis PXAT), not a duration.
 *  Passing a duration here silently stores a key that expired in 1970. */
async function setCache(opt: { key: string; obj: unknown; expirationMs?: number }): Promise<boolean> {
    const { key, obj, expirationMs = Date.now() + DEFAULT_TTL_MS } = opt;
    try {
        const c = await ensureConnected();
        if (expirationMs === -1) {
            await c.SET(key, JSON.stringify(obj));
        } else {
            await c.SET(key, JSON.stringify(obj), { PXAT: expirationMs });
        }
        return true;
    } catch (err) {
        handleError(err, 'setCache redis');
        return false;
    }
}

async function getCache(key: string): Promise<unknown> {
    try {
        const c = await ensureConnected();
        const raw = await c.GET(key);
        if (!raw) return undefined;
        try {
            return JSON.parse(raw);
        } catch {
            return raw;
        }
    } catch (err) {
        handleError(err, 'getCache redis');
        return undefined;
    }
}

// ─── Task active flag ─────────────────────────────────────────────────────────
// Redis is the fast path, checked before touching the DB.
// The source of truth remains Autom_Task.isActive in MySQL.

const taskActiveKey = (taskId: number) => `autom:task:${taskId}:active`;

export async function setTaskActiveFlag(taskId: number, active: boolean): Promise<void> {
    await setCache({ key: taskActiveKey(taskId), obj: active ? '1' : '0' });
}

export async function isTaskActiveInRedis(taskId: number): Promise<boolean | null> {
    const val = await getCache(taskActiveKey(taskId));
    if (val === null || val === undefined) return null; // not cached — caller falls back to the DB
    return val === '1';
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

const HEARTBEAT_TTL = 90 * 1000;
const HEARTBEAT_INTERVAL = 30 * 1000;

const heartbeatKey = (runId: number) => `autom:run:${runId}:heartbeat`;

async function setHeartbeat(runId: number): Promise<void> {
    await setCache({ key: heartbeatKey(runId), obj: Date.now().toString(), expirationMs: HEARTBEAT_TTL });
}

async function clearHeartbeat(runId: number): Promise<void> {
    await setCache({ key: heartbeatKey(runId), obj: '', expirationMs: 1 });
}

/** Returns the stopper — call it when the run finishes. */
export function startHeartbeat(runId: number): () => void {
    setHeartbeat(runId).catch(() => {});

    const timer = setInterval(() => {
        setHeartbeat(runId).catch(() => {});
    }, HEARTBEAT_INTERVAL * 1000);

    return () => {
        clearInterval(timer);
        clearHeartbeat(runId).catch(() => {});
    };
}

// ─── On-demand trigger queue ──────────────────────────────────────────────────
// A JSON array read-modify-written through setCache, drained whole on each poll,
// so it is not concurrency-safe across processes.
//
// The key carries the runner name: with a single shared key, whichever runner
// polled first would swallow triggers meant for the other and fail to load a
// module it does not ship.

export interface TriggerPayload {
    taskId: number;
    triggeredBy: 'api' | 'manual';
    scheduleId?: number;
}

const triggerQueueKey = () => `autom:trigger:queue:${runner()}`;

export async function popTriggers(): Promise<TriggerPayload[]> {
    const existing = await getCache(triggerQueueKey());
    if (!existing) return [];
    const queue: TriggerPayload[] = typeof existing === 'string' ? JSON.parse(existing) : (existing as TriggerPayload[]);
    if (queue.length === 0) return [];
    await setCache({ key: triggerQueueKey(), obj: JSON.stringify([]) });
    return queue;
}
