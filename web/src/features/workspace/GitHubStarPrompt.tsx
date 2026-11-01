import { Star, X } from "lucide-react";
import { create } from "zustand";
import { api } from "../../api/client";
import { Button, IconButton } from "../../ui/controls";
import { StarPromptSession } from "./starPrompt";
import { useToastSwipe } from "../../ui/useToastSwipe";

const useStarNotice = create<{ close: (() => void) | null }>(() => ({ close: null }));
const session = new StarPromptSession(
  () => window.localStorage,
  async () => (await api.repositoryStar()).starred,
  (close) => useStarNotice.setState({ close }),
);

export const recordUserPrompt = () => { void session.sent(); };

/** An untimed toast, sharing one dismissal path for every close control. */
export function GitHubStarPrompt() {
  const close = useStarNotice((state) => state.close);
  return close ? <StarNotice close={close} /> : null;
}

function StarNotice({ close }: { close(): void }) {
  const dismiss = () => { close(); useStarNotice.setState({ close: null }); };
  const swipe = useToastSwipe(dismiss);
  return <div {...swipe} className="toast star-prompt" role="group" aria-label="Enjoying Orbyn Engineering?">
    <Star size={18} className="star-prompt-icon" aria-hidden />
    <div className="star-prompt-body">
      <strong>Enjoying Orbyn Engineering?</strong>
      <p>Give us a star on GitHub to let us know!</p>
      <div className="star-prompt-actions">
        <Button small tone="quiet" onClick={dismiss}>Dismiss</Button>
        <a className="btn btn-primary btn-small" href="https://github.com/kinqsradio/orbyn-engineering" target="_blank" rel="noopener noreferrer" onClick={dismiss}>Star on GitHub</a>
      </div>
    </div>
    <IconButton label="Dismiss notification" onClick={dismiss}><X size={14} aria-hidden /></IconButton>
  </div>;
}
