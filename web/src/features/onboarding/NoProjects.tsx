import { Download, Folder } from "lucide-react";
import { useEffect } from "react";
import { useUi } from "../../state/ui";
import { Button } from "../../ui/controls";
import { SkillsNotice } from "./SkillsNotice";
import "./onboarding.css";

/** The app with nothing to work on yet. The welcome steps open once on a new device. */
export function NoProjects() {
  const setPalette = useUi((state) => state.setPalette);
  const welcomeDone = useUi((state) => state.welcomeDone);
  const setWelcomeStep = useUi((state) => state.setWelcomeStep);
  useEffect(() => {
    if (!welcomeDone && useUi.getState().welcomeStep === null) setWelcomeStep(0);
  }, [welcomeDone, setWelcomeStep]);
  return (
    <div className="no-projects">
      <h1 tabIndex={-1} data-page-title>
        Add your first project
      </h1>
      <p>Point Orbyn at a folder with code. Agents work in it in place.</p>
      <div className="no-projects-actions">
        <Button small icon={<Download size={13} aria-hidden />} onClick={() => setPalette("add-project-url")}>
          Clone from GitHub
        </Button>
        <Button tone="primary" small icon={<Folder size={13} aria-hidden />} onClick={() => setPalette("add-project")}>
          Add a folder
        </Button>
      </div>
      <SkillsNotice />
    </div>
  );
}
