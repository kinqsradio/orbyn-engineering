import { Plus } from "lucide-react";
import { useState } from "react";
import { navigate } from "../../state/route";
import { useUi } from "../../state/ui";
import { Button } from "../../ui/controls";
import { SkillsNotice } from "./SkillsNotice";
import { WelcomeWizard } from "./WelcomeWizard";

/** The app with nothing to work on yet. The welcome steps open once on a new device. */
export function NoProjects() {
  const setPalette = useUi((state) => state.setPalette);
  const welcomeDone = useUi((state) => state.welcomeDone);
  const [welcome, setWelcome] = useState(!welcomeDone);
  return (
    <div className="no-projects">
      <h1 tabIndex={-1} data-page-title>
        What should we work on?
      </h1>
      <p>Add a project, or start without one.</p>
      <div className="no-projects-actions">
        <Button tone="primary" small icon={<Plus size={16} aria-hidden />} onClick={() => setPalette("add-project")}>
          Add project
        </Button>
        <Button small onClick={() => navigate({ name: "new", projectId: "scratch" })}>
          Start without a project
        </Button>
        <Button small tone="quiet" onClick={() => setWelcome(true)}>
          Welcome steps
        </Button>
      </div>
      <SkillsNotice />
      {welcome ? <WelcomeWizard onClose={() => setWelcome(false)} /> : null}
    </div>
  );
}
