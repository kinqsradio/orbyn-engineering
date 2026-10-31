import { Check, ChevronDown, CloudUpload, GitBranch, GitCommitHorizontal, GitPullRequest, Plus, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { useCommand } from "../../app/shortcuts";
import type { BranchInfo, GitActionResult, GitPhase, Thread } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button, Field } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { Menu, type MenuItem } from "../../ui/Menu";

interface Plan {
  title: string;
  commit: boolean;
  push: boolean;
  pull: boolean;
}

const PLANS: { label: string; plan: Plan; icon: typeof Upload }[] = [
  { label: "Commit", plan: { title: "Commit", commit: true, push: false, pull: false }, icon: GitCommitHorizontal },
  { label: "Commit and push", plan: { title: "Commit and push", commit: true, push: true, pull: false }, icon: Upload },
  {
    label: "Commit, push and create pull request",
    plan: { title: "Commit, push and create pull request", commit: true, push: true, pull: true },
    icon: GitPullRequest,
  },
  { label: "Push", plan: { title: "Push", commit: false, push: true, pull: false }, icon: Upload },
  {
    label: "Create pull request",
    plan: { title: "Create pull request", commit: false, push: true, pull: true },
    icon: GitPullRequest,
  },
];

const PHASE_NAMES: Record<string, string> = { commit: "Commit", push: "Push", pull_request: "Pull request" };

function Phase({ phase }: { phase: GitPhase }) {
  return (
    <li>
      {phase.ok ? (
        <Check size={14} className="tone-success" role="img" aria-label="Done" />
      ) : (
        <X size={14} className="tone-danger" role="img" aria-label="Failed" />
      )}
      <span>{PHASE_NAMES[phase.name] ?? phase.name}</span>
      {phase.url ? (
        <a href={phase.url} target="_blank" rel="noreferrer">
          {phase.url}
        </a>
      ) : phase.message ? (
        <small>{phase.message}</small>
      ) : null}
    </li>
  );
}

function GitActionDialog({ thread, plan, onClose }: { thread: Thread; plan: Plan; onClose(): void }) {
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState(thread.title);
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GitActionResult | null>(null);
  const branches = useAsync(`git-bases:${thread.id}`, (signal) => api.branches(thread.id, signal));
  const bases = (branches.data ?? []).filter((branch) => !branch.remote && !branch.current);
  const ready = (!plan.commit || message.trim() !== "") && (!plan.pull || title.trim() !== "");
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await api.gitAction(thread.id, {
        ...(plan.commit ? { commit_message: message } : {}),
        push: plan.push,
        ...(plan.pull ? { pull_request: { title, body, ...(base ? { base } : {}) } } : {}),
      });
      setResult(done);
      useThreadLogs.getState().touchDiff(thread.id);
      void useWorkspace.getState().refreshThread(thread.id);
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(false);
    }
  };
  if (result) {
    return (
      <Dialog title={plan.title} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
        <ul className="git-phases" aria-label="Result">
          {result.phases.map((phase) => (
            <Phase key={phase.name} phase={phase} />
          ))}
        </ul>
      </Dialog>
    );
  }
  return (
    <Dialog
      title={plan.title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button tone="primary" busy={busy} disabled={!ready} onClick={() => void run()}>
            {plan.title}
          </Button>
        </>
      }
    >
      {plan.commit ? (
        <Field label="Commit message">
          {(props) => <textarea {...props} rows={3} value={message} autoFocus onChange={(event) => setMessage(event.target.value)} />}
        </Field>
      ) : null}
      {plan.pull ? (
        <>
          <Field label="Pull request title">
            {(props) => <input {...props} value={title} onChange={(event) => setTitle(event.target.value)} />}
          </Field>
          <Field label="Description">
            {(props) => <textarea {...props} rows={4} value={body} onChange={(event) => setBody(event.target.value)} />}
          </Field>
          <Field label="Base branch">
            {(props) => (
              <select {...props} value={base} onChange={(event) => setBase(event.target.value)}>
                <option value="">Repository default</option>
                {bases.map((branch) => (
                  <option key={branch.name} value={branch.name}>
                    {branch.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </>
      ) : null}
      {!plan.commit && !plan.pull ? <p>Pushes the current branch to origin.</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function PublishDialog({ thread, onClose }: { thread: Thread; onClose(): void }) {
  const project = useWorkspace((state) => state.projects.data?.find((entry) => entry.id === thread.project_id));
  const [name, setName] = useState(project?.name ?? "");
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pushToast = useUi((state) => state.pushToast);
  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.publishProject(thread.project_id, { name, private: isPrivate });
      pushToast("Published");
      onClose();
    } catch (failure) {
      setError(toFailure(failure).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Publish repository"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button tone="primary" busy={busy} disabled={!name.trim()} onClick={() => void publish()}>
            Publish
          </Button>
        </>
      }
    >
      <Field label="Repository name">
        {(props) => <input {...props} value={name} onChange={(event) => setName(event.target.value)} />}
      </Field>
      <label className="check">
        <input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)} />
        <span>Private</span>
      </label>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** Commit, push and pull request for the open thread, in one menu in its header. */
export function GitActions({ thread }: { thread: Thread }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [publishing, setPublishing] = useState(false);
  const branches = useAsync(`git-branches:${thread.id}`, (signal) => api.branches(thread.id, signal));
  if (branches.status === "error" || thread.active_run) return null;
  const hasRemote = branches.data?.some((branch) => branch.remote) ?? false;
  const items: MenuItem[] = [
    ...PLANS.map(({ label, plan: choice, icon: Icon }) => ({
      label,
      icon: <Icon size={14} aria-hidden />,
      onSelect: () => setPlan(choice),
    })),
    {
      label: "Publish repository",
      icon: <CloudUpload size={14} aria-hidden />,
      separatorBefore: true,
      disabled: hasRemote,
      onSelect: () => setPublishing(true),
    },
  ];
  return (
    <>
      <button
        type="button"
        className="git-trigger"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <GitCommitHorizontal size={14} aria-hidden />
        Git
        <ChevronDown size={12} aria-hidden />
      </button>
      {anchor ? <Menu x={anchor.x} y={anchor.y} label="Git actions" items={items} onClose={() => setAnchor(null)} /> : null}
      {plan ? <GitActionDialog thread={thread} plan={plan} onClose={() => setPlan(null)} /> : null}
      {publishing ? <PublishDialog thread={thread} onClose={() => setPublishing(false)} /> : null}
    </>
  );
}

function rowsFor(branches: BranchInfo[], query: string) {
  const needle = query.trim().toLowerCase();
  const found = branches.filter((branch) => branch.name.toLowerCase().includes(needle));
  return [...found.filter((branch) => branch.current), ...found.filter((branch) => !branch.current)];
}

/** Lists the checkout's branches. Picking one switches; a new name creates it. */
function BranchDialog({ thread, onClose }: { thread: Thread; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const branches = useAsync(`branch-list:${thread.id}`, (signal) => api.branches(thread.id, signal));
  const rows = useMemo(() => rowsFor(branches.data ?? [], query), [branches.data, query]);
  const name = query.trim();
  const exists = (branches.data ?? []).some((branch) => branch.name === name);
  const act = async (effect: Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await effect;
      void useWorkspace.getState().refreshAll();
      useThreadLogs.getState().touchDiff(thread.id);
      onClose();
    } catch (failure) {
      setError(toFailure(failure).message);
      setBusy(false);
    }
  };
  return (
    <Dialog title="Switch branch" onClose={onClose} busy={busy}>
      <input
        aria-label="Search branches"
        placeholder="Search or name a new branch"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="branch-list" aria-label="Branches">
        {rows.map((branch) => (
          <li key={branch.name}>
            <button type="button" disabled={busy || branch.current} onClick={() => void act(api.switchBranch(thread.id, branch.name))}>
              <GitBranch size={14} aria-hidden />
              <span>{branch.name}</span>
              {branch.current ? <Check size={14} aria-label="Current branch" /> : null}
            </button>
          </li>
        ))}
        {name && !exists ? (
          <li>
            <button type="button" disabled={busy} onClick={() => void act(api.createBranch(thread.id, name))}>
              <Plus size={14} aria-hidden />
              <span>Create {name}</span>
            </button>
          </li>
        ) : null}
      </ul>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** The branch row of the details card, which opens the switcher. */
export function BranchRow({ thread, branch }: { thread: Thread; branch: string }) {
  const [open, setOpen] = useState(false);
  useCommand("composer.branch", () => {
    if (thread.active_run) return false;
    setOpen(true);
  });
  return (
    <>
      <button
        type="button"
        className="detail-row"
        title={thread.cwd}
        aria-label={`Branch ${branch}`}
        disabled={thread.active_run !== null}
        onClick={() => setOpen(true)}
      >
        <GitBranch size={16} aria-hidden />
        <span>{branch}</span>
      </button>
      {open ? <BranchDialog thread={thread} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
