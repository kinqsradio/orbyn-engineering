import { Plus } from "lucide-react";
import { useUi } from "../../state/ui";
import { Button } from "../../ui/controls";

/** The app with nothing to work on yet. */
export function NoProjects() {
  const setPalette = useUi((state) => state.setPalette);
  return (
    <div className="no-projects">
      <h1 tabIndex={-1} data-page-title>
        What should we work on?
      </h1>
      <p>Add a project to start your first thread.</p>
      <Button tone="primary" small icon={<Plus size={16} aria-hidden />} onClick={() => setPalette("add-project")}>
        Add project
      </Button>
    </div>
  );
}
