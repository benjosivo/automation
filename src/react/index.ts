/**
 * @benjosivo/automation/react
 *
 * A drop-in management interface for a runner: schedules, statistics, failures,
 * manual triggering, run history and a calendar, in one component.
 *
 *     import { AutomationDashboard } from '@benjosivo/automation/react';
 *
 *     <AutomationDashboard apiBase="/admin/api/automations" lang="fr" />
 *
 * `apiBase` points at wherever the host mounted createAutomationProxyRouter —
 * behind its own authentication, because the runner has none.
 *
 * This subpath imports react and nothing else from the outside: no Express, no
 * Redis, no MySQL. The peer dependency on @benjosivo/mysql applies to the
 * package root, not here.
 *
 * Styling: the component injects one stylesheet and reads its colours from
 * --autom-* custom properties, so a host restyles it by declaring those on
 * .autom-root. A host whose CSP forbids inline styles can import AUTOM_CSS and
 * serve it through its own pipeline instead.
 */

export { default as AutomationDashboard } from './AutomationDashboard.js';
export type { AutomationDashboardProps } from './AutomationDashboard.js';
export type { Fetcher } from './client.js';
export type { Lang } from './i18n.js';
export { AUTOM_CSS, injectAutomationStyles } from './styles.js';
