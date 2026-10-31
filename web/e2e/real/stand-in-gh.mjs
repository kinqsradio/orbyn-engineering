#!/usr/bin/env node
/**
 * Answers the `gh` calls the service makes, from a JSON file, so forge routes run with
 * no network. ORBYN_GH_STATE names the file; ORBYN_GH_LOG collects each call.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const statePath = process.env.ORBYN_GH_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
appendFileSync(process.env.ORBYN_GH_LOG, `${JSON.stringify(args)}\n`);

const save = () => writeFileSync(statePath, JSON.stringify(state));
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

const route = `${args[0]} ${args[1]}`;
switch (route) {
  case "auth status":
    process.stderr.write("Logged in to github.com\n");
    break;
  case "repo create":
    state.repos.push(args[2]);
    save();
    out(`https://github.com/o/${args[2]}`);
    break;
  case "pr list":
    out(state.pulls.filter((entry) => (flag("--state") === "all" ? true : entry.state.toLowerCase() === flag("--state"))));
    break;
  case "pr view":
    out(pull(args[2]));
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
  default:
    fail(`stand-in gh has no answer for: ${args.join(" ")}`);
}
