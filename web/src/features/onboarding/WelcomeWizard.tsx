import { Check, Copy, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api, request } from "../../api/client";
import { toFailure, useAsync } from "../../lib/useAsync";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import type { EngineStatus, PermissionMode, Project } from "../../api/types";
import { AddProjectPalette } from "../workspace/AddProjectPalette";
import { ACCESS, offeredModes, shownAccess } from "../thread/ComposerTraits";
import { navigate, routeHref } from "../../state/route";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import "./onboarding.css";

/**
 * What a person needs to do before an engine can run, in the order they'd do it. `next`
 * is a command to copy. The service sends no install command, and its manual hint is
 * about updating, so a missing engine gets a plain step instead.
 */
export function engineReadiness(engine: EngineStatus): { label: string; tone: "accent" | "warn"; next: string | null; step?: string } {
  if (!engine.installed) return { label: "Not installed", tone: "warn", next: null, step: `Install ${engine.name}, then check again.` };
  if (engine.auth === "logged_out") return { label: "Sign in needed", tone: "warn", next: engine.sign_in_command };
  return { label: "Ready", tone: "accent", next: null };
}

const OVERVIEW = [
  { title: "Connect an agent", text: "Claude Code, Codex or any ACP agent" },
  { title: "Add a project", text: "A folder on this computer, or clone one" },
  { title: "Choose how agents ask", text: "Supervised, Auto-accept edits, Auto or Full access" },
] as const;

function Overview() {
  // Only a confirmed library earns the claim, and the count is the library's own: no count, no notice.
  const ready = useWorkspace((state) => state.managed.data?.configured === true);
  const library = useAsync("welcome-skills", (signal) => api.skills(signal));
  const count = ready ? library.data?.skills.length : undefined;
  return (
    <>
      <ol className="welcome-steps">
        {OVERVIEW.map((step, at) => (
          <li key={step.title} data-first={at === 0 || undefined}>
            <small>Step {at + 1}</small>
            <b>{step.title}</b>
            <span>{step.text}</span>
          </li>
        ))}
      </ol>
      {!count ? null : (
        <p className="welcome-note">
          <Check size={14} aria-hidden />
          Orbyn skills library ready · {count} {count === 1 ? "skill" : "skills"}
        </p>
      )}
    </>
  );
}

function CopyAction({ command, name }: { command: string; name: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Button small aria-label={copied ? "Copied" : `Copy the ${name} command`} icon={copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} onClick={() => void copy()}>
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function AgentsStep() {
  const known = listedEngines(useWorkspace((state) => state.engines.data) ?? []);
  return (
    <>
      {known.length === 0 ? <p role="status" className="welcome-note">Looking for agents…</p> : null}
      <ul className="welcome-agents" aria-label="Agents on this computer">
        {known.map((engine) => {
          const ready = engineReadiness(engine);
          return (
            <li key={engine.id}>
              <span className="welcome-avatar" aria-hidden>
                {engine.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="welcome-agent-name">
                <b>{engine.name}</b>
                <small>{!engine.installed ? "Not installed" : engine.version ? `${engine.version} · installed` : "Installed"}</small>
              </span>
              <code className="welcome-agent-next">{ready.next}</code>
              <span className="welcome-agent-act">
                {ready.label === "Ready" ? (
                  <span className="welcome-ready">
                    <Check size={14} aria-hidden />
                    Ready
                  </span>
                ) : ready.next ? (
                  <CopyAction command={ready.next} name={engine.name} />
                ) : null}
              </span>
            </li>
          );
        })}
        <li>
          <span className="welcome-avatar" aria-hidden>
            A
          </span>
          <span className="welcome-agent-name">
            <b>ACP registry</b>
            <small>Agents that speak ACP</small>
          </span>
          <span className="welcome-agent-next welcome-agent-text">In Settings · Providers</span>
          <span className="welcome-agent-act">
            <a className="btn btn-small" href={routeHref({ name: "settings", section: "providers" })}>
              Open
            </a>
          </span>
        </li>
      </ul>
    </>
  );
}

/** The agents worth listing: every managed one, and an ACP one once it is installed. */
const listedEngines = (engines: EngineStatus[]) => engines.filter((engine) => engine.tier !== "acp" || engine.installed);

/** Add a project: the add-project palette's path field, Folders and actions, laid out inline. */
function ProjectsStep({ added, onAdded }: { added: readonly Project[]; onAdded(project: Project): void }) {
  return (
    <>
      <div className="welcome-menu">
        <AddProjectPalette onClose={() => undefined} onSubdialog={() => undefined} added={added} onAdded={onAdded} />
      </div>
      <p className="welcome-quiet">You can import past agent sessions later in Settings › Providers.</p>
    </>
  );
}

/** The default access mode for new threads, read and saved as the Settings · Chat row does. */
function useDefaultAccess() {
  const [saved, setSaved] = useState<PermissionMode>("supervised");
  const [revision, setRevision] = useState<{ version: string; row: string } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    request<ScopedPreferencesResult>("POST", "/api/settings/preferences/query", { scope: {}, keys: ["default_permission_mode"] }, abort.signal).then(
      (result) => {
        const row = result.rows?.find((entry) => entry.key === "default_permission_mode");
        if (!row || abort.signal.aborted) return;
        if (typeof row.value === "string" && row.value in ACCESS) setSaved(row.value as PermissionMode);
        setRevision({ version: result.catalog.version, row: row.revision });
      },
      () => undefined,
    );
    return () => abort.abort();
  }, []);
  const save = async (mode: PermissionMode) => {
    if (!revision) return;
    await request<ScopedPreferencesResult>("PUT", "/api/settings/preferences", {
      scope: {},
      membership_version: revision.version,
      if_match: { default_permission_mode: revision.row },
      edits: { default_permission_mode: { op: "set", value: mode } },
    });
    useUi.getState().bumpPreferencesRevision();
  };
  return { saved, save, loaded: revision !== null };
}

/** The engine a new thread would start on: the first one that is installed and signed in. */
function useChosenEngine(): EngineStatus | null {
  const engines = useWorkspace((state) => state.engines.data) ?? [];
  return engines.find((engine) => engine.installed && engine.auth !== "logged_out") ?? null;
}

function AccessStep({ choice, onChoose, modes }: { choice: PermissionMode; onChoose(mode: PermissionMode): void; modes: PermissionMode[] }) {
  return (
    <div className="welcome-choices" role="radiogroup" aria-label="How agents ask">
      {modes.map((mode) => (
        <label key={mode} className="welcome-choice" data-on={choice === mode || undefined}>
          <input type="radio" name="welcome-access" className="welcome-radio" checked={choice === mode} onChange={() => onChoose(mode)} />
          <span>
            <b>{ACCESS[mode].label}</b>
            <small>{ACCESS[mode].description}</small>
          </span>
        </label>
      ))}
    </div>
  );
}

const STEPS = [
  { title: "Welcome to Orbyn Engineering", lede: "Agents that work in your projects while you stay in control. Set up in a minute." },
  { title: "Connect an agent", lede: "Pick at least one. You can add more in Settings · Providers." },
  {
    title: "Add a project",
    lede: "A folder on this computer, or clone one. Type a path to add any folder in place; nothing is copied or installed into it. You can add more later from the sidebar.",
  },
  {
    title: "Choose how agents ask",
    lede: "This sets the access mode new threads start in. You can change it for any thread, and later in Settings · Chat.",
  },
] as const;

function Stepper({ step }: { step: number }) {
  return (
    <div className="welcome-stepper" role="img" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((at) => (
        <i key={at} data-on={at <= step || undefined} />
      ))}
      <span aria-hidden>Step {step} of 3</span>
    </div>
  );
}

/** First-run steps on the empty home, inline so the page stays usable: overview, agents, projects, then how agents ask. */
export function WelcomeWizard({ onClose }: { onClose(): void }) {
  const step = useUi((state) => state.welcomeStep) ?? 0;
  const setStep = useUi((state) => state.setWelcomeStep);
  const pushToast = useUi((state) => state.pushToast);
  const engines = useWorkspace((state) => state.engines.data) ?? [];
  const refresh = useWorkspace((state) => state.refreshEngines);
  const access = useDefaultAccess();
  const engine = useChosenEngine();
  const modes = offeredModes(engine);
  const [picked, setPicked] = useState<PermissionMode | null>(null);
  const choice = shownAccess(engine, picked ?? access.saved);
  const [saving, setSaving] = useState(false);
  // What step 2 has added so far; the last one is the project the app opens on.
  const [added, setAdded] = useState<Project[]>([]);
  const finish = () => {
    useUi.getState().setPrefs({ welcomeDone: true });
    setStep(null);
    onClose();
  };
  const last = step === STEPS.length - 1;
  const first = step === 0;
  const missing = listedEngines(engines).some((entry) => engineReadiness(entry).label !== "Ready");
  const done = async () => {
    setSaving(true);
    try {
      if (choice !== access.saved) await access.save(choice);
      finish();
      const opened = added.at(-1);
      navigate(
        opened
          ? opened.trusted
            ? { name: "new", projectId: opened.id }
            : { name: "trust", projectId: opened.id, threadId: null }
          : { name: "home" },
      );
    } catch (failure) {
      pushToast(`Couldn't save the access mode. ${toFailure(failure).message}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="welcome-wizard" data-step={step} aria-labelledby="welcome-title">
      {first ? null : <Stepper step={step} />}
      <h2 id="welcome-title">{STEPS[step]?.title}</h2>
      <p className="welcome-lede" aria-live="polite">
        {STEPS[step]?.lede}
      </p>
      {step === 0 ? (
        <Overview />
      ) : step === 1 ? (
        <AgentsStep />
      ) : step === 2 ? (
        <ProjectsStep added={added} onAdded={(project) => setAdded((list) => (list.some((entry) => entry.id === project.id) ? list : [...list, project]))} />
      ) : (
        <AccessStep choice={choice} onChoose={setPicked} modes={modes} />
      )}
      <div className="welcome-wizard-actions">
        {first ? null : step === 1 ? (
          missing ? (
            <Button small icon={<RefreshCw size={14} aria-hidden />} onClick={() => void refresh()}>
              Check again
            </Button>
          ) : (
            <span />
          )
        ) : (
          <Button small onClick={() => setStep(step - 1)}>
            Back
          </Button>
        )}
        <span className="welcome-actions-end">
          {first ? <Button small onClick={finish}>Skip for now</Button> : null}
          {step === 1 ? (
            <Button small onClick={() => setStep(0)}>
              Back
            </Button>
          ) : null}
          {step === 2 && added.length === 0 ? (
            <Button small onClick={() => setStep(3)}>
              Skip for now
            </Button>
          ) : null}
          <Button
            small
            tone="primary"
            busy={saving}
            disabled={step === 2 && added.length === 0}
            onClick={() => (last ? void done() : setStep(step + 1))}
          >
            {first ? "Start" : "Continue"}
          </Button>
        </span>
      </div>
    </section>
  );
}

/**
 * Shows the welcome steps on home only, so a draft or the trust page stays clear. The
 * open step lives in the UI store, so adding or trusting a folder elsewhere doesn't
 * end them: they are back when home is.
 */
export function WelcomeHost({ needsProject }: { needsProject: boolean }) {
  const step = useUi((state) => state.welcomeStep);
  const welcomeDone = useUi((state) => state.welcomeDone);
  const setWelcomeStep = useUi((state) => state.setWelcomeStep);
  // A new device with nothing to work on opens the steps once.
  useEffect(() => {
    if (needsProject && !welcomeDone && useUi.getState().welcomeStep === null) setWelcomeStep(0);
  }, [needsProject, welcomeDone, setWelcomeStep]);
  return step === null ? null : <WelcomeWizard onClose={() => undefined} />;
}
