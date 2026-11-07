import { Check, Copy, X } from "lucide-react";
import type { ReactNode } from "react";
import { useUi, type ToastKind } from "../state/ui";
import { Button } from "./controls";

function ToastIcon({ kind }: { kind?: ToastKind }) {
  switch (kind) {
    case "needs":
      return <span className="toast-dot" aria-hidden />;
    case "done":
      return <Check size={13} aria-hidden />;
    case "failed":
      return <X size={13} className="toast-failed" aria-hidden />;
    case "copied":
      return <Copy size={13} aria-hidden />;
    default:
      return null;
  }
}

/** Brief confirmations. Persistent state stays in the view it belongs to. `lead`
 * renders first in the stack, for a caller's own prompt. */
export function Toasts({ lead }: { lead?: ReactNode }) {
  const toasts = useUi((state) => state.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {lead}
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <ToastIcon kind={toast.kind} />
          <span>{toast.text}</span>
          {toast.action ? (
            <Button small tone="quiet" className="toast-action" onClick={() => { toast.action?.run(); useUi.getState().dismissToast(toast.id); }}>{toast.action.label}</Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
