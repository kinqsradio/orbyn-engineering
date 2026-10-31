import { Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { SkillPackStatus, SkillProfile } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { Button, Field, Pill } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { useWorkspace } from "../../state/workspace";
import { FallbackNotice } from "./Workspace";

function Pack({ pack, onChange }: { pack: SkillPackStatus; onChange(pack: SkillPackStatus): void }) {
  const library = useWorkspace((state) => state.managed.data?.library ?? null);
  const fallback = useWorkspace((state) => state.managed.data?.skill_delivery === "fallback");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rebuild = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.rebuildSkills());
    } catch (failure) {
      setError(`Couldn't rebuild. ${toFailure(failure).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="section-bar">
        <h1 tabIndex={-1} data-page-title>
          Skills
        </h1>
        <Button small busy={busy} onClick={() => void rebuild()}>
          Rebuild pack
        </Button>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {fallback ? <FallbackNotice /> : null}
      <dl className="facts facts-block">
        <div>
          <dt>Library revision</dt>
          <dd>
            <code>{library?.revision.slice(0, 8) ?? pack.version}</code>
          </dd>
        </div>
        {library ? (
          <div>
            <dt>Changes</dt>
            <dd>{library.modified ? <Pill tone="warn">Modified</Pill> : "None"}</dd>
          </div>
        ) : null}
        <div>
          <dt>Source</dt>
          <dd>
            <code>{pack.source ?? "Bundled"}</code>
          </dd>
        </div>
        <div>
          <dt>Digest</dt>
          <dd>
            <code className="wrap-all">{pack.digest}</code>
          </dd>
        </div>
      </dl>
    </>
  );
}

function Profiles({ pack }: { pack: SkillPackStatus }) {
  const profiles = useAsync("profiles", (signal) => api.profiles(signal));
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SkillProfile | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createProfile({ id: "", name: name.trim(), skills: [...picked] });
      setName("");
      setPicked(new Set());
      profiles.reload();
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section">
      <h2>Profiles</h2>
      {profiles.status === "loading" ? (
        <Loading label="Loading profiles" rows={2} />
      ) : profiles.status === "error" ? (
        <ErrorState compact title="Couldn't load profiles" failure={profiles.error} onRetry={profiles.reload} />
      ) : profiles.data.length === 0 ? (
        <Empty title="No profiles yet" />
      ) : (
        <ul className="rows">
          {profiles.data.map((profile) => (
            <li key={profile.id} className="row">
              <span className="row-title">{profile.name}</span>
              <span className="row-meta">
                {profile.skills.length === 1 ? "1 skill" : `${profile.skills.length} skills`}
              </span>
              <Button
                small
                tone="quiet"
                aria-label={`Delete profile ${profile.name}`}
                icon={<Trash2 size={16} aria-hidden />}
                onClick={() => setRemoving(profile)}
              />
            </li>
          ))}
        </ul>
      )}
      <form className="form setting-form" onSubmit={(event) => void create(event)}>
        <h3>Add profile</h3>
        <Field label="Profile name">
          {(props) => <input {...props} value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <fieldset className="fieldset">
          <legend>Skills in this profile</legend>
          <div className="check-grid">
            {pack.skills.map((skill) => (
              <label key={skill.name} className="check">
                <input
                  type="checkbox"
                  checked={picked.has(skill.name)}
                  onChange={() => {
                    const next = new Set(picked);
                    if (!next.delete(skill.name)) next.add(skill.name);
                    setPicked(next);
                  }}
                />
                <span>{skill.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="form-actions">
          <Button type="submit" busy={busy} disabled={!name.trim() || picked.size === 0}>
            Add profile
          </Button>
        </div>
      </form>
      {removing ? (
        <ConfirmDialog
          title={`Delete ${removing.name}?`}
          confirmLabel="Delete profile"
          tone="danger"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api.deleteProfile(removing.id);
            profiles.reload();
          }}
        >
          <p>Threads using this profile fall back to all skills on their next run.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

export function SkillsSection() {
  const pack = useAsync("skills", (signal) => api.skills(signal));
  const [filter, setFilter] = useState("");
  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const map = new Map<string, SkillPackStatus["skills"]>();
    for (const skill of pack.data?.skills ?? []) {
      if (needle && !`${skill.name} ${skill.description}`.toLowerCase().includes(needle)) continue;
      map.set(skill.category, [...(map.get(skill.category) ?? []), skill]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [pack.data, filter]);

  if (pack.status === "loading") return <Loading label="Loading skills" />;
  if (pack.status === "error" && !pack.data) {
    return <ErrorState title="Couldn't load skills" failure={pack.error} onRetry={pack.reload} />;
  }
  const data = pack.data;
  if (!data) return null;

  return (
    <>
      <Pack pack={data} onChange={pack.setData} />
      <section className="section">
        <div className="section-bar">
          <h2>{data.skills.length === 1 ? "1 skill" : `${data.skills.length} skills`}</h2>
          <input
            type="search"
            className="filter"
            aria-label="Filter skills"
            placeholder="Filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        {groups.length === 0 ? (
          <Empty title="No matching skills">
            <Button small onClick={() => setFilter("")}>
              Clear filter
            </Button>
          </Empty>
        ) : (
          groups.map(([category, skills]) => (
            <div key={category} className="skill-group">
              <h3>{category}</h3>
              <ul className="rows">
                {skills.map((skill) => (
                  <li key={skill.name} className="row row-stack">
                    <span className="row-title">
                      {skill.name}
                      {skill.enabled ? null : <Pill>Off</Pill>}
                    </span>
                    <span className="row-meta">{skill.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
      <Profiles pack={data} />
    </>
  );
}
