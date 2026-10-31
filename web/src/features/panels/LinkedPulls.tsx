import { Bell, BellOff, Link2Off } from "lucide-react";
import { useState } from "react";
import type { Thread } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { PullDetail } from "../pulls/PullDetail";
import { pullsApi } from "../pulls/pullsApi";

/** Finds a pull request by number or words, and links it to this thread. */
function LinkDialog({ thread, onClose, onLinked }: { thread: Thread; onClose(): void; onLinked(): void }) {
  const [query, setQuery] = useState("");
  const candidates = useAsync(`pull-candidates:${thread.project_id}:${query}`, (signal) =>
    pullsApi.projectPulls(thread.project_id, query, signal),
  );
  const [error, setError] = useState<string | null>(null);
  const link = (number: number) => {
    setError(null);
    pullsApi.link(thread.id, number).then(
      () => {
        onLinked();
        onClose();
      },
      (failure: unknown) => setError(toFailure(failure).message),
    );
  };
  return (
    <Dialog title="Link a pull request" onClose={onClose}>
      <input aria-label="Find a pull request" placeholder="Number or title" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} />
      <ul className="branch-list" aria-label="Pull requests">
        {(candidates.data ?? []).map((pull) => (
          <li key={pull.number}>
            <button type="button" onClick={() => link(pull.number)}>
              <span>
                #{pull.number} {pull.title}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** The pull requests linked to this thread, and one at a time in detail. */
export function LinkedPulls({ thread }: { thread: Thread }) {
  const linked = useAsync(`linked-pulls:${thread.id}`, (signal) => pullsApi.linked(thread.id, signal));
  const [selected, setSelected] = useState<number | null>(null);
  const watches = useAsync(`pull-watches:${thread.id}`, (signal) => pullsApi.watches(thread.id, signal));
  const [linking, setLinking] = useState(false);
  const pushToast = useUi((state) => state.pushToast);
  const act = (work: Promise<void>, done: () => void) => {
    work.then(done, (failure: unknown) => pushToast(`Couldn't do that. ${toFailure(failure).message}`));
  };
  const refresh = async () => {
    try {
      linked.setData(await pullsApi.refreshLinked(thread.id));
    } catch (failure) {
      pushToast(`Couldn't refresh. ${toFailure(failure).message}`);
    }
  };
  if (selected !== null) {
    return (
      <PullDetail projectId={thread.project_id} number={selected} onClose={() => setSelected(null)} onOpen={setSelected} />
    );
  }
  if (linked.status === "loading") return <Loading label="Loading pull requests" rows={3} />;
  if (linked.status === "error") {
    return <ErrorState compact title="Couldn't load pull requests" failure={linked.error} onRetry={linked.reload} />;
  }
  return (
    <div className="linked-pulls">
      {linked.data.length === 0 ? (
        <Empty title="No linked pull requests" />
      ) : (
        <ul className="pulls-list">
          {linked.data.map((pull) => {
            const watching = watches.data?.some((watch) => watch.number === pull.number) ?? false;
            return (
              <li key={pull.number}>
                <button type="button" onClick={() => setSelected(pull.number)}>
                  <span className="pull-row-title">{pull.title}</span>
                  <small>
                    #{pull.number} · {pull.state}
                  </small>
                </button>
                <span className="pull-quick">
                  <IconButton
                    label={`${watching ? "Stop watching" : "Watch"} #${pull.number}`}
                    pressed={watching}
                    onClick={() => act(watching ? pullsApi.unwatch(thread.id, pull.number) : pullsApi.watch(thread.id, pull.number), watches.reload)}
                  >
                    {watching ? <BellOff size={14} aria-hidden /> : <Bell size={14} aria-hidden />}
                  </IconButton>
                  <IconButton label={`Unlink #${pull.number}`} onClick={() => act(pullsApi.unlink(thread.id, pull.number), linked.reload)}>
                    <Link2Off size={14} aria-hidden />
                  </IconButton>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="pull-form-actions">
        <Button small onClick={() => setLinking(true)}>
          Link a pull request
        </Button>
        <Button small onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
      {linking ? <LinkDialog thread={thread} onClose={() => setLinking(false)} onLinked={linked.reload} /> : null}
    </div>
  );
}
