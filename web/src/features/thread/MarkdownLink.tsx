import { useState, type MouseEvent, type ReactNode } from "react";
import { navigate } from "../../state/route";
import { useUi } from "../../state/ui";
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
    <button type="button" className="md-file-link" title={line ? `${path}:${line}` : path} onClick={() => revealFile(path, line)}>
      {children}
    </button>
  );
}

/** The number in a pull request's address on a host. */
export const pullNumberOf = (href: string): number | null => {
  const match = /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pulls?\/(\d+)(?:[/?#].*)?$/.exec(href);
  return match ? Number(match[1]) : null;
};

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
