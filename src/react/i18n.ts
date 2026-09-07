/**
 * i18n.ts
 * The dashboard's visible strings, in the two languages its hosts speak.
 *
 * Not an i18n framework and not meant to become one: two frozen maps, picked by
 * a prop. Everything the component renders comes from here, so a third language
 * is one object away — but nothing else in the package should grow a `lang`.
 */

export type Lang = 'en' | 'fr';

export interface Labels {
    tabOverview: string;
    tabCalendar: string;
    tabTasks: string;
    tabHistory: string;

    activeTasks: string;
    activeSchedules: string;
    runningNow: string;
    succeeded24h: string;
    failed24h: string;
    successRate: string;
    avgDuration: string;
    nextUp: string;
    nothingScheduled: string;
    recentFailures: string;
    noFailures: string;
    of: string;

    run: string;
    running: string;
    activate: string;
    deactivate: string;
    inactive: string;
    taskHistory: string;
    addSchedule: string;
    edit: string;
    enable: string;
    disable: string;
    remove: string;
    next: string;
    noSchedule: string;
    invalidExpression: string;
    showInactive: string;
    searchTasks: string;
    noTasks: string;
    lastRun: string;
    never: string;
    retries: string;

    month: string;
    week: string;
    byTask: string;
    today: string;
    compact: string;
    detailed: string;
    planned: string;
    past: string;
    more: string;
    dayDetail: string;

    status: string;
    allStatuses: string;
    allTasks: string;
    refresh: string;
    colTask: string;
    colStatus: string;
    colTrigger: string;
    colAttempt: string;
    colStarted: string;
    colFinished: string;
    colDuration: string;
    colSchedule: string;
    colOutput: string;
    limitReached: string;
    noRuns: string;
    view: string;

    newSchedule: string;
    editSchedule: string;
    cronExpression: string;
    activeImmediately: string;
    save: string;
    cancel: string;
    close: string;
    nextOccurrences: string;
    outputTitle: string;
    errorTitle: string;
    confirmDeleteSchedule: string;

    loading: string;
    loadError: string;
    retry: string;
    runnerUnreachable: string;
}

const en: Labels = {
    tabOverview: 'Overview',
    tabCalendar: 'Calendar',
    tabTasks: 'Tasks',
    tabHistory: 'History',

    activeTasks: 'Active tasks',
    activeSchedules: 'Active schedules',
    runningNow: 'Running now',
    succeeded24h: 'Succeeded (24 h)',
    failed24h: 'Failed (24 h)',
    successRate: 'Success rate (24 h)',
    avgDuration: 'average duration',
    nextUp: 'Next up',
    nothingScheduled: 'Nothing scheduled in the next 48 hours.',
    recentFailures: 'Recent failures',
    noFailures: 'No failures recorded.',
    of: 'of',

    run: 'Run',
    running: 'Running',
    activate: 'Activate',
    deactivate: 'Deactivate',
    inactive: 'inactive',
    taskHistory: 'History',
    addSchedule: 'Add a schedule',
    edit: 'Edit',
    enable: 'Enable',
    disable: 'Disable',
    remove: 'Delete',
    next: 'next',
    noSchedule: 'No schedule — this task only runs when triggered by hand.',
    invalidExpression: 'invalid expression',
    showInactive: 'Show inactive',
    searchTasks: 'Search tasks',
    noTasks: 'This runner owns no task.',
    lastRun: 'last run',
    never: 'never run',
    retries: 'retries',

    month: 'Month',
    week: 'Week',
    byTask: 'By task',
    today: 'Today',
    compact: 'Compact',
    detailed: 'Detailed',
    planned: 'planned',
    past: 'past run',
    more: 'more',
    dayDetail: 'Detail',

    status: 'Status',
    allStatuses: 'All statuses',
    allTasks: 'All tasks',
    refresh: 'Refresh',
    colTask: 'Task',
    colStatus: 'Status',
    colTrigger: 'Trigger',
    colAttempt: 'Try',
    colStarted: 'Started',
    colFinished: 'Finished',
    colDuration: 'Duration',
    colSchedule: 'Schedule',
    colOutput: 'Output',
    limitReached: 'Limit reached — older runs are not shown.',
    noRuns: 'No run matches these filters.',
    view: 'View',

    newSchedule: 'New schedule',
    editSchedule: 'Edit schedule',
    cronExpression: 'Cron expression',
    activeImmediately: 'Active immediately',
    save: 'Save',
    cancel: 'Cancel',
    close: 'Close',
    nextOccurrences: 'Next occurrences',
    outputTitle: 'Run output',
    errorTitle: 'Run error',
    confirmDeleteSchedule: 'Delete this schedule?',

    loading: 'Loading…',
    loadError: 'Could not load the automations.',
    retry: 'Retry',
    runnerUnreachable: 'The automation runner is unreachable. It may be stopped.',
};

const fr: Labels = {
    tabOverview: "Vue d'ensemble",
    tabCalendar: 'Calendrier',
    tabTasks: 'Tâches',
    tabHistory: 'Historique',

    activeTasks: 'Tâches actives',
    activeSchedules: 'Planifications actives',
    runningNow: 'En cours',
    succeeded24h: 'Réussies (24 h)',
    failed24h: 'Échouées (24 h)',
    successRate: 'Taux de réussite (24 h)',
    avgDuration: 'durée moyenne',
    nextUp: 'Prochainement',
    nothingScheduled: 'Rien de prévu dans les 48 heures.',
    recentFailures: 'Échecs récents',
    noFailures: 'Aucun échec enregistré.',
    of: 'sur',

    run: 'Exécuter',
    running: 'En cours',
    activate: 'Activer',
    deactivate: 'Désactiver',
    inactive: 'inactive',
    taskHistory: 'Historique',
    addSchedule: 'Ajouter une planification',
    edit: 'Modifier',
    enable: 'Activer',
    disable: 'Suspendre',
    remove: 'Supprimer',
    next: 'prochaine',
    noSchedule: "Aucune planification — cette tâche ne part qu'à la demande.",
    invalidExpression: 'expression invalide',
    showInactive: 'Afficher les inactives',
    searchTasks: 'Rechercher une tâche',
    noTasks: "Ce runner ne possède aucune tâche.",
    lastRun: 'dernière',
    never: 'jamais exécutée',
    retries: 'réessais',

    month: 'Mois',
    week: 'Semaine',
    byTask: 'Par tâche',
    today: "Aujourd'hui",
    compact: 'Compact',
    detailed: 'Détaillé',
    planned: 'prévue',
    past: 'passée',
    more: 'de plus',
    dayDetail: 'Détail',

    status: 'Statut',
    allStatuses: 'Tous les statuts',
    allTasks: 'Toutes les tâches',
    refresh: 'Rafraîchir',
    colTask: 'Tâche',
    colStatus: 'Statut',
    colTrigger: 'Déclencheur',
    colAttempt: 'Essai',
    colStarted: 'Début',
    colFinished: 'Fin',
    colDuration: 'Durée',
    colSchedule: 'Planification',
    colOutput: 'Sortie',
    limitReached: 'Limite atteinte — les exécutions plus anciennes ne sont pas affichées.',
    noRuns: 'Aucune exécution ne correspond à ces filtres.',
    view: 'Voir',

    newSchedule: 'Nouvelle planification',
    editSchedule: 'Modifier la planification',
    cronExpression: 'Expression cron',
    activeImmediately: 'Active immédiatement',
    save: 'Enregistrer',
    cancel: 'Annuler',
    close: 'Fermer',
    nextOccurrences: 'Prochaines occurrences',
    outputTitle: "Sortie de l'exécution",
    errorTitle: "Erreur de l'exécution",
    confirmDeleteSchedule: 'Supprimer cette planification ?',

    loading: 'Chargement…',
    loadError: 'Impossible de charger les automatisations.',
    retry: 'Réessayer',
    runnerUnreachable: "Le runner d'automatisation est injoignable. Il est peut-être arrêté.",
};

export const LABELS: Record<Lang, Labels> = { en, fr };
