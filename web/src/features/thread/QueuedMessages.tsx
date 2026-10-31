import { CornerDownRight, Send, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { QueuedMessage } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { Button, IconButton } from "../../ui/controls";

/** Messages waiting for the current turn, each with its own way to go sooner. */
export function QueuedMessages({
  threadId,
  items,
  running,
  onChange,
}: {
  threadId: string;
  items: QueuedMessage[];
  running: boolean;
  onChange(): void;
}) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [items.length]);

  const act = (work: Promise<unknown>) => {
    setError(null);
    work.then(onChange, (failure: unknown) => setError(toFailure(failure).message));
  };

  if (items.length === 0) return null;
  const held = items.some((item) => item.held);
  return (
    <div className="queue" aria-label="Queued messages">
      {items.map((item) => (
        <div key={item.id} className="queue-row">
          <span className="queue-text">{item.prompt}</span>
          {running ? (
            <IconButton
              label={`Add to the running turn: ${item.prompt}`}
              onClick={() =>
                act(api.steer(threadId, item.prompt).then(() => api.removeQueued(item.id)))
              }
            >
              <CornerDownRight size={14} aria-hidden />
            </IconButton>
          ) : null}
          <IconButton label={`Send now: ${item.prompt}`} onClick={() => act(api.sendQueuedNow(item.id))}>
            <Send size={14} aria-hidden />
          </IconButton>
          <IconButton label={`Remove: ${item.prompt}`} onClick={() => act(api.removeQueued(item.id))}>
            <X size={14} aria-hidden />
          </IconButton>
        </div>
      ))}
      {held ? (
        <div className="queue-row">
          <span className="queue-text muted">Held after the last run stopped.</span>
          <Button small onClick={() => act(api.resumeQueue(threadId))}>
            Resume
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
