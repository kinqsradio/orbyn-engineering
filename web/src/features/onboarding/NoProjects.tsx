import { Download, Folder, Plus } from "lucide-react";
import { useUi } from "../../state/ui";
import { Button } from "../../ui/controls";
import { SkillsNotice } from "./SkillsNotice";
import "./onboarding.css";

/** The app with nothing to work on yet. The welcome steps open once on a new device. */
export function NoProjects() {
  const setPalette = useUi((state) => state.setPalette);
  return (
    <div className="no-projects">
      <h1 tabIndex={-1} data-page-title>
        Add your first project
      </h1>
      <p>Point Orbyn at a folder with code. Agents work in it in place.</p>
      <div className="no-projects-actions">
        <Button small icon={<Plus size={13} aria-hidden />} onClick={() => setPalette("add-project-new")}>
          New project
        </Button>
        <Button small icon={<Download size={13} aria-hidden />} onClick={() => setPalette("add-project-url")}>
          Clone a repository
        </Button>
        <Button tone="primary" small icon={<Folder size={13} aria-hidden />} onClick={() => setPalette("add-project")}>
          Add a folder
        </Button>
      </div>
      <SkillsNotice />
    </div>
  );
}
