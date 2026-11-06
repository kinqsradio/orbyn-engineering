import { Circle, Square } from "lucide-react";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { PreviewTab } from "../../api/types";
import { Button } from "../../ui/controls";
import { PreviewRecordings, type RecordingStatus } from "./previewRecording";

export function BrowserRecording({ tab, endpoint, actions, refresh }: {
  tab: PreviewTab;
  endpoint: string;
  actions: PreviewRecordings;
  refresh(): Promise<RecordingStatus | void>;
}) {
  const [fps, setFps] = useState(5);
  const [showMousePresses, setShowMousePresses] = useState(false);
  const [showKeyPresses, setShowKeyPresses] = useState(false);
  const state = useSyncExternalStore(actions.subscribe, () => actions.state(endpoint));
  useLayoutEffect(() => actions.focus(endpoint), [actions, endpoint]);
  useLayoutEffect(() => actions.observe(endpoint, tab), [actions, endpoint, tab]);
  const active = state.active ?? tab.recording;
  const serverError = state.active === null ? tab.recording_error : null;
  const finishing = active || Boolean(serverError);
  const locked = state.pending || finishing;
  const error = state.error ?? state.result?.error ?? serverError;
  return (
    <section className="browser-recording" aria-label="Page recording">
      <div className="browser-recording-controls">
        <Button small busy={state.pending} icon={finishing ? <Square size={12} aria-hidden /> : <Circle size={12} aria-hidden />}
          onClick={() => void actions.run(endpoint, finishing ? null : { fps, showMousePresses, showKeyPresses }, refresh)}>
          {finishing ? (active ? "Stop recording" : "Finish recording") : "Start recording"}
        </Button>
        {!finishing ? <><label>Max FPS <select aria-label="Recording maximum FPS" value={fps} disabled={locked}
          onChange={(event) => setFps(Number(event.target.value))}>
          {[1, 2, 5, 10].map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label><input type="checkbox" checked={showMousePresses} disabled={locked}
          onChange={(event) => setShowMousePresses(event.target.checked)} /> Show clicks</label>
        <label title="Navigation keys only, on focused buttons and links."><input type="checkbox" checked={showKeyPresses} disabled={locked}
          onChange={(event) => setShowKeyPresses(event.target.checked)} /> Show navigation keys</label></> : null}
        {active ? <span role="status"><i className="rec-dot" aria-hidden />Recording…</span> : null}
      </div>
      {state.result ? <div className="browser-recording-result" role="status">
        <span>Saved {state.result.frames} {state.result.frames === 1 ? "frame" : "frames"}.</span>
        <label>Recording folder <input readOnly value={state.result.path} onFocus={(event) => event.currentTarget.select()} /></label>
      </div> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </section>
  );
}
