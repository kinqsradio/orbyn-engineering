import { AlertCircle, ArrowUp, Check, CircleDashed, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { UpdateStatus, UpdateStep } from "../../api/updates";
import { toFailure } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { Button, IconButton } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { Markdown } from "../thread/Markdown";

const PROGRESS_POLL_MS = 1000;

const short = (value: string | null) =>
  value && /^[0-9a-f]{12,}$/.test(value) ? value.slice(0, 8) : (value ?? "Unknown");

export const isApplying = (status: UpdateStatus) =>
  status.progress?.some((step) => step.state === "running" || step.state === "pending") === true &&
  !status.progress.some((step) => step.state === "failed");

export const failedStep = (status: UpdateStatus): UpdateStep | null =>
  status.progress?.find((step) => step.state === "failed") ?? null;

/** Applied one click at a time: the server applies nothing on its own. */
export function availableCount(status: UpdateStatus): number {
  return (
    status.engines.filter((engine) => engine.available).length +
    (status.library?.available ? 1 : 0) +
    (status.app?.available && status.app.can_apply ? 1 : 0)
  );
}

/** Why nothing can be applied right now; null when it can. */
export function updateBlock(status: UpdateStatus): string | null {
  if (status.active_runs > 0) {
    return status.active_runs === 1
      ? "1 run is active. Wait for it to finish or cancel it."
      : `${status.active_runs} runs are active. Wait for them to finish or cancel them.`;
  }
  if (status.library?.modified) return "The library has local changes. Commit or discard them first.";
  return null;
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

function Steps({ steps }: { steps: UpdateStep[] }) {
  return (
    <ol className="update-steps" aria-label="Update progress">
      {steps.map((step) => (
        <li key={step.id} data-state={step.state}>
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

export function UpdateEverythingDialog({ onClose }: { onClose(): void }) {
  const status = useWorkspace((state) => state.updates.data);
  const refreshUpdates = useWorkspace((state) => state.refreshUpdates);
  const refreshEngines = useWorkspace((state) => state.refreshEngines);
  const refreshManaged = useWorkspace((state) => state.refreshManaged);
  const putUpdates = useWorkspace((state) => state.putUpdates);
  const putManaged = useWorkspace((state) => state.putManaged);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const applying = status ? isApplying(status) : false;

  useEffect(() => {
    if (!applying) return;
    const timer = setInterval(() => void refreshUpdates(), PROGRESS_POLL_MS);
    return () => {
      clearInterval(timer);
      void refreshEngines();
      void refreshManaged();
    };
  }, [applying, refreshUpdates, refreshEngines, refreshManaged]);

  if (!status) return null;
  const failed = failedStep(status);
  const blocked = updateBlock(status);
  const locked = blocked !== null || applying || starting;
  const count = availableCount(status);
  const engines = status.engines.filter((engine) => engine.available);

  const applyAll = async () => {
    setStarting(true);
    setError(null);
    try {
      putUpdates(await api.applyAllUpdates());
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog
      title="Update everything"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            tone="primary"
            busy={starting || applying}
            disabled={locked || (count === 0 && !failed)}
            onClick={() => void applyAll()}
          >
            {failed ? "Retry" : "Update all"}
          </Button>
        </>
      }
    >
      {blocked ? <p className="update-reason">{blocked}</p> : null}
      {status.progress ? <Steps steps={status.progress} /> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {engines.length > 0 ? (
        <section className="update-group">
          <h3>Engines</h3>
          {engines.map((engine) => (
            <div key={engine.id} className="update-item">
              <span className="update-name">{engine.name}</span>
              <Versions current={engine.current} latest={engine.latest} />
              <ItemButton
                label={engine.name}
                disabled={locked}
                onApply={async () => {
                  await api.updateEngine(engine.id);
                  await Promise.all([refreshUpdates(), refreshEngines()]);
                }}
              />
            </div>
          ))}
        </section>
      ) : null}
      {status.library?.available ? (
        <section className="update-group">
          <h3>Skills library</h3>
          <div className="update-item">
            <span className="update-name">Library</span>
            <Versions current={status.library.current} latest={status.library.latest} />
            <ItemButton
              label="skills library"
              disabled={locked}
              onApply={async () => {
                putManaged(await api.updateWorkspace());
                await refreshUpdates();
              }}
            />
          </div>
          <ul className="commit-list">
            {status.library.incoming.map((commit) => (
              <li key={commit.revision}>
                <code>{short(commit.revision)}</code>
                <span>{commit.subject}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {status.app?.available ? (
        <section className="update-group">
          <h3>App</h3>
          <div className="update-item">
            <span className="update-name">Orbyn Engineering</span>
            <Versions current={status.app.current} latest={status.app.latest} />
            {status.app.can_apply ? (
              <ItemButton
                label="app"
                disabled={locked}
                onApply={async () => putUpdates(await api.applyAppUpdate())}
              />
            ) : null}
          </div>
          {status.app.notes ? (
            <div className="update-notes">
              <Markdown text={status.app.notes} />
            </div>
          ) : null}
          {status.app.manual_hint ? <p className="muted">{status.app.manual_hint}</p> : null}
        </section>
      ) : null}
      {count === 0 && !status.progress && !status.app?.available ? <p>Everything is up to date.</p> : null}
    </Dialog>
  );
}

/** Appears only when there's something to do, and carries progress and failure. */
export function UpdatePill() {
  const status = useWorkspace((state) => state.updates.data);
  const [open, setOpen] = useState(false);
  if (!status?.configured) return null;
  const count = availableCount(status);
  const failed = failedStep(status);
  const applying = isApplying(status);
  const manualOnly = count === 0 && status.app?.available === true;
  if (count === 0 && !failed && !applying && !manualOnly) return null;

  const steps = status.progress ?? [];
  const done = steps.filter((step) => step.state === "done").length;
  return (
    <>
      {failed ? (
        <button type="button" className="update-pill" data-failed onClick={() => setOpen(true)}>
          <AlertCircle size={14} aria-hidden />
          Update failed
        </button>
      ) : applying ? (
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
