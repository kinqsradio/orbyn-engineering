import { create } from "zustand";
import { api } from "../../api/client";
import type { CloneJob, Project } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Button } from "../../ui/controls";

const POLL_MS = 1000;

interface Tracked {
  job: CloneJob;
  onDone(project: Project): void;
}

const useClones = create<{ tracked: Tracked[] }>(() => ({ tracked: [] }));

const put = (tracked: Tracked[]) => useClones.setState({ tracked });
const running = () => useClones.getState().tracked.some(({ job }) => job.state === "running");
const fail = (cause: unknown) => useUi.getState().pushToast(toFailure(cause).message);

function take(jobs: CloneJob[]) {
  const kept: Tracked[] = [];
  for (const entry of useClones.getState().tracked) {
    const job = jobs.find((candidate) => candidate.id === entry.job.id);
    if (job?.state === "done" && job.project) entry.onDone(job.project);
    else if (job && job.state !== "done" && job.state !== "cancelled") kept.push({ ...entry, job });
  }
  put(kept);
}

let polling = false;

async function follow() {
  if (polling) return;
  polling = true;
  while (running()) {
    await new Promise((done) => setTimeout(done, POLL_MS));
    const jobs = await api.clones().catch(() => null);
    if (jobs) take(jobs);
  }
  polling = false;
}

/** A clone runs in the background and lands wherever the person is by then. */
export function trackClone(job: CloneJob, onDone: (project: Project) => void) {
  put([...useClones.getState().tracked, { job, onDone }]);
  void follow();
}

const retry = async (id: string) => {
  try {
    const job = await api.retryClone(id);
    put(useClones.getState().tracked.map((entry) => (entry.job.id === id ? { ...entry, job } : entry)));
    void follow();
  } catch (cause) {
    fail(cause);
  }
};

const dismiss = (id: string) => put(useClones.getState().tracked.filter((entry) => entry.job.id !== id));

/** What is cloning or stopped short, with the way forward. Stays until it is settled. */
export function CloneJobs() {
  const tracked = useClones((state) => state.tracked);
  if (tracked.length === 0) return null;
  return (
    <div className="clone-jobs" role="group" aria-label="Project clones">
      {tracked.map(({ job }) => (
        <div key={job.id} className="toast clone-job">
          {job.state === "running" ? (
            <>
              <span className="clone-job-text">Cloning {job.name ?? job.url}</span>
              <Button small onClick={() => void api.cancelClone(job.id).catch(fail)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <span className="clone-job-text">
                <strong>Clone failed</strong>
                {job.error ? ` ${job.error}` : null}
              </span>
              <Button small onClick={() => void retry(job.id)}>
                Retry
              </Button>
              <Button small onClick={() => dismiss(job.id)}>
                Dismiss
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
