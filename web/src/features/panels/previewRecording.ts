import { request } from "../../api/client";
import type { Wired } from "../../api/types";
import type { PreviewRecording as RecordingWire } from "../../generated/PreviewRecording";
import { toFailure } from "../../lib/useAsync";

export interface RecordingChoices {
  fps: number;
  showMousePresses: boolean;
  showKeyPresses?: boolean;
}
type PreviewRecording = Wired<RecordingWire>;

interface RecordingState {
  pending: boolean;
  result: PreviewRecording | null;
  error: string | null;
  active: boolean | null;
}

export interface RecordingStatus { recording: boolean; recording_error?: string; }
const EMPTY: RecordingState = { pending: false, result: null, error: null, active: null };
type Transport = <T>(method: string, path: string) => Promise<T>;

/** Request results belong to the tab that invoked them, even after selection changes. */
export class PreviewRecordings {
  private states = new Map<string, RecordingState>();
  private listeners = new Set<() => void>();
  private focused: { endpoint: string; token: symbol } | null = null;

  constructor(private readonly transport: Transport = request) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  state(endpoint: string): RecordingState { return this.states.get(endpoint) ?? EMPTY; }
  owns(endpoint: string): boolean { return this.focused?.endpoint === endpoint; }

  observe(endpoint: string, status: RecordingStatus) {
    const state = this.state(endpoint);
    // Matching server observations acknowledge a confirmed mutation. Stale
    // opposite status cannot undo a successful Start/Stop after a failed read.
    if (!state.pending && state.active !== null &&
      (state.active === status.recording || (!status.recording && status.recording_error))) {
      this.publish(endpoint, { ...state, active: null });
    }
  }

  focus(endpoint: string): () => void {
    const token = Symbol();
    this.focused = { endpoint, token };
    return () => { if (this.focused?.token === token) this.focused = null; };
  }

  private publish(endpoint: string, state: RecordingState) {
    this.states.set(endpoint, state);
    for (const listener of this.listeners) listener();
  }

  async run(endpoint: string, choices: RecordingChoices | null, refresh: () => Promise<RecordingStatus | void>): Promise<void> {
    const previous = this.state(endpoint);
    if (previous.pending || (!choices && previous.active === false && previous.result)) return;
    this.publish(endpoint, { ...previous, pending: true, error: null });
    let result: PreviewRecording | null = null;
    try {
      if (choices) {
        const query = new URLSearchParams({
          fps: String(choices.fps),
          show_mouse_presses: String(choices.showMousePresses),
          show_key_presses: String(choices.showKeyPresses ?? false),
        });
        await this.transport<void>("POST", `${endpoint}?${query}`);
      } else {
        result = await this.transport<PreviewRecording>("DELETE", endpoint);
      }
    } catch (error) {
      this.publish(endpoint, { ...previous, pending: false, error: toFailure(error).message });
      return;
    }
    this.publish(endpoint, { pending: true, result, active: Boolean(choices), error: null });
    // A write is not cancelled by switching tabs. Its receipt stays with its
    // original identity; it cannot refresh a replacement thread or tab.
    let error: string | null = null;
    if (this.focused?.endpoint === endpoint) {
      try {
        const fresh = await refresh();
        if (fresh) {
          this.publish(endpoint, { pending: true, result, active: fresh.recording, error: fresh.recording_error ?? null });
        }
      }
      catch (failure) { error = `Couldn't refresh the page status. ${toFailure(failure).message}`; }
    }
    const confirmed = this.state(endpoint);
    this.publish(endpoint, { ...confirmed, pending: false, error: error ?? confirmed.error });
  }
}
