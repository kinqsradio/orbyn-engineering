import { slugify } from "../../lib/format";

const TAGGED = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/;

/** The plan inside a message, if the agent proposed one. */
export const proposedPlanIn = (text: string): string | null => TAGGED.exec(text)?.[1] ?? null;

/** What the message says around the plan. */
export const textAroundPlan = (text: string): string => text.replace(TAGGED, "").trim();

export function planTitle(plan: string): string | null {
  return /^\s{0,3}#{1,6}\s+(.+)$/m.exec(plan)?.[1]?.trim() || null;
}

export function stripPlanTitle(plan: string): string {
  const lines = plan.trimEnd().split(/\r?\n/);
  const rest = /^\s{0,3}#{1,6}\s+/.test(lines[0] ?? "") ? lines.slice(1) : lines;
  return rest.join("\n").trimStart();
}

export const planFilename = (plan: string) => `${slugify(planTitle(plan) ?? "plan") || "plan"}.md`;

export const implementPrompt = (plan: string) => `PLEASE IMPLEMENT THIS PLAN:\n${plan.trim()}`;
