#!/usr/bin/env node
/**
 * Stands in for the Claude binary over the repo's protocol double, adding the usage
 * report in `ORBYN_E2E_USAGE` to each turn's `result`, as the real CLI reports one.
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";

const usage = JSON.parse(process.env.ORBYN_E2E_USAGE ?? "null");
const child = spawn(process.env.ORBYN_E2E_FAKE, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(`${line}\n`);
    return;
  }
  if (message?.type === "result" && usage) message.usage = usage;
  process.stdout.write(`${JSON.stringify(message)}\n`);
});
child.on("exit", (code) => process.exit(code ?? 1));
