import type { ConnectConsent, PairingOffer, PhoneApproval, PhoneThread, SampleAccount } from "./types";

/** Obviously sample values. None of this is account state. */
export const sampleAccount: SampleAccount = { email: "sam@example.com" };

export const sampleConsent: ConnectConsent = {
  app: "Orbyn Planner",
  capabilities: [
    { grant: "zone", label: "Create tasks in your lists", state: "allow" },
    { grant: "busy", label: "See your calendar's busy times", state: "allow" },
    { grant: "links", label: "Link threads and pull requests to tasks", state: "allow" },
    { grant: "update-own", label: "Update the tasks it created", state: "allow" },
    { grant: "update-any", label: "Update any task", state: "separate" },
    { grant: "delete", label: "Delete tasks", state: "never" },
  ],
  lists: [
    { name: "Orbyn launch", granted: true },
    { name: "Bugs", granted: true },
    { name: "Home", granted: false },
    { name: "Shopping", granted: false },
  ],
};

export const samplePairing: PairingOffer = {
  code: "418 093",
  cells:
    "0000101100001011001010000001110001011010110111111111111011010110100011100111011100111001000101011010101111111100001011010",
  devices: [{ name: "Sam's iPhone", lastSeen: "Last seen 2m ago" }],
};

export const samplePhoneThreads: PhoneThread[] = [
  { id: "icon", title: "Project icon picker", state: "approval", note: "approval" },
  { id: "login", title: "Fix login redirect", state: "question", note: "question" },
  { id: "cost", title: "Usage cost filters", state: "working", note: "working" },
  { id: "shard", title: "Flaky E2E shard", state: "failed", note: "failed" },
  { id: "feed", title: "Calendar feed token", state: "done", note: "3h" },
];

export const samplePhoneApproval: PhoneApproval = {
  title: "Project icon picker",
  project: "orbyn-engineering",
  run: 3,
  said: "I need one package to compress uploaded images before saving them.",
  command: "npm install browser-image-compression",
  why: "Adds 1 package (48 kB)",
};
