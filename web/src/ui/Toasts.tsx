import { useUi } from "../state/ui";
import { GitHubStarPrompt } from "../features/workspace/GitHubStarPrompt";

/** Brief confirmations. Persistent state stays in the view it belongs to. */
export function Toasts() {
  const toasts = useUi((state) => state.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      <GitHubStarPrompt />
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          {toast.text}
        </div>
      ))}
    </div>
  );
}
