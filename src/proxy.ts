/**
 * proxy.ts
 * A mountable Router that forwards to a remote runner's API.
 *
 * The runner has no authentication of its own, so it must not be reachable by
 * anyone but this router (see the `host` option). Mounted behind whatever guard
 * the application server already has, it turns the runner's API into an
 * authenticated one.
 *
 *     import { createAutomationProxyRouter } from '@benjosivo/automation/proxy';
 *
 *     app.use('/admin/api/automations', requireAdmin,
 *             createAutomationProxyRouter({ baseUrl: 'http://127.0.0.1:8500/api' }));
 *
 * That 127.0.0.1 holds only while the runner shares a machine with the server
 * mounting this. `baseUrl` is dialled from inside the calling process, so in
 * separate containers 127.0.0.1 names *the caller's own* loopback, where nothing
 * listens: every request answers 502. Point `baseUrl` at the runner's internal
 * service name instead, and bind the runner to 0.0.0.0 so it can be reached —
 * what keeps its unauthenticated API private is then the network, so its port
 * must stay off the public internet and off the host.
 *
 * Why this belongs in the package rather than in each host: the alternative is a
 * hand-written list of routes to forward, which drifts. The copies that existed
 * before this file both forgot POST /tasks/trigger-by-name/:name and forwarded a
 * query parameter the API never implemented.
 *
 * This subpath pulls in Express and nothing else — no MySQL, no Redis, no
 * node-cron. A host that only drives a remote runner installs none of them.
 */

import { Router, type Request, type Response } from 'express';

export interface AutomationProxyOptions {
    /**
     * Full base of the remote API, `/api` included — this router appends nothing
     * but the path it was given. A trailing slash is tolerated.
     */
    baseUrl: string;
    /** Give up on the runner after this many milliseconds. Default 10 000. */
    timeoutMs?: number;
}

export function createAutomationProxyRouter(options: AutomationProxyOptions): Router {
    const base = options.baseUrl.replace(/\/+$/, '');
    const timeoutMs = options.timeoutMs ?? 10_000;
    const router = Router();

    // One handler, no path. A router-level middleware sees every method and every
    // remaining path, and req.url is what is left after the mount point — query
    // string included. So this forwards the route and its parameters together,
    // and keeps working when the runner's API grows a route.
    router.use(async (req: Request, res: Response) => {
        const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined;

        try {
            const upstream = await fetch(`${base}${req.url}`, {
                method: req.method,
                headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
                body: hasBody ? JSON.stringify(req.body) : undefined,
                signal: AbortSignal.timeout(timeoutMs),
            });

            // Text rather than json(): a path the runner does not match answers
            // Express's HTML 404, and parsing that would turn a legible 404 into a
            // misleading 502.
            const body = await upstream.text();
            const type = upstream.headers.get('content-type');
            if (type) res.type(type);
            res.status(upstream.status).send(body);
        } catch (err: any) {
            // `err.message` alone is the string "fetch failed" — Node puts the useful
            // half in `err.cause` ("connect ECONNREFUSED 10.0.1.4:8500", "getaddrinfo
            // ENOTFOUND runner"). Reporting only the outer message costs whoever reads
            // this 502 the address that failed and the reason it failed, which is the
            // entire diagnosis when a host is misconfigured. A timeout has no `cause`
            // and describes itself, so the fallback covers it.
            const cause = err?.cause?.message ?? err?.message ?? String(err);
            // Same envelope as the API's own failures, so a client needs one shape.
            res.status(502).json({ success: false, error: `Automation runner unreachable at ${base}: ${cause}` });
        }
    });

    return router;
}
