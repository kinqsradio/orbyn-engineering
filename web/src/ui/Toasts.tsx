import type { ReactNode } from "react";
import { useUi } from "../state/ui";

/** Brief confirmations. Persistent state stays in the view it belongs to. `lead`
 * renders first in the stack, for a caller's own prompt. */
export function Toasts({ lead }: { lead?: ReactNode }) {
  const toasts = useUi((state) => state.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {lead}
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          {toast.text}
        </div>
      ))}
    </div>
  );
}
