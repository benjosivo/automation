/**
 * config.ts
 * Holds the configuration handed to startAutomationServer().
 *
 * A published package cannot read process.env for its host: the variable names,
 * the alerting channel and the runner identity all belong to whoever embeds it.
 */

import type { AutomationConfig } from './types.js';

let current: Required<Pick<AutomationConfig, 'runner' | 'port' | 'mysql' | 'redisUrl' | 'corsOrigins' | 'onError'>> | null = null;

export function setConfig(config: AutomationConfig): void {
    if (!config.runner) throw new Error('[Automation] config.runner is required — it decides which tasks this process owns.');

    current = {
        runner: config.runner,
        port: config.port,
        mysql: config.mysql,
        redisUrl: config.redisUrl,
        corsOrigins: config.corsOrigins ?? [],
        onError: config.onError ?? ((error, context) => console.error(`[${context}]`, error)),
    };
}

export function cfg() {
    if (!current) throw new Error('[Automation] startAutomationServer() has not run yet.');
    return current;
}

/** The runner name alone — the argument threaded through every scoped query. */
export function runner(): string {
    return cfg().runner;
}

export function handleError(error: unknown, context: string): void {
    cfg().onError(error, context);
}
