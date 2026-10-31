import { useState } from "react";
import type { Thread } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Button } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { PullDetail } from "../pulls/PullDetail";
import { pullsApi } from "../pulls/pullsApi";

/** The pull requests linked to this thread, and one at a time in detail. */
export function LinkedPulls({ thread }: { thread: Thread }) {
  const linked = useAsync(`linked-pulls:${thread.id}`, (signal) => pullsApi.linked(thread.id, signal));
  const [selected, setSelected] = useState<number | null>(null);
  const pushToast = useUi((state) => state.pushToast);
  const refresh = async () => {
    try {
      linked.setData(await pullsApi.refreshLinked(thread.id));
    } catch (failure) {
      pushToast(`Couldn't refresh. ${toFailure(failure).message}`);
    }
  };
  if (selected !== null) {
    return <PullDetail projectId={thread.project_id} number={selected} onClose={() => setSelected(null)} />;
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
          {linked.data.map((pull) => (
            <li key={pull.number}>
              <button type="button" onClick={() => setSelected(pull.number)}>
                <span className="pull-row-title">{pull.title}</span>
                <small>
                  #{pull.number} · {pull.state}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button small onClick={() => void refresh()}>
        Refresh
      </Button>
    </div>
  );
}
