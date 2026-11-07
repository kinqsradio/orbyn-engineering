/**
 * Props for the platform screens, shaped after the Orbyn connected-apps model. They are
 * display-only: no engine endpoint, API client method or generated type backs them yet.
 */

/** What a connected app may do. `zone` is per list; the rest are account-wide. */
export type GrantKind = "zone" | "busy" | "links" | "update-own" | "update-any" | "delete";

export interface CapabilityRow {
  grant: GrantKind;
  label: string;
  /** `allow` is granted, `never` is withheld by default, `separate` is asked for on its own. */
  state: "allow" | "never" | "separate";
}

export interface ListGrant {
  name: string;
  granted: boolean;
}

export interface ConnectConsent {
  app: string;
  capabilities: CapabilityRow[];
  lists: ListGrant[];
}

export interface SampleAccount {
  email: string;
}

export interface PairedDevice {
  name: string;
  lastSeen: string;
}

export interface PairingOffer {
  /** The same six digits show on the host and on the phone before the phone is trusted. */
  code: string;
  /** Sample cells, row by row, "1" is dark. Not a scannable code. */
  cells: string;
  devices: PairedDevice[];
}

export type PhoneThreadState = "approval" | "question" | "working" | "failed" | "done";

export interface PhoneThread {
  id: string;
  title: string;
  state: PhoneThreadState;
  /** Shown at the right: the state word, or how long ago for a finished thread. */
  note: string;
}

export interface PhoneApproval {
  title: string;
  project: string;
  run: number;
  said: string;
  command: string;
  why: string;
}
