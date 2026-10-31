import { AlertCircle, ArrowUp, Check, CircleDashed, Loader2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { UpdateStatus } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import {
  appHasUpdate,
  engineHasUpdate,
  useWorkspace,
  type UpdateRun,
  type UpdateRunStep,
} from "../../state/workspace";
import { Button, IconButton } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { Markdown } from "../thread/Markdown";

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

function ItemButton({
  label,
  disabled,
  onApply,
}: {
  label: string;
  disabled: boolean;
  onApply(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        small
        aria-label={`Update ${label}`}
        busy={busy}
        disabled={disabled}
        onClick={() => {
          setBusy(true);
          setError(null);
          onApply()
            .catch((failure: unknown) => setError(toFailure(failure).message))
            .finally(() => setBusy(false));
        }}
      >
        Update
      </Button>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
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

const failedStep = (run: UpdateRun | null) => run?.steps.find((step) => step.state === "failed") ?? null;

export function UpdateEverythingDialog({ onClose }: { onClose(): void }) {
  const status = useWorkspace((state) => state.updates.data);
  const run = useWorkspace((state) => state.updateRun);
  const engineList = useWorkspace((state) => state.engines.data);
  const runAllUpdates = useWorkspace((state) => state.runAllUpdates);
  const refreshUpdates = useWorkspace((state) => state.refreshUpdates);
  const refreshEngines = useWorkspace((state) => state.refreshEngines);
  const refreshManaged = useWorkspace((state) => state.refreshManaged);

  if (!status) return null;
  const applying = run?.running === true;
  const failed = failedStep(run);
  const blocked = updateBlock(status);
  const locked = blocked !== null || applying;
  const count = availableCount(status);
  const engines = status.engines.filter(engineHasUpdate);
  const appAvailable = appHasUpdate(status);

  return (
    <Dialog
      title="Update everything"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            tone="primary"
            busy={applying}
            disabled={locked || (count === 0 && !failed)}
            onClick={() => void runAllUpdates()}
          >
            {failed ? "Retry" : "Update all"}
          </Button>
        </>
      }
    >
      {blocked ? <p className="update-reason">{blocked}</p> : null}
      {run ? <Steps steps={run.steps} /> : null}
      {run?.error ? (
        <p className="field-error" role="alert">
          {run.error}
        </p>
      ) : null}
      {engines.length > 0 ? (
        <section className="update-group">
          <h3>Engines</h3>
          {engines.map((engine) => {
            const name = engineList?.find((e) => e.id === engine.id)?.name ?? engine.id;
            return (
              <div key={engine.id} className="update-item">
                <span className="update-name">{name}</span>
                <Versions current={engine.current} latest={engine.latest} />
                {engine.can_apply ? (
                  <ItemButton
                    label={name}
                    disabled={locked}
                    onApply={async () => {
                      await api.updateEngine(engine.id);
                      await Promise.all([refreshUpdates(), refreshEngines()]);
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}
      {status.library.behind > 0 ? (
        <section className="update-group">
          <h3>Skills library</h3>
          <div className="update-item">
            <span className="update-name">Library</span>
            <Versions current={status.library.current} latest={status.library.latest} />
            <ItemButton
              label="skills library"
              disabled={locked || !status.library.can_apply}
              onApply={async () => {
                await api.updateLibrary(true);
                await Promise.all([refreshUpdates(), refreshManaged()]);
              }}
            />
          </div>
          <ul className="commit-list">
            {status.library.incoming.map((commit) => (
              <li key={commit.sha}>
                <code>{short(commit.sha)}</code>
                <span>{commit.subject}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {appAvailable ? (
        <section className="update-group">
          <h3>App</h3>
          <div className="update-item">
            <span className="update-name">Orbyn Engineering</span>
            <Versions current={status.app.current} latest={status.app.latest} />
            {status.app.can_apply ? (
              <ItemButton
                label="app"
                disabled={locked}
                onApply={async () => {
                  await api.applyAppUpdate();
                  await refreshUpdates();
                }}
              />
            ) : null}
          </div>
          {status.app.notes ? (
            <div className="update-notes">
              <Markdown text={status.app.notes} />
            </div>
          ) : null}
          {status.app.mode === "server" && status.app.blocked_reason ? (
            <p className="muted">{status.app.blocked_reason}</p>
          ) : null}
        </section>
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
        <IconButton
          className="update-btn"
          label={count === 1 ? "1 update available" : `${count} updates available`}
          onClick={() => setOpen(true)}
        >
          <ArrowUp size={14} aria-hidden />
        </IconButton>
      )}
      {open ? <UpdateEverythingDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
