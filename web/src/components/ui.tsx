/**
 * Shared layout and state components for the ruled editorial layout:
 * grouping by hairline rules, no cards, shadows or nested boxes.
 */

import { useEffect, useId, useRef, type ReactNode } from "react";
import { describeError } from "../api/errors";
import { StatusMark } from "./StatusMark";

export function PageHeader({
  kicker,
  title,
  actions,
  children,
}: {
  kicker: string;
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="label">{kicker}</p>
          <h1 className="font-serif text-[32px] leading-tight lg:text-[38px]">{title}</h1>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-3">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

/** Section label followed by a 1px ink rule. */
export function SectionHeader({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-ink pb-2">
      <h2 className="label">{children}</h2>
      {aside ? <div className="text-[13px] text-mu">{aside}</div> : null}
    </div>
  );
}

/** Inline failure line: glyph, plain cause, optional retry action. Never shows request data. */
export function ErrorLine({
  error,
  message,
  onRetry,
  retryLabel = "Try again",
}: {
  error?: unknown;
  /** Overrides the wording derived from `error`. */
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-er py-2.5 text-[13px] text-er">
      <StatusMark kind="failed" label="Failed" />
      <span>{message ?? describeError(error)}</span>
      {onRetry ? (
        <button type="button" className="text-action tap-target text-er" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

/** Inline success confirmation; dismisses itself after about four seconds. */
export function SuccessLine({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 4000);
    return () => window.clearTimeout(timer);
  }, [onDone]);
  return (
    <p role="status" className="flex items-center gap-2 text-[13px]">
      <StatusMark kind="ok" label={message} />
    </p>
  );
}

/** Ruled placeholder rows: same rhythm as real rows, no spinner or shimmer. */
export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true">
      <p role="status" className="py-2 text-[13px] text-mu">
        Loading…
      </p>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-6 border-b border-ru py-2.75" aria-hidden="true">
          <span className="h-3.5 w-24 bg-ru/40" />
          <span className="h-3.5 w-48 bg-ru/40" />
          <span className="h-3.5 flex-1 bg-ru/40" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  steps,
  action,
}: {
  title: string;
  body: string;
  steps?: string[];
  action?: ReactNode;
}) {
  return (
    <section className="border-t border-ru py-8 sm:border sm:border-dashed sm:px-10 sm:py-12">
      <h2 className="font-serif text-[28px] leading-tight sm:text-[34px]">{title}</h2>
      <p className="mt-2 max-w-prose text-mu">{body}</p>
      {steps ? (
        <ol className="mt-6 max-w-prose">
          {steps.map((step, i) => (
            <li key={step} className="flex gap-4 border-b border-ru py-2.5">
              <span className="font-mono text-[12px] text-mu">{String(i + 1).padStart(2, "0")}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="label">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[12px] text-mu">{hint}</p> : null}
      {error ? (
        <p className="text-[12px] text-er" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Keyboard-operable confirmation that names the affected resource. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md border-t border-ink bg-bg p-6 sm:border"
      >
        <h2 id={titleId} className="font-serif text-[22px]">
          {title}
        </h2>
        <div className="mt-3 text-[14px]">{children}</div>
        <div className="mt-6 flex flex-wrap justify-end gap-4">
          <button ref={cancelRef} type="button" className="text-action tap-target" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={destructive ? "btn-primary bg-er" : "btn-primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Explains why a control is unavailable instead of hiding it or faking success. */
export function DisabledNote({ children }: { children: ReactNode }) {
  return <p className="text-[12px] text-mu">{children}</p>;
}
