import { ArrowLeft, X } from "lucide-react";
import { useState } from "react";
import type { Thread } from "../../api/types";
import { useUi } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";
import { ActivityPanel } from "./ActivityPanel";
import { DiffPanel } from "./DiffPanel";
import { CONTEXT_TABS } from "./tabs";
import { TerminalPanel } from "./TerminalPanel";

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
  // The terminal keeps its socket and scrollback once opened.
  const [terminalOpened, setTerminalOpened] = useState(tab === "terminal");
  if (tab === "terminal" && !terminalOpened) setTerminalOpened(true);
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
          {CONTEXT_TABS.map(({ id, label }) => (
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
                const at = CONTEXT_TABS.findIndex((entry) => entry.id === id);
                const step = event.key === "ArrowRight" ? 1 : -1;
                const next = CONTEXT_TABS[(at + step + CONTEXT_TABS.length) % CONTEXT_TABS.length];
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
        {tab === "diff" ? (
          <div id="context-diff" role="tabpanel" aria-labelledby="context-tab-diff" className="tabpanel">
            <DiffPanel threadId={thread.id} />
          </div>
        ) : null}
        {tab === "activity" ? (
          <div id="context-activity" role="tabpanel" aria-labelledby="context-tab-activity" className="tabpanel">
            <ActivityPanel threadId={thread.id} />
          </div>
        ) : null}
        {terminalOpened ? (
          <div
            id="context-terminal"
            role="tabpanel"
            aria-labelledby="context-tab-terminal"
            className="tabpanel"
            hidden={tab !== "terminal"}
          >
            <TerminalPanel threadId={thread.id} />
          </div>
        ) : null}
      </div>
    </aside>
  );
}
