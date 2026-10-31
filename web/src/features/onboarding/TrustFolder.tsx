import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { toFailure } from "../../lib/useAsync";
import { navigate, routeHref, type Route } from "../../state/route";
import { useWorkspace } from "../../state/workspace";
import { Button, LinkButton } from "../../ui/controls";
import { Empty, Loading, PageHeader } from "../../ui/states";

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
    <div className="page page-narrow">
      <PageHeader title="Trust this folder?" back={leave} backLabel={threadId ? "Back to thread" : "Threads"} />
      <code className="trust-path">{project.path}</code>
      <div className="trust-copy">
        <p>
          Engines run real commands here. They can execute this repository's hooks and load its
          configuration, including MCP servers, without asking again.
        </p>
        <p>Only trust folders whose contents you know. Nothing runs until you do.</p>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <Button tone="primary" busy={busy} icon={<ShieldCheck size={16} aria-hidden />} onClick={() => void trust()}>
          Trust folder
        </Button>
        <LinkButton href={routeHref(leave)}>Not now</LinkButton>
      </div>
    </div>
  );
}
