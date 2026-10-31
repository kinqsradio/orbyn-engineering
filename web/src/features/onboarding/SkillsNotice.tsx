import { routeHref } from "../../state/route";
import { useWorkspace } from "../../state/workspace";

/** Only when skills truly can't be used; getting them ready is the service's job and stays out of sight. */
export function SkillsNotice() {
  const unavailable = useWorkspace((state) => state.managed.data?.configured === false);
  if (!unavailable) return null;
  return (
    <p className="skills-notice" role="status">
      Skills aren't available right now. <a href={routeHref({ name: "settings", section: "maintenance" })}>Skill library settings</a>
    </p>
  );
}
