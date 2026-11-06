import { ArrowLeft, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useLayoutWidth } from "../../lib/useLayout";
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
  const narrow = useLayoutWidth() === "narrow";
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
        <header>
          {narrow || threadId ? (
            <a className="trust-back" href={routeHref(leave)}>
              <ArrowLeft size={14} aria-hidden />
              {threadId ? "Back to thread" : "Threads"}
            </a>
          ) : null}
          <h1 id="trust-title" tabIndex={-1} data-page-title>
            Trust this folder?
          </h1>
        </header>
        <p>
          Engines run real commands here. They can execute this repository's hooks and load its configuration, including
          MCP servers, without asking again. Only trust folders whose contents you know.
        </p>
        <dl className="trust-facts">
          <div>
            <dt>Folder</dt>
            <dd>{project.name}</dd>
          </div>
          <div>
            <dt>Path</dt>
            <dd>
              <code className="trust-path">{project.path}</code>
            </dd>
          </div>
        </dl>
        <p>Nothing runs until you do.</p>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="trust-actions">
          <LinkButton href={routeHref(leave)}>Not now</LinkButton>
          <Button tone="primary" busy={busy} icon={<ShieldCheck size={16} aria-hidden />} onClick={() => void trust()}>
            Trust folder
          </Button>
        </div>
      </div>
    </div>
  );
}
