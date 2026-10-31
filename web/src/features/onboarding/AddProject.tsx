import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { ImportReport, Project } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import { navigate } from "../../state/route";
import { useWorkspace } from "../../state/workspace";
import { Button, Field } from "../../ui/controls";
import { PageHeader } from "../../ui/states";
import { FolderBrowser } from "./FolderBrowser";

type AddRoute = "clone" | "create" | "import";

const ROUTES: { id: AddRoute; label: string }[] = [
  { id: "clone", label: "Clone from URL" },
  { id: "create", label: "Create new" },
  { id: "import", label: "Import local folder" },
];

function useFinish() {
  const putProject = useWorkspace((state) => state.putProject);
  const refreshThreads = useWorkspace((state) => state.refreshThreads);
  const refreshManaged = useWorkspace((state) => state.refreshManaged);
  return (project: Project) => {
    putProject(project);
    void refreshThreads(project.id);
    void refreshManaged();
    navigate(
      project.trusted
        ? { name: "new", projectId: project.id }
        : { name: "trust", projectId: project.id, threadId: null },
    );
  };
}

function CloneForm() {
  const finish = useFinish();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      finish(await api.cloneProject(url.trim()));
    } catch (failure) {
      setError(`Couldn't clone it. ${toFailure(failure).message}`);
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={(event) => void submit(event)}>
      <Field label="Repository URL" hint="Cloned into the managed workspace." error={error}>
        {(props) => (
          <input
            {...props}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/team/repo.git"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        )}
      </Field>
      <div className="form-actions">
        <Button type="submit" tone="primary" busy={busy} disabled={!url.trim()}>
          {error ? "Retry clone" : "Clone project"}
        </Button>
      </div>
    </form>
  );
}

function CreateForm() {
  const finish = useFinish();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      finish(await api.createProject(name.trim()));
    } catch (failure) {
      setError(`Couldn't create it. ${toFailure(failure).message}`);
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={(event) => void submit(event)}>
      <Field label="Project name" hint="Creates a new Git repository in the managed workspace." error={error}>
        {(props) => (
          <input {...props} value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} />
        )}
      </Field>
      <div className="form-actions">
        <Button type="submit" tone="primary" busy={busy} disabled={!name.trim()}>
          Create project
        </Button>
      </div>
    </form>
  );
}

function ImportResult({ report, onContinue }: { report: ImportReport; onContinue(): void }) {
  const left = report.dirty_files.length + report.unpushed_branches.length;
  return (
    <section className="import-review" aria-label="Import result">
      <p>
        Imported {report.project.name}. The original folder stayed untouched, and Orbyn works from
        a new checkout.
      </p>
      {left === 0 ? (
        <p className="muted">Everything was committed and pushed, so nothing was left behind.</p>
      ) : (
        <>
          <h3>Not carried over</h3>
          {report.dirty_files.length > 0 ? (
            <div>
              <p className="muted">
                {report.dirty_files.length === 1
                  ? "1 uncommitted file"
                  : `${report.dirty_files.length} uncommitted files`}
              </p>
              <ul className="plain-list">
                {report.dirty_files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {report.unpushed_branches.length > 0 ? (
            <div>
              <p className="muted">
                {report.unpushed_branches.length === 1
                  ? "1 unpushed branch"
                  : `${report.unpushed_branches.length} unpushed branches`}
              </p>
              <ul className="plain-list">
                {report.unpushed_branches.map((branch) => (
                  <li key={branch}>
                    <code>{branch}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      <div className="form-actions">
        <Button tone="primary" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </section>
  );
}

function ImportForm() {
  const finish = useFinish();
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.importProject(path));
    } catch (failure) {
      setError(`Couldn't import it. ${toFailure(failure).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (report) return <ImportResult report={report} onContinue={() => finish(report.project)} />;
  return (
    <>
      <p className="muted">
        Makes a new checkout from committed work. The original folder stays untouched, and
        uncommitted files and unpushed branches aren't carried over.
      </p>
      <FolderBrowser actionLabel="Import this folder" busy={busy} onChoose={(path) => void start(path)} />
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function AddProject() {
  const hasProjects = useWorkspace((state) => (state.projects.data?.length ?? 0) > 0);
  const [route, setRoute] = useState<AddRoute>("clone");

  return (
    <div className="page page-narrow">
      <PageHeader
        title={hasProjects ? "Add project" : "Add your first project"}
        back={hasProjects ? { name: "home" } : undefined}
        backLabel="Threads"
      />
      <div className="route-tabs" role="tablist" aria-label="How to add it">
        {ROUTES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={route === id}
            onClick={() => setRoute(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {route === "clone" ? <CloneForm /> : route === "create" ? <CreateForm /> : <ImportForm />}
    </div>
  );
}
