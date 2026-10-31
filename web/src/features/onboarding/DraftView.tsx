import { ArrowUp, Bot, Folder, GitBranch, PanelRight, Paperclip, SquareDashed, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { api } from "../../api/client";
import type { EngineStatus, PermissionMode, Project } from "../../api/types";
import { slugify } from "../../lib/format";
import { toFailure } from "../../lib/useAsync";
import { navigate } from "../../state/route";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useVisibleProjects, useWorkspace } from "../../state/workspace";
import { NoProjects } from "./NoProjects";
import { useLayoutWidth } from "../../lib/useLayout";
import { IconButton } from "../../ui/controls";
import { ProjectBadge } from "../../ui/badges";
import { PaneResizer } from "../panels/SurfacePane";
import { Menu } from "../../ui/Menu";
import { Loading } from "../../ui/states";
import { ACCESS, EffortTrigger, useTraitsMenu } from "../thread/ComposerTraits";
import { ModelPickerTrigger } from "../thread/ModelPicker";
import { resolveModel, useEngineModels } from "../thread/modelStore";
import { DraftProjectPicker } from "./DraftProjectPicker";

type OpenMenu = { kind: "checkout"; x: number; y: number };

const DRAFT_KEY = "new-thread";
export const SCRATCH = "scratch";

/** Files wait here until a thread exists, so a project switch or the trust step keeps them. */
const useDraftFiles = create<{ files: File[]; set(files: File[]): void }>((set) => ({
  files: [],
  set: (files) => set({ files }),
}));

function DraftModelControls({
  engines,
  engine,
  model,
  effort,
  extras,
  access,
  register,
  onModel,
  onEffort,
  onOption,
  onAccess,
}: {
  engines: EngineStatus[];
  engine: string;
  model: string | null;
  effort: string | null;
  extras: Record<string, string>;
  access: PermissionMode | null;
  register(open: () => (element: HTMLElement) => void): void;
  onModel(next: { engine: string; model: string | null }): void;
  onEffort(value: string): void;
  onOption(option: string, value: string): void;
  onAccess(mode: PermissionMode): void;
}) {
  const models = useEngineModels(engine);
  const resolved = resolveModel(models, model);
  const traits = useTraitsMenu({ model: resolved, effort, extras, access, onEffort, onOption, onAccess });
  const openAt = useRef(traits.openAt);
  openAt.current = traits.openAt;
  useEffect(() => {
    register(() => (element: HTMLElement) => openAt.current(element, true));
  }, [register]);
  return (
    <>
      <ModelPickerTrigger engines={engines} selected={{ engine, model }} onPick={onModel} />
      <EffortTrigger
        model={resolved}
        effort={effort}
        access={access}
        onOpen={(element) => traits.openAt(element, false)}
      />
      {traits.menu}
    </>
  );
}

/** The default screen: a composer for a thread that doesn't exist until you send. */
export function DraftView({ projectId }: { projectId: string | null }) {
  const projects = useVisibleProjects();
  const engines = useWorkspace((state) => state.engines.data);
  const putThread = useWorkspace((state) => state.putThread);
  const targets = useWorkspace((state) => state.managed.data?.targets);
  const addPrompt = useThreadLogs((state) => state.addPrompt);
  const field = useRef<HTMLTextAreaElement>(null);
  const [chosenProject, setChosenProject] = useState(projectId);
  const lastModel = useUi((state) => state.lastModel);
  const setPrefs = useUi((state) => state.setPrefs);
  const [choice, setChoice] = useState(lastModel);
  const [access, setAccess] = useState<PermissionMode>("supervised");
  const [extras, setExtras] = useState<Record<string, string>>({});
  const prompt = useUi((state) => state.drafts[DRAFT_KEY] ?? "");
  const setDraft = useUi((state) => state.setDraft);
  const setPalette = useUi((state) => state.setPalette);
  const files = useDraftFiles((state) => state.files);
  const setFiles = useDraftFiles((state) => state.set);
  const fileInput = useRef<HTMLInputElement>(null);
  const adoptLayout = useUi((state) => state.adoptDraftLayout);
  const panelPref = useUi((state) => state.panelOpen);
  const setPanelOpen = useUi((state) => state.setPanelOpen);
  const panelWidth = useUi((state) => state.panelWidth);
  const layoutWidth = useLayoutWidth();
  const paneShown = panelPref === true && layoutWidth !== "narrow";
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const [openTraits, setOpenTraits] = useState<((element: HTMLElement) => void) | null>(null);
  const [worktree, setWorktree] = useState<string | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    field.current?.focus();
  }, []);

  if (!projects || !engines) return <div className="page"><Loading label="Loading" rows={3} /></div>;
  const scratch = chosenProject === SCRATCH;
  const project: Project | null = scratch
    ? null
    : (projects.find((p) => p.id === chosenProject) ?? projects[0] ?? null);
  const installed = engines.filter((e) => e.installed);
  const engine =
    installed.find((e) => e.id === choice?.engine) ??
    installed.find((e) => e.capabilities.managed) ??
    installed[0] ??
    null;
  const unmanaged = engine !== null && !engine.capabilities.managed;

  if (!project && !scratch) return <NoProjects />;

  const branch = targets?.find((target) => target.project_id === project?.id)?.branch ?? null;
  const setPrompt = (text: string) => setDraft(DRAFT_KEY, text);
  const pickedModel = choice?.engine === engine?.id ? (choice?.model ?? null) : null;
  const pickedEffort = choice?.engine === engine?.id ? (choice?.effort ?? null) : null;
  const AccessIcon = ACCESS[access].icon;

  const open = (kind: OpenMenu["kind"], element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setMenu({ kind, x: rect.left, y: rect.bottom + 4 });
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || busy || !engine) return;
    if (project && !project.trusted) {
      navigate({ name: "trust", projectId: project.id, threadId: null });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const thread = await api.createThread({
        ...(project ? { project_id: project.id } : {}),
        engine: engine.id,
        model: pickedModel,
        title: null,
        worktree: worktree ? slugify(worktree) : null,
        skill_profile: null,
      });
      putThread(thread);
      adoptLayout(thread.id);
      const attached = await Promise.all(files.map((file) => api.uploadAttachment(thread.id, file)));
      const run = await api.startRun(
        thread.id,
        text,
        attached.map((file) => file.id),
        {
          ...(pickedEffort ? { effort: pickedEffort } : {}),
          ...(Object.keys(extras).length > 0 ? { options: extras } : {}),
          ...(access === "supervised" ? {} : { permission_mode: access }),
        },
      );
      addPrompt(thread.id, { runId: run.id, text });
      setPrompt("");
      setFiles([]);
      navigate({ name: "thread", id: thread.id });
    } catch (failure) {
      setError(toFailure(failure).message);
      setBusy(false);
    }
  };

  return (
    <div className="draft-layout">
      <section className="draft-main thread-main" aria-label="New thread">
        <header className="topbar">
          <div className="crumbs">
            {project ? <ProjectBadge name={project.name} /> : <SquareDashed size={14} aria-hidden />}
            <span className="crumb-project">{project?.name ?? "No project"}</span>
            <span className="crumb-slash" aria-hidden>
              /
            </span>
            <span className="crumb-title">New thread</span>
          </div>
          <div className="layout-toggles" role="group" aria-label="Layout">
            {paneShown ? null : (
              <IconButton label="Surfaces" onClick={() => setPanelOpen(true)}>
                <PanelRight size={16} aria-hidden />
              </IconButton>
            )}
          </div>
        </header>
    <div className="thread-stage draft-stage" data-hero>
      <div className="composer-lane">
        <div className="composer-group">
          <div className="composer-stack">
            <div className="hero">
              <h1 className="hero-title" tabIndex={-1} data-page-title>
                {project ? (
                  <>
                    What should we build in{" "}
                    <button
                      type="button"
                      className="hero-project"
                      aria-haspopup="listbox"
                      aria-expanded={picker !== null}
                      onClick={(event) => setPicker(event.currentTarget.getBoundingClientRect())}
                    >
                      {project.name}
                    </button>
                    ?
                  </>
                ) : (
                  "What should we work on?"
                )}
              </h1>
              <p className="hero-sub">
                {project ? (
                  <button type="button" className="hero-link" onClick={() => setChosenProject(SCRATCH)}>
                    or start without a project
                  </button>
                ) : (
                  <button
                    type="button"
                    className="hero-project"
                    aria-haspopup="listbox"
                    aria-expanded={picker !== null}
                    onClick={(event) => setPicker(event.currentTarget.getBoundingClientRect())}
                  >
                    No project
                  </button>
                )}
              </p>
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
                  {files.length > 0 ? (
                    <ul className="attachment-strip" aria-label="Attachments">
                      {files.map((file, at) => (
                        <li key={`${file.name}:${at}`}>
                          <span>{file.name}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${file.name}`}
                            onClick={() => setFiles(files.filter((_, index) => index !== at))}
                          >
                            <X size={12} aria-hidden />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <textarea
                    ref={field}
                    rows={1}
                    value={prompt}
                    data-autofocus
                    aria-label="Message"
                    placeholder="Ask anything. @ files, $ skills, / commands"
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="composer-bar">
                    <span className="composer-left">
                      <input
                        ref={fileInput}
                        type="file"
                        multiple
                        hidden
                        aria-label="Attach files"
                        onChange={(event) => {
                          setFiles([...files, ...(event.target.files ?? [])]);
                          event.target.value = "";
                        }}
                      />
                      <IconButton label="Attach files" onClick={() => fileInput.current?.click()}>
                        <Paperclip size={16} aria-hidden />
                      </IconButton>
                    </span>
                    {engine ? (
                      <DraftModelControls
                        engines={installed}
                        engine={engine.id}
                        model={pickedModel}
                        effort={pickedEffort}
                        extras={extras}
                        access={unmanaged ? null : access}
                        register={setOpenTraits}
                        onModel={(next) => {
                          const picked = { ...next, effort: pickedEffort };
                          setExtras({});
                          setChoice(picked);
                          setPrefs({ lastModel: picked });
                        }}
                        onEffort={(value) => {
                          const picked = { engine: engine.id, model: pickedModel, effort: value };
                          setChoice(picked);
                          setPrefs({ lastModel: picked });
                        }}
                        onOption={(option, value) => setExtras({ ...extras, [option]: value })}
                        onAccess={setAccess}
                      />
                    ) : (
                      <span className="composer-control">
                        <Bot size={14} aria-hidden />
                        No engine
                      </span>
                    )}
                    <button type="submit" className="send-btn" aria-label="Send" disabled={!prompt.trim() || busy || !engine}>
                      <ArrowUp size={16} aria-hidden />
                    </button>
                  </div>
                </div>
                <div className="composer-context">
                  {project ? (
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
                    {worktree === null && branch ? (
                      <div>
                        <dt className="sr-only">Branch</dt>
                        <dd>
                          <GitBranch size={12} aria-hidden />
                          {branch}
                        </dd>
                      </div>
                    ) : null}
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
                  ) : (
                    <span />
                  )}
                  {unmanaged ? (
                    <span>Unmanaged</span>
                  ) : (
                    <button
                      type="button"
                      className="context-action"
                      aria-haspopup="menu"
                      aria-label={`Permissions: ${ACCESS[access].label}`}
                      onClick={(event) => openTraits?.(event.currentTarget)}
                    >
                      <AccessIcon size={12} aria-hidden />
                      {ACCESS[access].label}
                    </button>
                  )}
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
          items={[
            { label: "Current checkout", selected: worktree === null, onSelect: () => setWorktree(null) },
            { label: "New worktree", selected: worktree !== null, onSelect: () => setWorktree("") },
          ]}
        />
      ) : null}
      {picker ? (
        <DraftProjectPicker
          projects={projects}
          current={project?.id ?? ""}
          anchor={picker}
          onClose={() => setPicker(null)}
          onPick={(next) => {
            setChosenProject(next.id);
            setPicker(null);
            field.current?.focus();
          }}
          onAdd={() => {
            setPicker(null);
            setPalette("add-project");
          }}
        />
      ) : null}
    </div>
      </section>
      {paneShown ? (
        <aside
          className="context"
          aria-label="Thread context"
          style={panelWidth !== null ? { width: panelWidth } : undefined}
        >
          <PaneResizer />
          <header className="context-head">
            <div className="layout-toggles">
              <IconButton label="Close surfaces" pressed onClick={() => setPanelOpen(false)}>
                <PanelRight size={16} aria-hidden />
              </IconButton>
            </div>
          </header>
          <div className="context-body">
            <div className="launcher">
              <div className="launcher-inner">
                <h2>Open a surface</h2>
              </div>
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
