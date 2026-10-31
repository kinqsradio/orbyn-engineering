import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { toFailure } from "../../lib/useAsync";
import { Button, Field } from "../../ui/controls";

const isLoopback = (host: string) =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

export function SignIn({ onSignedIn }: { onSignedIn(): void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = isLoopback(window.location.hostname);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.signIn(key.trim());
      setKey("");
      onSignedIn();
    } catch (failure) {
      const known = toFailure(failure);
      setError(known.status === 401 ? "That access key isn't valid." : known.message);
      setBusy(false);
    }
  };

  return (
    <main className="standalone">
      <form className="standalone-card" onSubmit={(event) => void submit(event)}>
        <span className="brand">
          <span className="brand-mark" aria-hidden />
          Orbyn Engineering
        </span>
        <h1 tabIndex={-1} data-page-title>
          Sign in to this service
        </h1>
        <p className="standalone-lede">
          {local
            ? "This session needs its launch link, or an access key if the service runs in remote mode."
            : "Enter the access key set for this service."}
        </p>
        <Field label="Access key" error={error}>
          {(props) => (
            <input
              {...props}
              type="password"
              autoComplete="current-password"
              value={key}
              autoFocus
              onChange={(event) => setKey(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" tone="primary" busy={busy} disabled={!key.trim()}>
          Sign in
        </Button>
      </form>
    </main>
  );
}
