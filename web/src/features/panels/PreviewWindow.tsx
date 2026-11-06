import { useEffect } from "react";
import { api } from "../../api/client";
import { matchesKey, runHandlers, whenHolds } from "../../app/shortcuts";
import { useAsync } from "../../lib/useAsync";
import { ErrorState } from "../../ui/states";
import { Toasts } from "../../ui/Toasts";
import { GitHubStarPrompt } from "../../ui/starPrompt/GitHubStarPrompt";
import { BrowserPane } from "./BrowserPanel";

/** A native viewer has preview shortcuts, without the main chat's navigation/actions. */
export function PreviewWindow({ threadId, tabId }: { threadId: string; tabId: string }) {
  const keymap = useAsync("preview-window-keys", (signal) => api.keybindings(signal));
  const rules = keymap.data?.rules;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const editable = document.activeElement?.matches("input,textarea,[contenteditable=true]") ?? false;
      const context = { previewFocus: true, editableFocus: editable, dialogOpen: Boolean(document.querySelector("dialog[open]")) };
      for (const rule of [...(rules ?? [])].reverse()) {
        if (!rule.command.startsWith("preview.") || rule.remove || !matchesKey(rule.key, event) || !whenHolds(rule.when, context)) continue;
        if (runHandlers(rule.command)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    };
    // Preview commands take modified keys before the human-input frame forwards them.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [rules]);
  return <main className="preview-window">
    {keymap.error ? <ErrorState title="Can't load preview shortcuts" failure={keymap.error} onRetry={keymap.reload} /> : null}
    <BrowserPane threadId={threadId} onlyTabId={tabId} detached />
    <Toasts lead={<GitHubStarPrompt />} />
  </main>;
}
