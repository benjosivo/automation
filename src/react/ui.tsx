/**
 * ui.tsx
 * The small pieces every panel reuses. Presentation only — no data access.
 */

import { useEffect, type ReactNode } from 'react';
import type { TaskStatus } from '../types.js';
import { STATUS_ICON } from './format.js';
import type { Labels } from './i18n.js';

export function Panel({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
    return (
        <section className="autom-panel">
            {(title || actions) && (
                <div className="autom-panel-title">
                    <span>{title}</span>
                    {actions}
                </div>
            )}
            {children}
        </section>
    );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
    return (
        <div className="autom-stat">
            <div className="autom-stat-label">{label}</div>
            <div className="autom-stat-value">{value}</div>
            {sub != null && <div className="autom-stat-sub">{sub}</div>}
        </div>
    );
}

export function StatusChip({ status }: { status: TaskStatus }) {
    return (
        <span className={`autom-chip autom-chip-${status}`}>
            <span aria-hidden="true">{STATUS_ICON[status]}</span>
            {status}
        </span>
    );
}

export function TaskDot({ color, pulsing }: { color: string; pulsing?: boolean }) {
    return <span className={`autom-dot${pulsing ? ' autom-pulse' : ''}`} style={{ background: color }} aria-hidden="true" />;
}

export function Note({ children, kind }: { children: ReactNode; kind?: 'error' }) {
    return <p className={`autom-note${kind === 'error' ? ' autom-note-error' : ''}`}>{children}</p>;
}

export function Skeletons({ count = 3 }: { count?: number }) {
    return (
        <>
            {Array.from({ length: count }, (_, i) => (
                <div key={i} className="autom-skeleton" />
            ))}
        </>
    );
}

export function ErrorState({ message, labels, onRetry }: { message: string; labels: Labels; onRetry: () => void }) {
    return (
        <div className="autom-note autom-note-error">
            <p>{message}</p>
            <button type="button" className="autom-btn" style={{ marginTop: '0.5rem' }} onClick={onRetry}>
                {labels.retry}
            </button>
        </div>
    );
}

export function Modal({ title, labels, onClose, children, footer }: { title: string; labels: Labels; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
    // Escape closes. Registered on the document because the dialog is not focused
    // on open and a keydown on the backdrop would otherwise never reach it.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div
            className="autom-modal-back"
            role="presentation"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="autom-modal" role="dialog" aria-modal="true" aria-label={title}>
                <div className="autom-modal-head">
                    <span className="autom-modal-title">{title}</span>
                    <button type="button" className="autom-btn autom-btn-ghost" onClick={onClose} aria-label={labels.close}>
                        ✕
                    </button>
                </div>
                {children}
                {footer && <div className="autom-modal-actions">{footer}</div>}
            </div>
        </div>
    );
}
