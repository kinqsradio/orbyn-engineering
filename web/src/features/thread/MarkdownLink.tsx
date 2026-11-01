import { useState, type MouseEvent, type ReactNode } from "react";
import { api } from "../../api/client";
import { navigate, parseRoute } from "../../state/route";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Menu } from "../../ui/Menu";

/** `orbyn://thread/<id>` opens a thread here. */
export const threadLinkId = (href: string): string | null =>
  /^orbyn:\/\/thread\/([\w-]+)$/.exec(href.trim())?.[1] ?? null;

/** A path relative to the checkout or absolute, with an optional line: `src/a.ts:12`. */
export function fileLinkTarget(raw: string): { path: string; line: number | null } | null {
  const href = raw.trim().replace(/^file:\/\//, "");
  if (!href || /^[a-z][a-z0-9+.-]*:\/\//i.test(href) || /^mailto:/i.test(href) || href.startsWith("#")) return null;
  const hash = /#L(\d+)(?:C\d+)?$/.exec(href);
  const colon = /:(\d+)(?::\d+)?$/.exec(href);
  const line = Number(hash?.[1] ?? colon?.[1]) || null;
  const path = decodeURI(href.replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, ""));
  return /[/.]/.test(path) ? { path, line } : null;
}

export function ThreadLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <a
      href={`#/threads/${encodeURIComponent(id)}`}
      className="md-thread-link"
      onClick={(event) => {
        event.preventDefault();
        navigate({ name: "thread", id });
      }}
    >
      {children}
    </a>
  );
}

export function FileLink({ path, line, children }: { path: string; line: number | null; children: ReactNode }) {
  const revealFile = useUi((state) => state.revealFile);
  return (
    <button type="button" className="md-file-link" title={line ? `${path}:${line}` : path} onClick={() => {
      const route = parseRoute(window.location.hash);
      const thread = route.name === "thread" ? useWorkspace.getState().threads[route.id] : null;
      if (thread) revealFile(path, line, { threadId: thread.id, cwd: thread.cwd });
    }}>
      {children}
    </button>
  );
}

/** The number in a pull request's address on a host. */
export const pullNumberOf = (href: string): number | null => {
  const match = /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pulls?\/(\d+)(?:[/?#].*)?$/.exec(href);
  return match ? Number(match[1]) : null;
};

/** The hash in a commit's address on a host. */
export const commitShaOf = (href: string): string | null =>
  /^https:\/\/[^/]+\/[^/]+\/[^/]+\/(?:-\/)?commit\/([0-9a-f]{7,40})(?:[/?#].*)?$/i.exec(href)?.[1] ?? null;

/** Shows a commit this checkout has in the Diff surface, and sends any other to the host. */
async function openCommit(threadId: string, sha: string, href: string) {
  const commits = await api.commits(threadId).catch(() => []);
  const local = commits.find((commit) => commit.sha.startsWith(sha));
  if (local) useUi.getState().revealCommit(local.sha);
  else window.open(href, "_blank", "noopener,noreferrer");
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const inApp = useUi((state) => state.pullLinksInApp);
  const number = pullNumberOf(href);
  const onContext = (event: MouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  };
  const onClick = (event: MouseEvent) => {
    if (number !== null && inApp) {
      event.preventDefault();
      useUi.getState().revealPull(number);
      return;
    }
    const commit = commitShaOf(href);
    const thread = /^#\/threads\/([^/?]+)/.exec(window.location.hash)?.[1];
    if (commit && thread) {
      event.preventDefault();
      void openCommit(decodeURIComponent(thread), commit, href);
      return;
    }
    const { linkTarget, showInBrowser } = useUi.getState();
    if (linkTarget !== "in-app" || !/^https?:/i.test(href) || !window.location.hash.startsWith("#/threads/")) return;
    event.preventDefault();
    showInBrowser(href);
  };
  return (
    <>
      <a href={href} target="_blank" rel="noreferrer noopener" onClick={onClick} onContextMenu={onContext}>
        {children}
      </a>
      {menu ? (
        <Menu
          x={menu.x}
          y={menu.y}
          label="Link"
          onClose={() => setMenu(null)}
          items={[
            {
              label: number === null ? "Open link" : "Open on the host",
              onSelect: () => void window.open(href, "_blank", "noopener,noreferrer"),
            },
            { label: "Copy link", onSelect: () => void navigator.clipboard?.writeText(href) },
          ]}
        />
      ) : null}
    </>
  );
}
