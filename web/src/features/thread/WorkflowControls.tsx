import { FileCode, Square } from "lucide-react";
import { createContext, useState } from "react";
import { api } from "../../api/client";
import { useAsync } from "../../lib/useAsync";
import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/controls";
import { CodeBlock } from "./CodeBlock";
import type { ReasoningItem, ToolItem, WorkflowState } from "./projection";

/** True inside a folded group whose workflow cards are drawn outside it. */
export const SurfacedWorkflows = createContext(false);

const STATE_LABEL: Record<WorkflowState, string> = {
  running: "Running",
  completed: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

function ScriptView({ threadId, callId }: { threadId: string; callId: string }) {
  const script = useAsync(`workflow-script:${threadId}:${callId}`, (signal) =>
    api.workflowScript(threadId, callId, signal),
  );
  if (script.error) return <p className="tool-empty">{script.error.message}</p>;
  if (!script.data) return <p className="tool-empty">Loading...</p>;
  return (
    <>
      {script.data.path ? <p className="workflow-path" title={script.data.path}>{script.data.path}</p> : null}
      <CodeBlock code={script.data.contents} lang="javascript" />
      {script.data.truncated ? <p className="tool-empty">Only the first 256 KiB is shown.</p> : null}
    </>
  );
}

/** A Claude Code workflow the tool call launched: its script, its state and Stop. */
export function WorkflowControls({ item, threadId, live }: { item: ToolItem; threadId: string | null; live: boolean }) {
  const [viewing, setViewing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflow = item.workflow;
  if (!workflow || !threadId) return null;
  const running = workflow.state === "running";
  const problem = error ?? workflow.stopError ?? null;
  const stop = () => {
    setStopping(true);
    setError(null);
    api.stopWorkflow(threadId, item.callId).then(
      () => undefined,
      (failure: unknown) => {
        setStopping(false);
        setError(failure instanceof Error ? failure.message : "The workflow did not stop.");
      },
    );
  };
  return (
    <div className="workflow-card" aria-label={`Workflow ${workflow.name ?? ""}`.trim()}>
      <span className="workflow-name">{workflow.name ?? "Workflow"}</span>
      <span className="workflow-state" data-state={workflow.state}>
        {running && stopping ? "Stopping" : STATE_LABEL[workflow.state]}
      </span>
      <Button small tone="quiet" icon={<FileCode size={14} aria-hidden />} onClick={() => setViewing(true)}>
        View script
      </Button>
      {running && live ? (
        <Button small tone="danger" busy={stopping} icon={<Square size={14} aria-hidden />} onClick={stop}>
          Stop workflow
        </Button>
      ) : null}
      {problem ? <p className="workflow-error" role="alert">{problem}</p> : null}
      {viewing ? (
        <Dialog title={`${workflow.name ?? "Workflow"} script`} onClose={() => setViewing(false)}>
          <ScriptView threadId={threadId} callId={item.callId} />
        </Dialog>
      ) : null}
    </div>
  );
}

/** The workflow cards of these calls, for calls that launched one. */
export function WorkflowCards({ items, threadId, live }: { items: (ToolItem | ReasoningItem)[]; threadId: string | null; live: boolean }) {
  const workflows = items.filter((item): item is ToolItem => item.kind === "tool" && item.workflow !== undefined);
  if (workflows.length === 0) return null;
  return (
    <>
      {workflows.map((item) => (
        <WorkflowControls key={item.key} item={item} threadId={threadId} live={live} />
      ))}
    </>
  );
}
