import { useId } from "react";
import { MAX_PANEL_ANIMATION_MS } from "../../lib/panelAnimations";
import { useUi, type ThemeChoice } from "../../state/ui";

const choices: { value: ThemeChoice; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Match system" },
];

const shortcuts: { keys: string; action: string }[] = [
  { keys: "Enter", action: "Send message" },
  { keys: "Shift+Enter", action: "New line" },
  { keys: "Cmd/Ctrl+K", action: "Command palette" },
  { keys: "Alt+N", action: "New thread" },
  { keys: "Alt+A", action: "Approvals" },
  { keys: "Alt+1, 2, 3", action: "Diff, Terminal, Activity" },
  { keys: "Esc", action: "Close the top dialog or panel" },
];

export function AppearanceSection() {
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const group = useId();
  const sliderId = useId();
  const panelMs = useUi((state) => state.panelAnimationMs);
  const setPanelMs = useUi((state) => state.setPanelAnimationMs);
  return (
    <>
      <div className="section-bar">
        <h1 tabIndex={-1} data-page-title>
          Appearance
        </h1>
      </div>
      <fieldset className="fieldset">
        <legend>Theme</legend>
        <div className="choice-row">
          {choices.map((choice) => (
            <label key={choice.value} className="check">
              <input
                type="radio"
                name={group}
                checked={theme === choice.value}
                onChange={() => setTheme(choice.value)}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <section className="section">
        <h2>Motion</h2>
        <div className="field">
          <label htmlFor={sliderId}>Panel animations: {panelMs === 0 ? "Off" : `${panelMs} ms`}</label>
          <input
            id={sliderId}
            type="range"
            min={0}
            max={MAX_PANEL_ANIMATION_MS}
            step={20}
            value={panelMs}
            onChange={(event) => setPanelMs(Number(event.target.value))}
          />
          <p className="field-hint">
            Moves panels and the composer. Off by default, since it redraws layout on every frame.
          </p>
        </div>
      </section>
      <section className="section">
        <h2>Keyboard</h2>
        <dl className="shortcuts">
          {shortcuts.map((shortcut) => (
            <div key={shortcut.keys}>
              <dt>
                <kbd>{shortcut.keys}</kbd>
              </dt>
              <dd>{shortcut.action}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
