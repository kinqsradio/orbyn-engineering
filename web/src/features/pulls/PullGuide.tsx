import { MessageSquare, Sparkles } from "lucide-react";
import { useState } from "react";
import type { PullGuide as Guide } from "../../api/types";
import { relativeTime } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { navigate } from "../../state/route";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { Markdown } from "../thread/Markdown";
import { pullsApi } from "./pullsApi";

/** The guide names a commit, and the pull request has moved past it. */
export const guideIsStale = (guide: Guide, headSha: string | null | undefined) =>
  Boolean(guide.head_sha && headSha && !headSha.toLowerCase().startsWith(guide.head_sha));

/** The review guide: the stops an agent wrote, in reading order. */
export function PullGuide({ projectId, number, headSha }: { projectId: string; number: number; headSha?: string | null }) {
  const state = useAsync(`pull-guide:${projectId}:${number}`, (signal) => pullsApi.guide(projectId, number, signal));
  const engines = useWorkspace((store) => store.engines.data);
  const refreshAll = useWorkspace((store) => store.refreshAll);
  const pushToast = useUi((store) => store.pushToast);
  const setDraft = useUi((store) => store.setDraft);
  const [busy, setBusy] = useState(false);
  const engine = engines?.find((entry) => entry.installed)?.id;

  if (state.status === "loading") return <Loading label="Loading the review guide" rows={3} />;
  if (state.status === "error") {
    return <ErrorState title="Couldn't load the review guide" failure={state.error} onRetry={state.reload} />;
  }
  const { enabled, guide } = state.data;

  const write = async () => {
    if (!engine) {
      pushToast("Install an engine first.");
      return;
    }
    setBusy(true);
    try {
      const thread = await pullsApi.writeGuide(projectId, number, engine);
      await refreshAll();
      navigate({ name: "thread", id: thread.id });
    } catch (failure) {
      pushToast(`Couldn't start the guide. ${toFailure(failure).message}`);
    } finally {
      setBusy(false);
    }
  };
  const ask = async (stop: number) => {
    if (!engine) {
      pushToast("Install an engine first.");
      return;
    }
    try {
      const asked = await pullsApi.askAboutStop(projectId, number, engine, stop);
      setDraft(asked.thread.id, asked.draft);
      await refreshAll();
      navigate({ name: "thread", id: asked.thread.id });
    } catch (failure) {
      pushToast(`Couldn't open a thread. ${toFailure(failure).message}`);
    }
  };
  const writeButton = enabled ? (
    <Button small busy={busy} icon={<Sparkles size={14} aria-hidden />} onClick={() => void write()}>
      {guide ? "Rewrite guide" : "Write a guide"}
    </Button>
  ) : null;

  if (!guide) {
    return (
      <Empty title="No review guide yet">
        <p>
          {enabled
            ? "An agent reads the change and writes the stops a reviewer should take. You approve its write in the thread."
            : "Review guides are off for this project. Turn them on in Settings, Diffs & pull requests."}
        </p>
        {writeButton}
      </Empty>
    );
  }
  return (
    <section className="pull-guide" aria-label="Review guide">
      <header className="pull-guide-head">
        <small className="muted">
          {guide.stops.length} {guide.stops.length === 1 ? "stop" : "stops"} · written {relativeTime(guide.written_at)}
          {guide.head_sha ? ` for ${guide.head_sha.slice(0, 7)}` : ""}
        </small>
        {writeButton}
      </header>
      {guideIsStale(guide, headSha) ? (
        <p className="pull-guide-stale" role="status">
          The pull request has commits this guide does not cover.
        </p>
      ) : null}
      <ol className="pull-guide-stops">
        {guide.stops.map((stop, index) => (
          <li key={index} className="pull-guide-stop">
            <h3>{stop.title}</h3>
            {stop.summary ? <Markdown text={stop.summary} projectId={projectId} remoteImages="link" /> : null}
            {stop.files.length > 0 ? (
              <ul className="pull-guide-files" aria-label="Files">
                {stop.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                    {file.note ? <span className="muted"> {file.note}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {stop.questions.length > 0 ? (
              <ul className="pull-guide-questions" aria-label="Questions">
                {stop.questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            ) : null}
            <div className="pull-guide-stop-actions">
              <Button
                small
                icon={<MessageSquare size={14} aria-hidden />}
                aria-label={`Ask about ${stop.title}`}
                onClick={() => void ask(index)}
              >
                Ask about this stop
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
