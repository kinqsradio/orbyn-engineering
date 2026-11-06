import { X } from "lucide-react";
import { useUi } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";
import { useToastSwipe } from "./useToastSwipe";

/** Shown once to people whose saved sidebar settings moved to project folders. */
export function FoldersNotice() {
  const shown = useUi((state) => state.foldersNotice);
  const close = useUi((state) => state.closeFoldersNotice);
  const swipe = useToastSwipe(() => close(false));
  if (!shown) return null;
  return (
    <div {...swipe} className="toast folders-notice" role="group" aria-label="Threads grouped by project">
      <div className="folders-notice-body">
        <strong>Threads are now grouped by project.</strong>
        <p>Change this any time in Settings › Threads.</p>
        <div className="star-prompt-actions">
          <Button small tone="quiet" onClick={() => close(true)}>
            Turn off
          </Button>
        </div>
      </div>
      <IconButton label="Dismiss notification" onClick={() => close(false)}>
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  );
}
