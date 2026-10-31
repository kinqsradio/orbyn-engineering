import { ArrowLeft, X } from "lucide-react";
import type { Thread } from "../../api/types";
import { useUi } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";
import { ActivityPanel } from "./ActivityPanel";
import { DiffPanel } from "./DiffPanel";
import { RIGHT_TABS } from "./tabs";

export function ContextPanel({
  thread,
  overlay,
  onReturn,
}: {
  thread: Thread;
  /** True when the panel replaces the thread instead of sitting beside it. */
  overlay: boolean;
  onReturn(): void;
}) {
  const tab = useUi((state) => state.panelTab);
  const toggle = useUi((state) => state.togglePanel);
  const select = (id: typeof tab) => {
    if (id !== tab) toggle(id);
  };

  return (
    <aside className="context" aria-label="Thread context">
      <header className="context-head">
        {overlay ? (
          <Button small tone="quiet" icon={<ArrowLeft size={16} aria-hidden />} onClick={onReturn}>
            Back to thread
          </Button>
        ) : null}
        <div className="tabs" role="tablist" aria-label="Context">
          {RIGHT_TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`context-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`context-${id}`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => select(id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                const at = RIGHT_TABS.findIndex((entry) => entry.id === id);
                const step = event.key === "ArrowRight" ? 1 : -1;
                const next = RIGHT_TABS[(at + step + RIGHT_TABS.length) % RIGHT_TABS.length];
                if (next) {
                  select(next.id);
                  document.getElementById(`context-tab-${next.id}`)?.focus();
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {overlay ? null : (
          <IconButton label="Close panel" onClick={onReturn}>
            <X size={16} aria-hidden />
          </IconButton>
        )}
      </header>
      <div className="context-body">
        <div id={`context-${tab}`} role="tabpanel" aria-labelledby={`context-tab-${tab}`} className="tabpanel">
          {tab === "diff" ? <DiffPanel threadId={thread.id} /> : <ActivityPanel threadId={thread.id} />}
        </div>
      </div>
    </aside>
  );
}
