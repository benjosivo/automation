/**
 * styles.ts
 * The dashboard's stylesheet, injected once into document.head.
 *
 * Why injected rather than shipped as a .css file: hosts bundle differently, and
 * several do not run their JS bundler over CSS at all. A component that carries
 * its own sheet works in all of them with no build configuration. Injection
 * needs `style-src` to allow inline styles, which is the common case even under
 * a script nonce.
 *
 * How theming works, and why it is arranged this way:
 *
 *   - defaults are declared on `:root`
 *   - every rule reads them under `.autom-root`
 *
 * A custom property set on an element always beats one inherited from an
 * ancestor, whatever the source order. So a host restyles the whole dashboard by
 * declaring the same variables on `.autom-root` — or on any element closer than
 * `:root` — and never has to care whether its stylesheet loaded before or after
 * this one. Overriding on `:root` instead would be a coin flip.
 */

export const AUTOM_CSS = `
:root {
    --autom-surface: #ffffff;
    --autom-surface-alt: #f6f6f4;
    --autom-surface-sunken: #edece8;
    --autom-on-surface: #1b1c19;
    --autom-on-surface-muted: #5a5d55;
    --autom-border: #d8d9d2;
    --autom-primary: #3b6939;
    --autom-on-primary: #ffffff;
    --autom-success: #2e6b34;
    --autom-danger: #ac322a;
    --autom-warning: #7a5900;
    --autom-info: #35618e;
    --autom-radius: 0.75rem;
    --autom-radius-sm: 0.375rem;
    --autom-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --autom-font-heading: var(--autom-font);
    --autom-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --autom-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.04);
    --autom-task-l: 42%;
}

@media (prefers-color-scheme: dark) {
    :root {
        --autom-surface: #14161a;
        --autom-surface-alt: #1b1e23;
        --autom-surface-sunken: #23272d;
        --autom-on-surface: #e3e3dd;
        --autom-on-surface-muted: #a7ab9f;
        --autom-border: #363a40;
        --autom-primary: #a1d39a;
        --autom-on-primary: #0a390f;
        --autom-success: #7fd08a;
        --autom-danger: #ffb4ab;
        --autom-warning: #e6c34a;
        --autom-info: #a3c9fe;
        --autom-shadow: 0 1px 2px rgb(0 0 0 / 0.4);
        --autom-task-l: 68%;
    }
}

.autom-root {
    font-family: var(--autom-font);
    color: var(--autom-on-surface);
    font-size: 0.875rem;
    line-height: 1.5;
    container-type: inline-size;
}
.autom-root *, .autom-root *::before, .autom-root *::after { box-sizing: border-box; }
.autom-root p, .autom-root h2, .autom-root h3, .autom-root h4 { margin: 0; }

/* ── Tabs ───────────────────────────────────────────────────────────────── */
.autom-tabs {
    display: flex; flex-wrap: wrap; gap: 0.25rem;
    border-bottom: 1px solid var(--autom-border);
    margin-bottom: 1rem;
}
.autom-tab {
    appearance: none; background: none; border: none; cursor: pointer;
    font: inherit; font-weight: 600; color: var(--autom-on-surface-muted);
    padding: 0.5rem 0.875rem; border-radius: var(--autom-radius-sm) var(--autom-radius-sm) 0 0;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
    display: inline-flex; align-items: center; gap: 0.4rem;
}
.autom-tab:hover { color: var(--autom-on-surface); background: var(--autom-surface-alt); }
.autom-tab[aria-selected="true"] { color: var(--autom-primary); border-bottom-color: var(--autom-primary); }
.autom-tab-badge {
    background: var(--autom-info); color: var(--autom-surface);
    border-radius: 999px; font-size: 0.6875rem; font-weight: 700;
    padding: 0.05rem 0.4rem; min-width: 1.25rem; text-align: center;
}

/* ── Panels ─────────────────────────────────────────────────────────────── */
.autom-panel {
    background: var(--autom-surface); border: 1px solid var(--autom-border);
    border-radius: var(--autom-radius); box-shadow: var(--autom-shadow);
    padding: 1rem; margin-bottom: 1rem;
}
.autom-panel-title {
    font-family: var(--autom-font-heading); font-weight: 700; font-size: 0.9375rem;
    margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
}
.autom-muted { color: var(--autom-on-surface-muted); }
.autom-tiny { font-size: 0.75rem; }
.autom-mono { font-family: var(--autom-font-mono); font-size: 0.8125rem; }

/* ── Stat tiles ─────────────────────────────────────────────────────────── */
.autom-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
.autom-stat {
    background: var(--autom-surface); border: 1px solid var(--autom-border);
    border-radius: var(--autom-radius); padding: 0.75rem 0.875rem;
}
.autom-stat-label { font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--autom-on-surface-muted); }
.autom-stat-value { font-family: var(--autom-font-heading); font-size: 1.5rem; font-weight: 800; line-height: 1.2; }
.autom-stat-sub { font-size: 0.75rem; color: var(--autom-on-surface-muted); }

/* ── Buttons ────────────────────────────────────────────────────────────── */
.autom-btn {
    appearance: none; cursor: pointer; font: inherit; font-size: 0.8125rem; font-weight: 600;
    border-radius: var(--autom-radius-sm); border: 1px solid var(--autom-border);
    background: var(--autom-surface); color: var(--autom-on-surface);
    padding: 0.3rem 0.625rem; display: inline-flex; align-items: center; gap: 0.3rem;
    transition: background-color 120ms, border-color 120ms, transform 80ms;
}
.autom-btn:hover:not(:disabled) { background: var(--autom-surface-alt); }
.autom-btn:active:not(:disabled) { transform: scale(0.97); }
.autom-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.autom-btn-primary { background: var(--autom-primary); color: var(--autom-on-primary); border-color: transparent; }
.autom-btn-primary:hover:not(:disabled) { background: var(--autom-primary); filter: brightness(1.08); }
.autom-btn-danger { color: var(--autom-danger); }
.autom-btn-ghost { border-color: transparent; background: none; padding: 0.15rem 0.35rem; font-size: 0.75rem; }
.autom-btn-ghost:hover:not(:disabled) { background: var(--autom-surface-alt); }

.autom-input, .autom-select {
    font: inherit; font-size: 0.8125rem; color: var(--autom-on-surface);
    background: var(--autom-surface); border: 1px solid var(--autom-border);
    border-radius: var(--autom-radius-sm); padding: 0.3rem 0.5rem;
}
.autom-input:focus-visible, .autom-select:focus-visible, .autom-btn:focus-visible, .autom-tab:focus-visible {
    outline: 2px solid var(--autom-primary); outline-offset: 1px;
}
.autom-input-invalid { border-color: var(--autom-danger); }

/* ── Status chips ───────────────────────────────────────────────────────── */
.autom-chip {
    display: inline-flex; align-items: center; gap: 0.25rem;
    border-radius: 999px; padding: 0.05rem 0.5rem;
    font-size: 0.6875rem; font-weight: 700; white-space: nowrap;
    background: var(--autom-surface-sunken); color: var(--autom-on-surface-muted);
}
.autom-chip-completed { color: var(--autom-success); }
.autom-chip-failed, .autom-chip-timeout { color: var(--autom-danger); }
.autom-chip-running { color: var(--autom-info); }
.autom-chip-pending { color: var(--autom-warning); }

.autom-dot { width: 0.625rem; height: 0.625rem; border-radius: 999px; flex: none; display: inline-block; }
.autom-pulse { animation: autom-pulse 1.4s ease-in-out infinite; }
@keyframes autom-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
    .autom-pulse { animation: none; }
    .autom-btn { transition: none; }
}

/* ── Task cards ─────────────────────────────────────────────────────────── */
.autom-task {
    border: 1px solid var(--autom-border); border-radius: var(--autom-radius);
    background: var(--autom-surface); box-shadow: var(--autom-shadow);
    padding: 0.875rem; margin-bottom: 0.75rem;
}
.autom-task-off { opacity: 0.62; }
.autom-task-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; }
.autom-task-name { font-family: var(--autom-font-heading); font-weight: 700; font-size: 0.9375rem; }
.autom-task-meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; min-width: 0; }
.autom-task-actions { display: flex; gap: 0.35rem; flex-wrap: wrap; }
.autom-task-desc { color: var(--autom-on-surface-muted); font-size: 0.8125rem; margin-top: 0.35rem; }
.autom-task-foot {
    margin-top: 0.6rem; padding-top: 0.6rem; border-top: 1px solid var(--autom-border);
    display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; font-size: 0.75rem;
}
.autom-spark { display: inline-flex; gap: 2px; }
.autom-spark span { width: 6px; height: 14px; border-radius: 2px; }

.autom-sched {
    display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;
    padding: 0.4rem 0.5rem; margin-top: 0.4rem;
    background: var(--autom-surface-alt); border-radius: var(--autom-radius-sm);
}
.autom-sched-off { opacity: 0.6; }
.autom-sched-cron { font-family: var(--autom-font-mono); font-size: 0.8125rem; font-weight: 600; }
.autom-sched-grow { flex: 1 1 8rem; min-width: 0; }
.autom-sched-actions { display: flex; gap: 0.2rem; margin-left: auto; }

/* ── Table ──────────────────────────────────────────────────────────────── */
.autom-table-wrap { overflow-x: auto; }
.autom-table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
.autom-table th {
    text-align: left; font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--autom-on-surface-muted);
    padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--autom-border); white-space: nowrap;
}
.autom-table td { padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--autom-border); vertical-align: top; }
.autom-table tbody tr:hover { background: var(--autom-surface-alt); }
.autom-table-err { color: var(--autom-danger); }

/* ── Calendar ───────────────────────────────────────────────────────────── */
.autom-cal-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
.autom-cal-title { font-family: var(--autom-font-heading); font-weight: 700; font-size: 1rem; min-width: 10rem; }
.autom-cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 1px; background: var(--autom-border); border: 1px solid var(--autom-border); border-radius: var(--autom-radius); overflow: hidden; }
.autom-cal-dow { background: var(--autom-surface-alt); padding: 0.3rem; text-align: center; font-size: 0.6875rem; font-weight: 700; text-transform: uppercase; color: var(--autom-on-surface-muted); }
.autom-cal-day { background: var(--autom-surface); min-height: 5.5rem; padding: 0.3rem; text-align: left; border: none; font: inherit; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
.autom-cal-day:hover { background: var(--autom-surface-alt); }
.autom-cal-day-out { color: var(--autom-on-surface-muted); background: var(--autom-surface-alt); }
.autom-cal-day-today .autom-cal-daynum { background: var(--autom-primary); color: var(--autom-on-primary); border-radius: 999px; padding: 0 0.35rem; }
.autom-cal-daynum { font-size: 0.75rem; font-weight: 700; align-self: flex-start; }
.autom-cal-chip {
    display: flex; align-items: center; gap: 0.25rem; font-size: 0.6875rem;
    padding: 0.05rem 0.25rem; border-radius: var(--autom-radius-sm);
    background: var(--autom-surface-sunken); overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.autom-cal-chip-planned { background: transparent; border: 1px dashed var(--autom-border); }

.autom-week { display: grid; grid-template-columns: 3rem repeat(7, minmax(0, 1fr)); gap: 1px; background: var(--autom-border); border: 1px solid var(--autom-border); border-radius: var(--autom-radius); max-height: 32rem; overflow: auto; }
.autom-week-hour { background: var(--autom-surface-alt); font-size: 0.6875rem; color: var(--autom-on-surface-muted); padding: 0.2rem 0.3rem; text-align: right; }
.autom-week-cell { background: var(--autom-surface); min-height: 1.75rem; padding: 1px 2px; display: flex; flex-wrap: wrap; gap: 2px; }

.autom-bytask { display: grid; gap: 1px; background: var(--autom-border); border: 1px solid var(--autom-border); border-radius: var(--autom-radius); overflow: auto; }
.autom-bytask-name { background: var(--autom-surface-alt); padding: 0.3rem 0.5rem; font-size: 0.75rem; font-weight: 600; white-space: nowrap; position: sticky; left: 0; }
.autom-bytask-cell { background: var(--autom-surface); display: flex; align-items: center; justify-content: center; min-height: 1.75rem; }

.autom-legend { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.6rem; font-size: 0.75rem; color: var(--autom-on-surface-muted); }

/* ── Modal ──────────────────────────────────────────────────────────────── */
.autom-modal-back {
    position: fixed; inset: 0; background: rgb(0 0 0 / 0.45);
    display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 1000;
}
.autom-modal {
    background: var(--autom-surface); color: var(--autom-on-surface);
    border-radius: var(--autom-radius); border: 1px solid var(--autom-border);
    width: min(42rem, 100%); max-height: 85vh; overflow: auto; padding: 1rem;
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.25);
}
.autom-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }
.autom-modal-title { font-family: var(--autom-font-heading); font-weight: 700; font-size: 1rem; }
.autom-pre {
    background: var(--autom-surface-sunken); border-radius: var(--autom-radius-sm);
    padding: 0.75rem; font-family: var(--autom-font-mono); font-size: 0.75rem;
    white-space: pre-wrap; word-break: break-word; margin: 0; max-height: 55vh; overflow: auto;
}
.autom-field { display: block; margin-bottom: 0.75rem; }
.autom-field-label { display: block; font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--autom-on-surface-muted); margin-bottom: 0.25rem; }
.autom-modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }

/* ── States ─────────────────────────────────────────────────────────────── */
.autom-note { padding: 0.75rem; border-radius: var(--autom-radius-sm); background: var(--autom-surface-alt); color: var(--autom-on-surface-muted); font-size: 0.8125rem; }
.autom-note-error { background: color-mix(in srgb, var(--autom-danger) 12%, transparent); color: var(--autom-danger); }
.autom-skeleton { background: var(--autom-surface-alt); border-radius: var(--autom-radius); height: 4rem; margin-bottom: 0.5rem; animation: autom-fade 1.4s ease-in-out infinite; }
@keyframes autom-fade { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.autom-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }

@container (max-width: 34rem) {
    .autom-cal-day { min-height: 3.5rem; }
    .autom-stat-value { font-size: 1.25rem; }
}
`;

const STYLE_ID = 'autom-dashboard-styles';

/** Idempotent, and safe to call from every mounted dashboard: the id check means
 *  two instances share one sheet, and a remount does not stack copies. */
export function injectAutomationStyles(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = AUTOM_CSS;
    document.head.appendChild(style);
}
