/**
 * cron.ts
 * A five-field cron parser: validation, date matching, occurrence expansion.
 *
 * Pure arithmetic — no import, no DOM, no Node builtin. That is the point: this
 * file is the one part of the package a browser bundle may pull in, through the
 * "@benjosivo/automation/cron" subpath, without dragging Express, Redis and
 * MySQL along with it. Keep it that way; an import here is a regression.
 *
 * It does not replace node-cron, which owns the firing. It answers the two
 * questions node-cron cannot: "is this string a schedule at all", before the row
 * reaches the database, and "when would it fire next", for a preview.
 *
 * Two limits worth knowing, both deliberate:
 *
 *   - Everything runs in the host's local time, through setHours(). A daylight
 *     saving transition therefore duplicates or skips an occurrence, exactly as
 *     the system cron it imitates does.
 *   - nextRuns() starts one minute out, so it never offers the occurrence of the
 *     current minute — which may already have fired.
 */

const MONTH_NAMES = ['', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface ParsedCron {
    min: Set<number>;
    hour: Set<number>;
    dom: Set<number>;
    mon: Set<number>;
    dow: Set<number>;
    /** Whether day-of-month was narrowed. Cron ORs the two day fields when both
     *  are, and ANDs them otherwise — matchesDate() needs to know which. */
    domRestricted: boolean;
    dowRestricted: boolean;
}

/** One comma-separated field expanded to the set of values it allows, or null
 *  if it is malformed. Handles `*`, `a-b`, `*\/n`, `a-b/n`, `a/n` and names. */
export function parseCronField(field: string, min: number, max: number, names?: string[]): Set<number> | null {
    const out = new Set<number>();

    for (const part of field.split(',')) {
        if (part === '') return null;

        const [rangePart, stepPart, ...extra] = part.split('/');
        if (extra.length > 0) return null;

        let step = 1;
        if (stepPart !== undefined) {
            if (!/^\d+$/.test(stepPart)) return null;
            step = parseInt(stepPart, 10);
            if (step < 1) return null;
        }

        let from: number;
        let to: number;

        if (rangePart === '*') {
            from = min;
            to = max;
        } else {
            const bounds = rangePart.split('-');
            if (bounds.length > 2) return null;

            const start = parseCronValue(bounds[0], names);
            if (start === null) return null;

            if (bounds.length === 1) {
                from = start;
                // `5` is a single value; `5/10` means "from 5 to the end, every 10"
                to = stepPart === undefined ? start : max;
            } else {
                const end = parseCronValue(bounds[1], names);
                if (end === null) return null;
                from = start;
                to = end;
            }
        }

        if (from < min || to > max || from > to) return null;
        for (let v = from; v <= to; v += step) out.add(v);
    }

    return out.size > 0 ? out : null;
}

function parseCronValue(token: string, names?: string[]): number | null {
    if (token === '') return null;
    if (/^\d+$/.test(token)) return parseInt(token, 10);
    if (!names) return null;
    const idx = names.indexOf(token.toLowerCase());
    return idx === -1 ? null : idx;
}

/** null for anything this parser does not accept — including the six-field form
 *  with seconds, which node-cron allows but nothing else in the package does. */
export function parseCron(expr: string): ParsedCron | null {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const [minF, hourF, domF, monF, dowF] = parts;

    const min = parseCronField(minF, 0, 59);
    const hour = parseCronField(hourF, 0, 23);
    const dom = parseCronField(domF, 1, 31);
    const mon = parseCronField(monF, 1, 12, MONTH_NAMES);
    const dow = parseCronField(dowF, 0, 7, DAY_NAMES);

    if (!min || !hour || !dom || !mon || !dow) return null;

    // Both 0 and 7 mean Sunday; Date.getDay() only ever returns 0.
    if (dow.delete(7)) dow.add(0);

    return {
        min,
        hour,
        dom,
        mon,
        dow,
        domRestricted: !domF.startsWith('*'),
        dowRestricted: !dowF.startsWith('*'),
    };
}

export function isValidCron(expr: string): boolean {
    return parseCron(expr) !== null;
}

/** Whether a day satisfies the date half of the expression. When both day fields
 *  are narrowed, cron takes their union, not their intersection: `0 0 1 * mon`
 *  fires on the 1st *and* on every Monday. */
export function matchesDate(p: ParsedCron, date: Date): boolean {
    if (!p.mon.has(date.getMonth() + 1)) return false;

    const domHit = p.dom.has(date.getDate());
    const dowHit = p.dow.has(date.getDay());

    if (p.domRestricted && p.dowRestricted) return domHit || dowHit;
    if (p.domRestricted) return domHit;
    if (p.dowRestricted) return dowHit;
    return true;
}

/**
 * Every occurrence in [from, to), ascending, capped.
 *
 * The cap is not a detail: `* * * * *` over a month is 43 200 dates, and this
 * feeds a calendar. Callers get a truncated list, never a frozen tab.
 */
export function expandCron(expr: string, from: Date, to: Date, cap = 500): Date[] {
    const p = parseCron(expr);
    if (!p) return [];

    const hours = [...p.hour].sort((a, b) => a - b);
    const minutes = [...p.min].sort((a, b) => a - b);
    const out: Date[] = [];

    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);

    while (cursor.getTime() < to.getTime() && out.length < cap) {
        if (matchesDate(p, cursor)) {
            for (const h of hours) {
                for (const m of minutes) {
                    const occurrence = new Date(cursor);
                    occurrence.setHours(h, m, 0, 0);
                    if (occurrence.getTime() < from.getTime()) continue;
                    if (occurrence.getTime() >= to.getTime()) break;
                    out.push(occurrence);
                    if (out.length >= cap) break;
                }
                if (out.length >= cap) break;
            }
        }
        cursor.setDate(cursor.getDate() + 1);
    }

    return out;
}

/** The next few firings from now. Searches one year ahead, so an expression that
 *  only matches a rare date (`0 0 29 2 *`) still yields something. */
export function nextRuns(expr: string, count = 4): Date[] {
    const from = new Date(Date.now() + 60_000);
    from.setSeconds(0, 0);

    const to = new Date(from);
    to.setFullYear(to.getFullYear() + 1);

    return expandCron(expr, from, to, count);
}
