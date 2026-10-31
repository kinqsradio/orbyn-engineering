/** Notifications a turn plays, in Codex's wire shape, for content the double doesn't cover. */
const item = (id, type, extra) => ({ id, type, ...extra });
const started = (body) => ({ method: "item/started", params: { startedAtMs: 1, item: body } });
const completed = (body) => ({ method: "item/completed", params: { completedAtMs: 2, item: body } });

const command = (id, line, output, exitCode) => [
  started(item(id, "commandExecution", { command: line, cwd: "/repo", commandActions: [], status: "inProgress" })),
  { method: "item/commandExecution/outputDelta", params: { itemId: id, delta: output } },
  completed(item(id, "commandExecution", { command: line, cwd: "/repo", commandActions: [], status: "completed", aggregatedOutput: output, exitCode })),
];

const fileChange = (id, paths) => [
  started(item(id, "fileChange", { status: "inProgress", changes: paths.map((path) => ({ path, kind: { type: "update" }, diff: "" })) })),
  completed(item(id, "fileChange", { status: "completed", changes: paths.map((path) => ({ path, kind: { type: "update" }, diff: "" })) })),
];

const message = (id, text) => [
  started(item(id, "agentMessage", { text: "" })),
  { method: "item/agentMessage/delta", params: { itemId: id, delta: text } },
  completed(item(id, "agentMessage", { text })),
];

const MARKDOWN = `## Results

| Planet | Moons |
| --- | --- |
| Earth | 1 |
| Mars | 2 |

Inline math $e^{i\\pi} + 1 = 0$ costs $5 and $6 to print.

$$
\\int_0^1 x^2 \\, dx
$$

\`\`\`mermaid
graph TD
  A[Start] --> B[End]
\`\`\`

See [the readme](README.md:1), [another thread](orbyn://thread/THREAD), and [the docs](https://example.com/docs).

![a square](https://example.com/square.png)

<details>
<summary>More notes</summary>

Hidden detail
</details>
`;

const LIMIT_TEXT = "You've hit your usage limit.";
const limitStop = (resetsAt) => [
  { method: "error", params: { willRetry: false, error: { message: LIMIT_TEXT, codexErrorInfo: "usageLimitExceeded", resetsAt } } },
  { end: "failed" },
];

export const scenes = {
  limit: limitStop(4102444800),
  "limit-open": limitStop(undefined),
  get "limit-soon"() {
    return limitStop(Math.floor(Date.now() / 1000) + 2);
  },
  timeline: [
    started(item("rs1", "reasoning", {})),
    { method: "item/reasoning/summaryTextDelta", params: { itemId: "rs1", summaryIndex: 0, delta: "planning" } },
    completed(item("rs1", "reasoning", {})),
    ...message("note", "I'll look around first."),
    ...command("c1", "ls -la", "\u001b[32mREADME.md\u001b[0m\n", 0),
    ...command("c2", "cat missing.txt", "cat: missing.txt: No such file\n", 1),
    ...fileChange("f1", ["src/a.ts", "src/b.ts"]),
    started(item("w1", "webSearch", { query: "tides" })),
    completed(item("w1", "webSearch", { query: "tides" })),
    { method: "turn/plan/updated", params: { explanation: null, plan: [{ step: "Read", status: "completed" }, { step: "Write", status: "inProgress" }] } },
    { method: "turn/diff/updated", params: { diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n" } },
    ...message("final", "All **done**."),
  ],
  live: [
    ...command("l1", "npm test", "running\n", 0),
    started(item("l2", "commandExecution", { command: "sleep 100", cwd: "/repo", commandActions: [], status: "inProgress" })),
    { method: "item/commandExecution/outputDelta", params: { itemId: "l2", delta: "tick\n" } },
    { hold: true },
  ],
  deaf: [...command("d1", "sleep 100", "tick\n", 0), { deaf: true }],
  edit: [
    started(item("e1", "fileChange", { status: "inProgress", changes: [{ path: "notes.txt", kind: { type: "update" }, diff: "" }] })),
    { write: { path: "notes.txt", text: "changed by the agent\n" } },
    completed(item("e1", "fileChange", { status: "completed", changes: [{ path: "notes.txt", kind: { type: "update" }, diff: "" }] })),
    ...message("e2", "Edited."),
  ],
  markdown: message("md", MARKDOWN),
  empty: command("q1", "true", "", 0),
  subagent: [
    started(item("sa1", "collabAgentToolCall", { tool: "spawnAgent", status: "inProgress", agentPath: "researcher" })),
    { hold: true },
  ],
  plan: message("pl", `Here is the plan.

<proposed_plan>
# Tidy the readme

${Array.from({ length: 30 }, (_, at) => `- Step ${at + 1}`).join("\n")}
</proposed_plan>`),
  usage: [
    { method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { totalTokens: 600 }, last: { totalTokens: 20 }, modelContextWindow: 1000 } } },
    ...message("us", "Counted."),
  ],
  large: [
    { method: "turn/diff/updated", params: { diff: ["a", "b", "c"].map((name) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-x\n+y\n`).join("") } },
    ...message("lg", "Changed a lot."),
  ],
  long: message("ln", Array.from({ length: 120 }, (_, at) => `Paragraph ${at + 1} of a long answer.`).join("\n\n")),
  stream: [
    ...message("st", Array.from({ length: 60 }, (_, at) => `Streamed line ${at + 1}.`).join("\n\n")),
    ...Array.from({ length: 40 }, (_, at) => [
      { wait: 150 },
      started(item(`s${at}`, "agentMessage", { text: "" })),
      { method: "item/agentMessage/delta", params: { itemId: `s${at}`, delta: `Tick ${at}.` } },
      completed(item(`s${at}`, "agentMessage", { text: `Tick ${at}.` })),
    ]).flat(),
  ],
  failure: [
    ...message("partial", "Starting."),
    { end: "failed", error: { message: "The engine stopped: disk full" } },
  ],
};
