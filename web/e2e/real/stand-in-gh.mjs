#!/usr/bin/env node
/**
 * Answers the `gh` calls the service makes, from a JSON file, so forge routes run with
 * no network. ORBYN_GH_STATE names the file; ORBYN_GH_LOG collects each call.
 */
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const statePath = process.env.ORBYN_GH_STATE;

// The service runs several of these at once, and each edits one file: without the
// lock a read sees a half-written file and two edits lose one. The service kills a
// call whose request went away, so a holder that has died no longer counts.
const lock = `${statePath}.lock`;
const pause = new Int32Array(new SharedArrayBuffer(4));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
for (;;) {
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    break;
  } catch {
    try {
      const holder = Number(readFileSync(lock, "utf8"));
      if (holder && !alive(holder)) rmSync(lock, { force: true });
    } catch {
      // Released between the two calls.
    }
    Atomics.wait(pause, 0, 0, 10);
  }
}
process.on("exit", () => rmSync(lock, { force: true }));

const state = JSON.parse(readFileSync(statePath, "utf8"));
appendFileSync(process.env.ORBYN_GH_LOG, `${JSON.stringify(args)}\n`);

const save = () => {
  // A rename, so the spec's own reads never catch it half done.
  writeFileSync(`${statePath}.${process.pid}`, JSON.stringify(state));
  renameSync(`${statePath}.${process.pid}`, statePath);
};
const flag = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const out = (value) => process.stdout.write(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value)}\n`);
const pull = (number) => state.pulls.find((entry) => entry.number === Number(number)) ?? fail("no pull request");

/** The fields only `gh pr view` shows, on top of a list row. */
const view = (entry) => ({
  comments: [],
  reviews: [],
  mergeable: "MERGEABLE",
  reviewRequests: (entry.reviewers ?? []).map((login) => ({ login })),
  headRefOid: "aaaaaaa",
  baseRefOid: "bbbbbbb",
  additions: 3,
  deletions: 1,
  changedFiles: 1,
  maintainerCanModify: false,
  autoMergeRequest: null,
  ...entry,
});

const threads = (number) => ({
  data: { repository: { pullRequest: { reviewThreads: { nodes: pull(number).threads ?? [] } } } },
});

const allThreads = () => state.pulls.flatMap((entry) => entry.threads ?? []);
const commentById = (id) =>
  state.pulls.flatMap((entry) => [...(entry.issueComments ?? []), ...(entry.threads ?? []).flatMap((thread) => thread.comments.nodes)]).find((comment) => String(comment.id ?? comment.databaseId) === id);

/** REST and GraphQL through `gh api`. Field flags are `key=value` strings. */
function apiCall() {
  const field = (name) => {
    for (let at = 0; at < args.length - 1; at += 1) {
      if ((args[at] === "-f" || args[at] === "-F") && args[at + 1].startsWith(`${name}=`)) return args[at + 1].slice(name.length + 1);
    }
    return undefined;
  };
  const method = flag("-X") ?? "GET";
  const path = args.find((arg, at) => at > 0 && /^(repos|graphql)/.test(arg)) ?? "";
  if (path === "graphql") {
    const query = field("query") ?? "";
    if (query.includes("reviewThreads")) return out(threads(field("number")));
    const thread = allThreads().find((entry) => entry.id === field("id"));
    if (thread) {
      thread.isResolved = query.includes("resolveReviewThread") && !query.includes("unresolve");
      save();
    }
    return out({ data: {} });
  }
  const local = path.replace("repos/{owner}/{repo}/", "");
  let match;
  if (local.startsWith("assignees")) return out(state.people.map((login) => ({ login })));
  if ((match = /^issues\/(\d+)\/comments/.exec(local))) return out(pull(match[1]).issueComments ?? []);
  if ((match = /^issues\/(\d+)\/timeline/.exec(local))) return out(pull(match[1]).timeline ?? []);
  if ((match = /^pulls\/(\d+)\/files/.exec(local))) return out(pull(match[1]).files ?? []);
  if ((match = /^pulls\/(\d+)\/comments\/(\d+)\/replies/.exec(local))) {
    const thread = (pull(match[1]).threads ?? []).find((entry) => entry.comments.nodes.some((comment) => String(comment.databaseId) === match[2]));
    thread.comments.nodes.push({ databaseId: state.next++, body: field("body"), author: { login: "me" } });
    save();
    return out({});
  }
  if ((match = /^(issues|pulls)\/comments\/(\d+)\/reactions/.exec(local))) {
    const comment = commentById(match[2]);
    comment.reactions = [...(comment.reactions ?? []), field("content")];
    save();
    return out({});
  }
  if ((match = /^(issues|pulls)\/comments\/(\d+)$/.exec(local))) {
    commentById(match[2]).body = field("body");
    save();
    return out({});
  }
  if ((match = /^pulls\/(\d+)\/reviews/.exec(local))) {
    pull(match[1]).submitted = JSON.parse(readFileSync(0, "utf8"));
    save();
    return out({});
  }
  if ((match = /^pulls\/(\d+)$/.exec(local)) && method === "PATCH") {
    pull(match[1]).maintainerCanModify = field("maintainer_can_modify") === "true";
    save();
    return out({});
  }
  if (/^actions\/runs\/\d+\/approve/.test(local)) return out({});
  if (/^git\/refs\/heads\//.test(local) && method === "DELETE") return out({});
  return fail(`stand-in gh has no api answer for: ${args.join(" ")}`);
}

const route = `${args[0]} ${args[1]}`;
if (args[0] === "api") {
  apiCall();
  process.exit(0);
}
switch (route) {
  case "auth status":
    process.stderr.write("Logged in to github.com\n");
    break;
  case "repo create":
    state.repos.push(args[2]);
    save();
    out(`https://github.com/o/${args[2]}`);
    break;
  case "label list":
    out(state.labels.map((name) => ({ name, description: `About ${name}` })));
    break;
  case "pr list":
    out(state.pulls.filter((entry) => (flag("--state") === "all" ? true : entry.state.toLowerCase() === flag("--state"))));
    break;
  case "pr view":
    out(view(pull(args[2])));
    break;
  case "pr checks":
    out(pull(args[2]).checks ?? []);
    break;
  case "pr create": {
    const number = state.next++;
    state.pulls.push({
      ...state.template,
      number,
      title: flag("--title"),
      body: flag("--body"),
      headRefName: flag("--head"),
      baseRefName: flag("--base") ?? "main",
      url: `https://github.com/o/r/pull/${number}`,
    });
    save();
    out(`https://github.com/o/r/pull/${number}`);
    break;
  }
  case "pr edit": {
    const entry = pull(args[2]);
    if (flag("--title")) entry.title = flag("--title");
    if (flag("--body") !== undefined) entry.body = flag("--body");
    if (flag("--base")) entry.baseRefName = flag("--base");
    if (flag("--add-reviewer")) entry.reviewers = [...(entry.reviewers ?? []), ...flag("--add-reviewer").split(",")];
    if (flag("--remove-reviewer")) entry.reviewers = (entry.reviewers ?? []).filter((name) => !flag("--remove-reviewer").split(",").includes(name));
    if (flag("--add-label")) entry.labels = [...entry.labels, ...flag("--add-label").split(",").map((name) => ({ name }))];
    if (flag("--remove-label")) entry.labels = entry.labels.filter((label) => !flag("--remove-label").split(",").includes(label.name));
    save();
    break;
  }
  case "pr ready":
    pull(args[2]).isDraft = args.includes("--undo");
    save();
    break;
  case "pr close":
    pull(args[2]).state = "CLOSED";
    save();
    break;
  case "pr reopen":
    pull(args[2]).state = "OPEN";
    save();
    break;
  case "pr merge":
    if (args.includes("--auto")) pull(args[2]).autoMergeRequest = {};
    else pull(args[2]).state = "MERGED";
    pull(args[2]).mergeBody = flag("--body");
    save();
    break;
  case "pr comment": {
    const entry = pull(args[2]);
    entry.issueComments = [...(entry.issueComments ?? []), { id: state.next++, body: flag("--body"), user: { login: "me" } }];
    save();
    break;
  }
  case "pr review":
    pull(args[2]).reviewed = args.find((arg) => /^--(approve|request-changes|comment)$/.test(arg));
    save();
    break;
  case "pr revert":
  case "pr update-branch":
    break;
  default:
    fail(`stand-in gh has no answer for: ${args.join(" ")}`);
}
