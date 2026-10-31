import { Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { ActionKind, PolicyEffect, PolicyRule } from "../../api/types";
import { actionLabels } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { Button, Field, Pill, type PillTone } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { Empty, ErrorState, Loading } from "../../ui/states";

const effects: { value: PolicyEffect; label: string; tone: PillTone; meaning: string }[] = [
  { value: "allow", label: "Allow", tone: "neutral", meaning: "Runs without asking." },
  { value: "ask", label: "Ask", tone: "info", meaning: "Waits for your approval." },
  { value: "deny", label: "Deny", tone: "danger", meaning: "Refused, even if an allow rule matches." },
];

const kinds = Object.keys(actionLabels) as ActionKind[];

function RuleForm({ onAdded }: { onAdded(): void }) {
  const engines = useWorkspace((state) => state.engines.data);
  const [effect, setEffect] = useState<PolicyEffect>("ask");
  const [kind, setKind] = useState<ActionKind>("command");
  const [pattern, setPattern] = useState("");
  const [engine, setEngine] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createRule({
        effect,
        kind,
        pattern: pattern.trim(),
        engine: engine || null,
        note: note.trim() || null,
      });
      setPattern("");
      setNote("");
      onAdded();
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form setting-form" onSubmit={(event) => void submit(event)}>
      <h3>Add rule</h3>
      <div className="form-grid">
        <Field label="Effect" hint={effects.find((e) => e.value === effect)?.meaning}>
          {(props) => (
            <select {...props} value={effect} onChange={(event) => setEffect(event.target.value as PolicyEffect)}>
              {effects.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Action">
          {(props) => (
            <select {...props} value={kind} onChange={(event) => setKind(event.target.value as ActionKind)}>
              {kinds.map((entry) => (
                <option key={entry} value={entry}>
                  {actionLabels[entry]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field label="Target pattern" hint="Use * as a wildcard, for example cargo test*.">
        {(props) => (
          <input
            {...props}
            required
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
          />
        )}
      </Field>
      <div className="form-grid">
        <Field label="Engine">
          {(props) => (
            <select {...props} value={engine} onChange={(event) => setEngine(event.target.value)}>
              <option value="">Any engine</option>
              {(engines ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Note (optional)">
          {(props) => <input {...props} value={note} onChange={(event) => setNote(event.target.value)} />}
        </Field>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <Button type="submit" busy={busy} disabled={!pattern.trim()}>
          Add rule
        </Button>
      </div>
    </form>
  );
}

export function PolicySection() {
  const rules = useAsync("rules", (signal) => api.rules(signal));
  const engines = useWorkspace((state) => state.engines.data);
  const [removing, setRemoving] = useState<PolicyRule | null>(null);

  return (
    <>
      <div className="section-bar">
        <h1 tabIndex={-1} data-page-title>
          Policy
        </h1>
      </div>
      <p className="lede">Deny wins over allow. An action no rule matches asks you first.</p>
      <dl className="effects">
        {effects.map((entry) => (
          <div key={entry.value}>
            <dt>
              <Pill tone={entry.tone}>{entry.label}</Pill>
            </dt>
            <dd>{entry.meaning}</dd>
          </div>
        ))}
      </dl>
      {rules.status === "loading" ? (
        <Loading label="Loading rules" />
      ) : rules.status === "error" ? (
        <ErrorState title="Couldn't load rules" failure={rules.error} onRetry={rules.reload} />
      ) : rules.data.length === 0 ? (
        <Empty title="No rules yet" />
      ) : (
        <ul className="rows rule-list">
          {rules.data.map((rule) => {
            const effect = effects.find((entry) => entry.value === rule.effect);
            return (
              <li key={rule.id} className="row rule">
                <Pill tone={effect?.tone}>{effect?.label ?? rule.effect}</Pill>
                <span className="row-grow">
                  <code className="rule-pattern">{rule.pattern}</code>
                  <span className="row-meta">
                    {[
                      actionLabels[rule.kind],
                      rule.engine
                        ? (engines?.find((e) => e.id === rule.engine)?.name ?? rule.engine)
                        : "Any engine",
                      rule.note,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <Button
                  small
                  tone="quiet"
                  aria-label={`Delete rule ${rule.pattern}`}
                  icon={<Trash2 size={16} aria-hidden />}
                  onClick={() => setRemoving(rule)}
                />
              </li>
            );
          })}
        </ul>
      )}
      <RuleForm onAdded={rules.reload} />
      {removing ? (
        <ConfirmDialog
          title="Delete rule?"
          confirmLabel="Delete rule"
          tone="danger"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api.deleteRule(removing.id);
            rules.reload();
          }}
        >
          <p>
            <code>{removing.pattern}</code> stops applying to new actions. Actions without a matching
            rule ask you first.
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
