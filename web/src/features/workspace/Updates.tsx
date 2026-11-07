import { AlertCircle, Check, ChevronDown, ChevronRight, CircleDashed, Download, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import type { UpdateStatus } from "../../api/types";
import {
  appHasUpdate,
  engineHasUpdate,
  useWorkspace,
  type UpdateRun,
  type UpdateRunStep,
} from "../../state/workspace";
import { Button } from "../../ui/controls";
import { Markdown } from "../thread/Markdown";
import { Dialog } from "../../ui/Dialog";

const short = (value: string | null) =>
  value && /^[0-9a-f]{12,}$/.test(value) ? value.slice(0, 8) : (value ?? "Unknown");

/** Items a click can apply here. App counts only where the service can install it. */
export function availableCount(status: UpdateStatus): number {
  return (
    status.engines.filter(engineHasUpdate).length +
    (status.library.behind > 0 ? 1 : 0) +
    (appHasUpdate(status) && status.app.can_apply ? 1 : 0)
  );
}

/** The server's reason nothing can run now. A server's manual note isn't one. */
export function updateBlock(status: UpdateStatus): string | null {
  const reasons = [
    ...status.engines.filter(engineHasUpdate).map((engine) => engine.blocked_reason),
    status.library.behind > 0 ? status.library.blocked_reason : null,
    status.app.mode === "desktop" && appHasUpdate(status) ? status.app.blocked_reason : null,
  ];
  return reasons.find((reason) => reason !== null) ?? null;
}

function Versions({ current, latest }: { current: string | null; latest: string | null }) {
  return (
    <span className="update-versions">
      {short(current)} → {short(latest)}
    </span>
  );
}

function Steps({ steps }: { steps: UpdateRunStep[] }) {
  return (
    <ol className="update-steps" aria-label="Update progress">
      {steps.map((step) => (
        <li key={step.target} data-state={step.state}>
          {step.state === "done" ? (
            <Check size={16} aria-hidden />
          ) : step.state === "failed" ? (
            <AlertCircle size={16} aria-hidden />
          ) : step.state === "running" ? (
            <Loader2 size={16} className="spin" aria-hidden />
          ) : (
            <CircleDashed size={16} aria-hidden />
          )}
          <div>
            {step.label}
            <span className="sr-only"> ({step.state})</span>
            {step.error ? <p className="field-error">{step.error}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** "What's new" for a row that has an update; the notes are shown only where the service sends them. */
function WhatsNew({ id, open, onToggle }: { id: string; open: boolean; onToggle(): void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button type="button" className="update-whatsnew" aria-expanded={open} aria-controls={id} onClick={onToggle}>
      <Chevron size={12} aria-hidden />
      What’s new
    </button>
  );
}

const failedStep = (run: UpdateRun | null) => run?.steps.find((step) => step.state === "failed") ?? null;

export function UpdateEverythingDialog({ onClose }: { onClose(): void }) {
  const status = useWorkspace((state) => state.updates.data);
  const run = useWorkspace((state) => state.updateRun);
  const engineList = useWorkspace((state) => state.engines.data);
  const runAllUpdates = useWorkspace((state) => state.runAllUpdates);
  const [expanded, setExpanded] = useState<string | null>(null);
  const notesId = useId();

  if (!status) return null;
  const applying = run?.running === true;
  const failed = failedStep(run);
  const blocked = updateBlock(status);
  const locked = blocked !== null || applying;
  const count = availableCount(status);
  const engines = status.engines.filter(engineHasUpdate);
  const appAvailable = appHasUpdate(status);

  const incoming = status.library.behind > 0 ? status.library.incoming : [];
  const appNotes = appAvailable ? (status.app.notes?.trim() ?? "") : "";
  const hasNotes = (key: string) => (key === "app" ? appNotes !== "" : key === "library" ? incoming.length > 0 : false);

  const rows: { key: string; name: string; current: string | null; latest: string | null; kind: string }[] = [
    ...(appAvailable
      ? [{ key: "app", name: "Orbyn Engineering", current: status.app.current, latest: status.app.latest, kind: "Restarts the app" }]
      : []),
    ...engines.map((engine) => ({
      key: engine.id,
      name: engineList?.find((e) => e.id === engine.id)?.name ?? engine.id,
      current: engine.current,
      latest: engine.latest,
      kind: "CLI",
    })),
    // The row is always there once the library has a version: the change, or that it is current.
    ...(status.library.current
      ? [
          {
            key: "library",
            name: "Skills library",
            current: status.library.current,
            latest: status.library.behind > 0 ? status.library.latest : null,
            kind: "Library",
          },
        ]
      : []),
  ];

  return (
    <Dialog
      title="Update everything"
      onClose={onClose}
      className="update-dialog"
      footer={
        <>
          <Button onClick={onClose}>Not now</Button>
          <Button
            tone="primary"
            busy={applying}
            disabled={locked || (count === 0 && !failed)}
            onClick={() => void runAllUpdates()}
          >
            {failed ? "Retry" : "Update everything"}
          </Button>
        </>
      }
    >
      <p className="update-intro">
        Updates install one at a time; a running agent keeps going and picks up its CLI next turn.
      </p>
      {blocked ? <p className="update-reason">{blocked}</p> : null}
      {run ? <Steps steps={run.steps} /> : null}
      {run?.error ? (
        <p className="field-error" role="alert">
          {run.error}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <div className="update-table" role="list">
          {rows.map((row) => (
            <div key={row.key} role="listitem" className="update-row">
              <div className="update-item">
                <span>
                  <b className="update-name">{row.name}</b>
                  <br />
                  {row.latest === null && row.key === "library" ? (
                    <span className="update-versions">{short(row.current)} · Up to date</span>
                  ) : (
                    <Versions current={row.current} latest={row.latest} />
                  )}
                  {hasNotes(row.key) ? (
                    <>
                      <br />
                      <WhatsNew
                        id={`${notesId}-${row.key}`}
                        open={expanded === row.key}
                        onToggle={() => setExpanded(expanded === row.key ? null : row.key)}
                      />
                    </>
                  ) : null}
                </span>
                <span className="update-kind">{row.kind}</span>
              </div>
              {expanded === row.key && hasNotes(row.key) ? (
                <div id={`${notesId}-${row.key}`} className="update-notes">
                  {row.key === "library" ? (
                    <>
                      <b>
                        {incoming.length} new {incoming.length === 1 ? "change" : "changes"}
                      </b>
                      <ul>
                        {incoming.map((commit) => (
                          <li key={commit.sha}>
                            <span className="mono">{commit.sha.slice(0, 7)}</span> {commit.subject}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <Markdown text={appNotes} />
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {status.app.mode === "server" && appAvailable && status.app.blocked_reason ? (
        <p className="update-reason">{status.app.blocked_reason}</p>
      ) : null}
      {count === 0 && !run && !appAvailable ? <p>Everything is up to date.</p> : null}
    </Dialog>
  );
}

/** Appears only when there's something to do, and carries progress and failure. */
export function UpdatePill() {
  const status = useWorkspace((state) => state.updates.data);
  const run = useWorkspace((state) => state.updateRun);
  const [open, setOpen] = useState(false);
  if (!status) return null;
  const count = availableCount(status);
  const failed = failedStep(run);
  const manualOnly = count === 0 && appHasUpdate(status);
  if (count === 0 && !run && !manualOnly) return null;

  const steps = run?.steps ?? [];
  const done = steps.filter((step) => step.state === "done").length;
  return (
    <>
      {failed ? (
        <button type="button" className="update-pill" data-failed onClick={() => setOpen(true)}>
          <AlertCircle size={14} aria-hidden />
          Update failed
        </button>
      ) : run?.running ? (
        <button type="button" className="update-pill" onClick={() => setOpen(true)}>
          <Loader2 size={14} className="spin" aria-hidden />
          Updating {done + 1}/{steps.length}
        </button>
      ) : (
        <button type="button" className="update-pill" onClick={() => setOpen(true)}>
          <Download size={13} aria-hidden />
          Updates available{count > 0 ? ` · ${count}` : ""}
        </button>
      )}
      {open ? <UpdateEverythingDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
