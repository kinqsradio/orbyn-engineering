import { KeyRound } from "lucide-react";
import { Button } from "../../ui/controls";
import { unavailable, SampleNotice } from "./Unavailable";
import type { SampleAccount } from "./types";

/** Sign in to Orbyn: optional, and Engineering works fully without it. */
export function AccountCard({ account }: { account: SampleAccount }) {
  return (
    <main className="standalone platform-standalone">
      <form className="standalone-card" onSubmit={(event) => event.preventDefault()} aria-labelledby="platform-account-title">
        <SampleNotice />
        <span className="brand">
          <span className="brand-mark" aria-hidden />
          Orbyn
        </span>
        <h1 id="platform-account-title">Sign in to Orbyn</h1>
        <p className="standalone-lede">One Orbyn account for Engineering, Planner and every Orbyn app.</p>
        <label className="platform-label">
          Email
          <input type="email" defaultValue={account.email} autoComplete="off" {...unavailable} />
        </label>
        <label className="platform-label">
          Password
          <input type="password" defaultValue="sample-password" autoComplete="off" {...unavailable} />
        </label>
        <Button tone="primary" {...unavailable}>
          Sign in
        </Button>
        <Button icon={<KeyRound size={16} aria-hidden />} {...unavailable}>
          Use a passkey
        </Button>
        <p className="platform-hint">Optional. Engineering works fully without an account.</p>
      </form>
    </main>
  );
}
