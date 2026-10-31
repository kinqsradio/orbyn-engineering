import { ArrowUp, Folder, GitBranch } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { toFailure, useAsync } from "../../lib/useAsync";
import { navigate } from "../../state/route";
import { useWorkspace } from "../../state/workspace";
import { Button, Field } from "../../ui/controls";
import { Empty, ErrorState, Loading, PageHeader } from "../../ui/states";

export function AddProject() {
  const [path, setPath] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const putProject = useWorkspace((state) => state.putProject);
  const refreshThreads = useWorkspace((state) => state.refreshThreads);
  const hasProjects = useWorkspace((state) => (state.projects.data?.length ?? 0) > 0);
  const listing = useAsync(`browse:${path ?? ""}`, (signal) => api.browse(path, signal));

  const current = listing.data?.path ?? path;

  const add = async (folder: string) => {
    setAdding(true);
    setError(null);
    try {
      const project = await api.addProject(folder);
      putProject(project);
      void refreshThreads(project.id);
      navigate(
        project.trusted
          ? { name: "new", projectId: project.id }
          : { name: "trust", projectId: project.id, threadId: null },
      );
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="page page-narrow">
      <PageHeader
        title={hasProjects ? "Add project" : "Add your first project"}
        back={hasProjects ? { name: "home" } : undefined}
        backLabel="Threads"
      />
      <p className="lede">Choose the folder an engine should work in.</p>

      <div className="browser">
        <div className="browser-bar">
          <Button
            small
            icon={<ArrowUp size={16} aria-hidden />}
            disabled={!listing.data?.parent}
            onClick={() => setPath(listing.data?.parent ?? null)}
          >
            Up
          </Button>
          <code className="browser-path" title={current ?? undefined}>
            {current ?? "Loading…"}
          </code>
        </div>
        {listing.status === "loading" ? (
          <Loading label="Loading folders" rows={4} />
        ) : listing.status === "error" ? (
          <ErrorState compact title="Couldn't read this folder" failure={listing.error} onRetry={listing.reload} />
        ) : listing.data.entries.length === 0 ? (
          <Empty title="No folders here" />
        ) : (
          <ul className="browser-list">
            {listing.data.entries.map((entry) => (
              <li key={entry.path}>
                <button type="button" onClick={() => setPath(entry.path)}>
                  {entry.is_git ? <GitBranch size={16} aria-hidden /> : <Folder size={16} aria-hidden />}
                  <span>{entry.name}</span>
                  {entry.is_git ? <span className="row-meta">Git repository</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="browser-foot">
          <Button
            tone="primary"
            busy={adding}
            disabled={!listing.data}
            onClick={() => {
              if (listing.data) void add(listing.data.path);
            }}
          >
            Use this folder
          </Button>
        </div>
      </div>

      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (manual.trim()) void add(manual.trim());
        }}
      >
        <Field label="Or enter a path" error={error}>
          {(props) => (
            <input
              {...props}
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              placeholder="/path/to/project"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          )}
        </Field>
        <Button type="submit" disabled={!manual.trim() || adding}>
          Add path
        </Button>
      </form>
    </div>
  );
}
