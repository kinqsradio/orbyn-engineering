import { Check, Copy, FolderPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useAsync } from "../../lib/useAsync";
import type { EngineStatus, PermissionMode } from "../../api/types";
import { HistoryImport } from "../settings/HistoryImport";
import { ACCESS } from "../thread/ComposerTraits";
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
  { title: "Choose how agents ask", text: "Supervised, Auto or Full access" },
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
  const engines = useWorkspace((state) => state.engines.data) ?? [];
  const known = engines.filter((engine) => engine.tier !== "acp" || engine.installed);
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

function ProjectsStep() {
  const setPalette = useUi((state) => state.setPalette);
  return (
    <>
      <div className="welcome-row">
        <p>A new folder starts untrusted until you trust it.</p>
        <Button small tone="primary" icon={<FolderPlus size={16} aria-hidden />} onClick={() => setPalette("add-project")}>
          Add project
        </Button>
      </div>
      <HistoryImport />
    </>
  );
}

const MODES: PermissionMode[] = ["supervised", "auto", "full_access"];

/** What each mode means; the default for new threads is chosen in Settings · Threads. */
function AccessStep() {
  return (
    <>
      <ul className="welcome-access" aria-label="How agents ask">
        {MODES.map((mode) => {
          const Icon = ACCESS[mode].icon;
          return (
            <li key={mode}>
              <Icon size={16} aria-hidden />
              <span>
                <b>{ACCESS[mode].label}</b>
                <small>{ACCESS[mode].description}</small>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="welcome-note">
        <a href={routeHref({ name: "settings", section: "threads" })}>Choose the default in Settings · Threads</a>
      </p>
    </>
  );
}

const STEPS = [
  { title: "Welcome to Orbyn Engineering", lede: "Agents that work in your projects while you stay in control. Set up in a minute." },
  { title: "Connect an agent", lede: "Pick at least one. You can add more in Settings · Providers." },
  { title: "Add a project", lede: "Add any folder in place; adding it copies nothing." },
  { title: "Choose how agents ask", lede: "Each thread can change it from its composer." },
] as const;

/** First-run steps on the empty home, inline so the page stays usable: overview, agents, projects, then how agents ask. */
export function WelcomeWizard({ onClose }: { onClose(): void }) {
  const step = useUi((state) => state.welcomeStep) ?? 0;
  const setStep = useUi((state) => state.setWelcomeStep);
  const finish = () => {
    useUi.getState().setPrefs({ welcomeDone: true });
    setStep(null);
    onClose();
  };
  const last = step === STEPS.length - 1;
  const first = step === 0;
  return (
    <section className="welcome-wizard" data-step={step} aria-labelledby="welcome-title">
      <h2 id="welcome-title">{STEPS[step]?.title}</h2>
      <p className="welcome-lede" aria-live="polite">
        {STEPS[step]?.lede}
      </p>
      {step === 0 ? <Overview /> : step === 1 ? <AgentsStep /> : step === 2 ? <ProjectsStep /> : <AccessStep />}
      <div className="welcome-wizard-actions">
        <Button small onClick={first ? finish : () => setStep(step - 1)}>
          {first ? "Skip for now" : "Back"}
        </Button>
        <Button
          small
          tone="primary"
          onClick={() => {
            if (!last) setStep(step + 1);
            else {
              finish();
              navigate({ name: "home" });
            }
          }}
        >
          {last ? "Done" : first ? "Start" : "Continue"}
        </Button>
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
