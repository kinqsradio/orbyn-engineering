import { AlertTriangle, ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import type { ApiFailure } from "../api/client";
import { NETWORK_ERROR } from "../api/client";
import { routeHref, type Route } from "../state/route";
import { useLayoutWidth } from "../lib/useLayout";
import { useWaited } from "../lib/motion";
import { Button } from "./controls";

/** A static skeleton, drawn only if the wait outlasts 400 ms. The label is read at once. */
export function Loading({ label, rows = 4 }: { label: string; rows?: number }) {
  const slow = useWaited(true);
  return (
    <div className="loading" role="status">
      <span className="sr-only">{label}</span>
      {slow
        ? Array.from({ length: rows }, (_, at) => <div key={at} className="skeleton" aria-hidden />)
        : null}
    </div>
  );
}

export function ErrorState({
  title,
  failure,
  onRetry,
  compact,
}: {
  title: string;
  failure: ApiFailure;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "error-state error-compact" : "error-state"} role="alert">
      <AlertTriangle size={16} aria-hidden />
      <div className="error-text">
        <strong>{title}</strong>
        <span>
          {failure.code === NETWORK_ERROR ? "Check that the Orbyn service is running." : failure.message}
        </span>
        {failure.code !== NETWORK_ERROR ? (
          <details>
            <summary>Details</summary>
            <code>{failure.code}</code>
          </details>
        ) : null}
      </div>
      {onRetry ? (
        <Button small onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}

/** Screen identity, plus the explicit way back on one-surface layouts. */
/** In the phone layout a page has no sidebar beside it, so its topbar leads back to the thread list. */
export function NarrowBack() {
  const layout = useLayoutWidth();
  if (layout !== "phone") return null;
  return (
    <a className="icon-btn" href={routeHref({ name: "home" })} aria-label="Back to threads" title="Back to threads">
      <ArrowLeft size={16} aria-hidden />
    </a>
  );
}

export function PageHeader({
  title,
  back,
  backLabel,
  actions,
  children,
}: {
  title: string;
  back?: Route;
  backLabel?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const layout = useLayoutWidth();
  const showBack = back && (layout === "phone" || back.name !== "home");
  return (
    <header className="page-head">
      {showBack ? (
        <a className="back-link" href={routeHref(back)}>
          <ArrowLeft size={16} aria-hidden />
          {backLabel ?? "Back"}
        </a>
      ) : null}
      <div className="page-head-row">
        <h1 tabIndex={-1} data-page-title>
          {title}
        </h1>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
