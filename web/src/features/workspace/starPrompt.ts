/** The two ledger entries stay separate so a counter never overwrites a dismissal. */
const COUNT = "orbyn:github-star:sent";
const CLOSED = "orbyn:github-star:dismissed";
type Ledger = Pick<Storage, "getItem" | "setItem">;

export class StarPromptSession {
  private phase: "counting" | "checking" | "done" = "counting";
  constructor(
    private readonly storage: () => Ledger,
    private readonly starred: () => Promise<boolean>,
    private readonly present: (dismiss: () => void) => void,
  ) {}

  private dismissed(): boolean {
    const raw = this.storage().getItem(CLOSED);
    if (raw === null) return false;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "boolean") throw new Error("Invalid dismissal");
    return value;
  }

  private close = () => {
    this.phase = "done";
    try { this.storage().setItem(CLOSED, "true"); } catch { /* The session stays closed. */ }
  };

  /** Only acknowledged composer submissions call this, never background engine work. */
  async sent(): Promise<void> {
    if (this.phase !== "counting") return;
    try {
      if (this.dismissed()) { this.phase = "done"; return; }
      const raw = this.storage().getItem(COUNT);
      const count: unknown = raw === null ? 0 : JSON.parse(raw);
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("Invalid count");
      const next = Math.min(count + 1, 6);
      this.storage().setItem(COUNT, String(next));
      if (next < 6) return;
    } catch {
      this.phase = "done";
      return; // A client that cannot keep a dismissal must not ask.
    }
    this.phase = "checking";
    let starred = false;
    try { starred = await this.starred(); } catch { /* An unavailable check is not a star. */ }
    this.phase = "done";
    if (starred) { this.close(); return; }
    try {
      if (!this.dismissed()) this.present(this.close);
    } catch { /* Another tab or a storage failure can suppress the prompt. */ }
  }
}
