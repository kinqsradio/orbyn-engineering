import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { toFailure } from "../../lib/useAsync";
import { navigate, routeHref, type Route } from "../../state/route";
import { useWorkspace } from "../../state/workspace";
import { Button, LinkButton } from "../../ui/controls";
import { Empty, Loading } from "../../ui/states";
import "./onboarding.css";

export function TrustFolder({ projectId, threadId }: { projectId: string; threadId: string | null }) {
  const project = useWorkspace((state) => state.projects.data?.find((p) => p.id === projectId));
  const loaded = useWorkspace((state) => state.projects.data !== null);
  const putProject = useWorkspace((state) => state.putProject);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next: Route = threadId
    ? { name: "thread", id: threadId }
    : { name: "new", projectId };
  const leave: Route = threadId ? { name: "thread", id: threadId } : { name: "home" };

  useEffect(() => {
    if (project?.trusted) navigate(next);
    // `next` is derived from the props in this effect's identity.
  }, [project?.trusted, projectId, threadId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) {
    return (
      <div className="page page-narrow">
        {loaded ? <Empty title="Project not found" /> : <Loading label="Loading project" />}
      </div>
    );
  }

  const trust = async () => {
    setBusy(true);
    setError(null);
    try {
      putProject(await api.trustProject(project.id));
    } catch (failure) {
      setError(`Couldn't trust this folder. ${toFailure(failure).message}`);
      setBusy(false);
    }
  };

  return (
    <div className="trust">
      <div className="trust-card" role="group" aria-labelledby="trust-title">
        <h1 id="trust-title" tabIndex={-1} data-page-title>
          Trust {project.name}?
        </h1>
        <p>Agents can read files, run commands and edit code in this folder. Only trust folders you know.</p>
        <dl className="trust-facts">
          <div>
            <dt>Path</dt>
            <dd>
              <code className="trust-path">{homeRelative(project.path)}</code>
            </dd>
          </div>
        </dl>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="trust-actions">
          <LinkButton href={routeHref(leave)}>Don’t trust</LinkButton>
          <Button tone="primary" busy={busy} onClick={() => void trust()}>
            Trust folder
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The folder as the person writes it: the home directory shortened to ~. */
export function homeRelative(path: string): string {
  return path.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}
