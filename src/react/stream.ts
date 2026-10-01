/**
 * stream.ts
 * GET /runs/events, reopened after an outage.
 *
 * An EventSource reconnects by itself only while the server keeps answering with
 * a stream. A runner restarting behind the proxy answers 502 for the few seconds
 * it is down, and any answer that is not text/event-stream closes an EventSource
 * for good. Left there, the page would poll until it was reloaded. This opens a
 * new one on a backoff instead — which costs a host whose authentication rejects
 * the stream one 401 every thirty seconds, beside the polling it does anyway.
 */

/** EventSource reconnects on its own, so one error is a reconnection, not a
 *  fault. Two in a row without an open in between is an outage. */
const STREAM_GIVE_UP = 2;
/** Delay before the first reopening, doubled on each failure up to the cap. */
const REOPEN_FIRST_MS = 2_000;
const REOPEN_MAX_MS = 30_000;

export interface StreamHandlers {
    event: (type: string, data: any) => void;
    /** Whether the stream is carrying events. False means the caller polls. */
    status: (open: boolean) => void;
}

/** Listens for `types` until the returned function is called. */
export function openRunStream(apiBase: string, types: string[], handlers: StreamHandlers): () => void {
    const url = `${apiBase.replace(/\/+$/, '')}/runs/events`;
    let source: EventSource;
    let reopen: ReturnType<typeof setTimeout> | null = null;
    let delay = REOPEN_FIRST_MS;

    const connect = () => {
        let failures = 0;
        source = new EventSource(url, { withCredentials: true });

        for (const type of types) {
            source.addEventListener(type, (message) => {
                let data: unknown;
                try {
                    data = JSON.parse((message as MessageEvent).data);
                } catch {
                    return; // one malformed frame is not worth tearing the stream down for
                }
                handlers.event(type, data);
            });
        }
        source.onopen = () => {
            failures = 0;
            delay = REOPEN_FIRST_MS;
            handlers.status(true);
        };
        source.onerror = () => {
            handlers.status(false);
            // CLOSED already: the answer was not a stream, and nothing will retry it.
            if (++failures < STREAM_GIVE_UP && source.readyState !== EventSource.CLOSED) return;
            source.close();
            reopen = setTimeout(connect, delay);
            delay = Math.min(delay * 2, REOPEN_MAX_MS);
        };
    };

    connect();
    return () => {
        if (reopen) clearTimeout(reopen);
        source.close();
    };
}
