import { Plus } from "lucide-react";
import type { EngineStatus } from "../../api/types";
import { HistoryImport } from "../settings/HistoryImport";
import { navigate } from "../../state/route";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button, CopyCommand, Pill } from "../../ui/controls";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";

/** What a person needs to do before an engine can run, in the order they'd do it. */
export function engineReadiness(engine: EngineStatus): { label: string; tone: "accent" | "warn"; next: string | null } {
  if (!engine.installed) return { label: "Not installed", tone: "warn", next: engine.manual_hint };
  if (engine.auth === "logged_out") return { label: "Sign in needed", tone: "warn", next: engine.sign_in_command };
  return { label: "Ready", tone: "accent", next: null };
}

function AgentsStep() {
  const engines = useWorkspace((state) => state.engines.data) ?? [];
  const refresh = useWorkspace((state) => state.refreshEngines);
  const known = engines.filter((engine) => engine.tier !== "acp" || engine.installed);
  return (
    <SettingGroup title="Agents on this computer">
      <p className="setting-line-desc">Orbyn runs the agents you already have, with their own sign-in.</p>
      {known.length === 0 ? <p className="setting-line-desc" role="status">Looking for agents…</p> : null}
      {known.map((engine) => {
        const ready = engineReadiness(engine);
        return (
          <SettingRow key={engine.id} title={engine.name} description={engine.version ? `Version ${engine.version}` : undefined}>
            <Pill tone={ready.tone}>{ready.label}</Pill>
            {ready.next ? <CopyCommand command={ready.next} label={`Copy the ${engine.name} step`} /> : null}
          </SettingRow>
        );
      })}
      <SettingRow title="Installed or signed in just now?">
        <Button small tone="quiet" onClick={() => void refresh()}>
          Check again
        </Button>
      </SettingRow>
    </SettingGroup>
  );
}

function ProjectsStep() {
  const setPalette = useUi((state) => state.setPalette);
  return (
    <>
      <SettingGroup title="Your projects">
        <SettingRow title="Add a folder you work in" description="A new folder starts untrusted until you trust it.">
          <Button
            small
            tone="primary"
            icon={<Plus size={16} aria-hidden />}
            onClick={() => setPalette("add-project")}
          >
            Add project
          </Button>
        </SettingRow>
      </SettingGroup>
      <HistoryImport />
    </>
  );
}

const STEPS = ["Agents", "Projects"] as const;

/** First-run steps on the empty home, inline so the page stays usable: which agents are ready, then projects and past conversations. */
export function WelcomeWizard({ onClose }: { onClose(): void }) {
  const step = useUi((state) => state.welcomeStep) ?? 0;
  const setStep = useUi((state) => state.setWelcomeStep);
  const finish = () => {
    useUi.getState().setPrefs({ welcomeDone: true });
    setStep(null);
    onClose();
  };
  const last = step === STEPS.length - 1;
  return (
    <section className="welcome-wizard" aria-labelledby="welcome-title">
      <h2 id="welcome-title">Welcome to Orbyn · {STEPS[step]}</h2>
      <p className="setting-line-desc" aria-live="polite">
        Step {step + 1} of {STEPS.length}
      </p>
      {step === 0 ? <AgentsStep /> : <ProjectsStep />}
      <div className="welcome-wizard-actions">
        <Button small tone="quiet" onClick={step === 0 ? finish : () => setStep(step - 1)}>
          {step === 0 ? "Skip" : "Back"}
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
          {last ? "Done" : "Next"}
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
export function WelcomeHost() {
  const step = useUi((state) => state.welcomeStep);
  return step === null ? null : <WelcomeWizard onClose={() => undefined} />;
}
