import { ArrowUp, Bot, Folder, GitBranch } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { EngineStatus, Project } from "../../api/types";
import { slugify } from "../../lib/format";
import { toFailure } from "../../lib/useAsync";
import { navigate, routeHref } from "../../state/route";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { EngineGlyph } from "../../ui/badges";
import { LinkButton } from "../../ui/controls";
import { Menu } from "../../ui/Menu";
import { Empty, Loading } from "../../ui/states";

type OpenMenu = { kind: "project" | "engine" | "checkout"; x: number; y: number };

const selectableEngines = (engines: EngineStatus[]) => engines.filter((engine) => engine.installed);

/** The default screen: a composer for a thread that doesn't exist until you send. */
export function DraftView({ projectId }: { projectId: string | null }) {
  const projects = useWorkspace((state) => state.projects.data);
  const engines = useWorkspace((state) => state.engines.data);
  const putThread = useWorkspace((state) => state.putThread);
  const addPrompt = useThreadLogs((state) => state.addPrompt);
  const field = useRef<HTMLTextAreaElement>(null);
  const [chosenProject, setChosenProject] = useState(projectId);
  const [chosenEngine, setChosenEngine] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [worktree, setWorktree] = useState<string | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    field.current?.focus();
  }, []);

  if (!projects || !engines) return <div className="page"><Loading label="Loading" rows={3} /></div>;
  const project: Project | null =
    projects.find((p) => p.id === chosenProject) ??
    projects.find((p) => p.name !== "Skills library") ??
    projects[0] ??
    null;
  const engine =
    engines.find((e) => e.id === chosenEngine) ??
    engines.find((e) => e.installed && e.capabilities.managed) ??
    engines.find((e) => e.installed) ??
    null;

  if (!project) {
    return (
      <div className="page">
        <Empty title="No projects yet">
          <LinkButton tone="primary" href={routeHref({ name: "add-project" })}>
            Add project
          </LinkButton>
        </Empty>
      </div>
    );
  }

  const open = (kind: OpenMenu["kind"], element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setMenu({ kind, x: rect.left, y: rect.bottom + 4 });
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || busy || !engine) return;
    setBusy(true);
    setError(null);
    try {
      const thread = await api.createThread({
        project_id: project.id,
        engine: engine.id,
        model: null,
        title: null,
        worktree: worktree ? slugify(worktree) : null,
        skill_profile: null,
      });
      putThread(thread);
      if (!project.trusted) {
        useUi.getState().setDraft(thread.id, text);
        navigate({ name: "trust", projectId: project.id, threadId: thread.id });
        return;
      }
      const run = await api.startRun(thread.id, text);
      addPrompt(thread.id, { runId: run.id, text });
      navigate({ name: "thread", id: thread.id });
    } catch (failure) {
      setError(toFailure(failure).message);
      setBusy(false);
    }
  };

  return (
    <div className="thread-stage draft-stage" data-hero>
      <div className="composer-lane">
        <div className="composer-group">
          <div className="composer-stack">
            <div className="hero">
              <h1 className="hero-title" tabIndex={-1} data-page-title>
                What should we build in{" "}
                <button type="button" className="hero-project" onClick={(event) => open("project", event.currentTarget)}>
                  {project.name}
                </button>
                ?
              </h1>
            </div>
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <div className="composer-inner">
                {error ? (
                  <p className="field-error composer-error" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="composer-box">
                  <textarea
                    ref={field}
                    rows={1}
                    value={prompt}
                    data-autofocus
                    aria-label="Message"
                    placeholder="Ask anything"
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="composer-bar">
                    <span className="composer-left" />
                    <button
                      type="button"
                      className="context-action composer-engine"
                      aria-haspopup="menu"
                      aria-label={`Engine: ${engine?.name ?? "None"}`}
                      onClick={(event) => open("engine", event.currentTarget)}
                    >
                      {engine ? <EngineGlyph name={engine.name} /> : <Bot size={14} aria-hidden />}
                      {engine?.name ?? "No engine"}
                    </button>
                    <button type="submit" className="send-btn" aria-label="Send" disabled={!prompt.trim() || busy || !engine}>
                      <ArrowUp size={16} aria-hidden />
                    </button>
                  </div>
                </div>
                <div className="composer-context">
                  <dl>
                    <div>
                      <dt className="sr-only">Checkout</dt>
                      <dd>
                        <button
                          type="button"
                          className="context-action"
                          aria-haspopup="menu"
                          onClick={(event) => open("checkout", event.currentTarget)}
                        >
                          <Folder size={12} aria-hidden />
                          {worktree === null ? "Current checkout" : "New worktree"}
                        </button>
                      </dd>
                    </div>
                    {worktree !== null ? (
                      <div>
                        <dt className="sr-only">Worktree purpose</dt>
                        <dd>
                          <GitBranch size={12} aria-hidden />
                          <input
                            className="worktree-purpose"
                            aria-label="Worktree purpose"
                            placeholder="purpose"
                            value={worktree}
                            spellCheck={false}
                            onChange={(event) => setWorktree(event.target.value)}
                          />
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                  {engine && !engine.capabilities.managed ? <span>Unmanaged</span> : null}
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
      {menu ? (
        <Menu
          x={menu.x}
          y={menu.y}
          label={menu.kind}
          onClose={() => setMenu(null)}
          items={
            menu.kind === "project"
              ? projects.map((p) => ({
                  label: p.name,
                  selected: p.id === project.id,
                  onSelect: () => setChosenProject(p.id),
                }))
              : menu.kind === "engine"
                ? selectableEngines(engines).map((e) => ({
                    label: e.capabilities.managed ? e.name : `${e.name} (Unmanaged)`,
                    selected: e.id === engine?.id,
                    onSelect: () => setChosenEngine(e.id),
                  }))
                : [
                    { label: "Current checkout", selected: worktree === null, onSelect: () => setWorktree(null) },
                    { label: "New worktree", selected: worktree !== null, onSelect: () => setWorktree("") },
                  ]
          }
        />
      ) : null}
    </div>
  );
}
