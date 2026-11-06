import {
  CircleCheck,
  CircleDashed,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  UserCheck,
  UserRound,
  UserRoundX,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PullRequest } from "../../api/types";
import { compactAge } from "../../lib/format";
import { pullRepositoryLabel, samePullRequest } from "./pullLink";
import { pullsApi } from "../../api/pulls";

const CARD_WIDTH = 320;
const CARD_HEIGHT = 150;
const GAP = 6;

export interface PullBadge {
  label: string;
  className: string;
  Icon: LucideIcon;
}

/** The card's one-line state, in the same words as the pull list. */
export function pullState(pull: Pick<PullRequest, "state" | "draft">): PullBadge {
  if (pull.state === "open" && pull.draft) {
    return { label: "Draft", className: "muted", Icon: GitPullRequestDraft };
  }
  if (pull.state === "merged") {
    return { label: "Merged", className: "tone-info", Icon: GitMerge };
  }
  if (pull.state === "closed") {
    return { label: "Closed", className: "tone-danger", Icon: GitPullRequestClosed };
  }
  return { label: "Open", className: "tone-success", Icon: GitPullRequest };
}

export function pullChecks(state: string | null): PullBadge | null {
  if (state === "pass") return { label: "Checks passing", className: "tone-success", Icon: CircleCheck };
  if (state === "fail") return { label: "Checks failing", className: "tone-danger", Icon: CircleX };
  if (state === "pending") return { label: "Checks running", className: "tone-warn", Icon: CircleDashed };
  return null;
}

export function pullReview(state: string | null): PullBadge | null {
  if (state === "approved") return { label: "Approved", className: "tone-success", Icon: UserCheck };
  if (state === "changes_requested") {
    return { label: "Changes requested", className: "tone-warn", Icon: UserRoundX };
  }
  if (state === "review_required") return { label: "Awaiting review", className: "muted", Icon: UserRound };
  return null;
}

/** Beside the link when it fits, above it near the bottom edge, and inside the viewport. */
export function pullPreviewPlacement(
  anchor: Pick<DOMRect, "left" | "top" | "bottom">,
  viewport = { width: window.innerWidth, height: window.innerHeight },
): { left: number; top: number; above: boolean } {
  const left = Math.min(Math.max(8, anchor.left), Math.max(8, viewport.width - CARD_WIDTH - 8));
  const below = anchor.bottom + GAP;
  const above = below + CARD_HEIGHT > viewport.height && anchor.top - GAP - CARD_HEIGHT >= 8;
  return { left, top: above ? anchor.top - GAP : below, above };
}

/**
 * A pull request's title, state and checks after hovering its link. Reads the
 * link's own project, and stays quiet when that project has no such pull.
 */
export function PullLinkPreview({
  href,
  number,
  projectId,
  anchor,
}: {
  href: string;
  number: number;
  projectId: string;
  anchor: DOMRect;
}) {
  const [pull, setPull] = useState<PullRequest | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setPull(null);
    pullsApi.detail(projectId, number, controller.signal).then(
      (detail) => {
        if (samePullRequest(detail.pull.url, href)) setPull(detail.pull);
      },
      (error: unknown) => {
        // A missing or forbidden pull request simply shows no card.
        if (error instanceof DOMException && error.name === "AbortError") return;
      },
    );
    return () => controller.abort();
  }, [href, number, projectId]);
  if (!pull) return null;

  const state = pullState(pull);
  const checks = pullChecks(pull.checks_state);
  const review = pullReview(pull.review_state);
  const repository = pullRepositoryLabel(pull.url);
  const placement = pullPreviewPlacement(anchor);
  const author = pull.author ?? "No author";
  return createPortal(
    <div
      className="hover-card"
      role="tooltip"
      data-pull-preview
      style={{
        left: placement.left,
        top: placement.top,
        transform: placement.above ? "translateY(-100%)" : undefined,
      }}
    >
      <p className="hover-card-title">{pull.title}</p>
      <div className="hover-card-rows">
        <div>
          <state.Icon size={12} className={state.className} aria-hidden />
          <span>
            {repository ? `${repository}#${pull.number}` : `#${pull.number}`} · {state.label}
          </span>
        </div>
        <div>
          <UserRound size={12} aria-hidden />
          <span>
            {author}
            {pull.updated_at ? ` · updated ${compactAge(pull.updated_at)}` : ""}
          </span>
        </div>
        {checks ? (
          <div>
            <checks.Icon size={12} className={checks.className} aria-hidden />
            <span>{checks.label}</span>
          </div>
        ) : null}
        {review ? (
          <div>
            <review.Icon size={12} className={review.className} aria-hidden />
            <span>{review.label}</span>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
