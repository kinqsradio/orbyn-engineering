#!/usr/bin/env node
/**
 * Stands in for the Codex binary. Everything goes to the repo's protocol double,
 * except a turn whose prompt names `[scene:<name>]`: that turn plays the notifications
 * in `scenes.mjs`, so the real service parses content the double has no scenario for.
 */
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers";
import { scenes } from "./scenes.mjs";

const fake = process.env.ORBYN_E2E_FAKE;
const args = process.argv.slice(2);
if (args[0] !== "app-server") {
  const child = spawn(fake, args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  const child = spawn(fake, args, { stdio: ["pipe", "pipe", "inherit"] });
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const pending = new Map();
  let thread = "";
  let turn = 0;
  let waiting = null;
  let deaf = false;
  let checkout = "";

  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (pending.get(message.id) === "thread" && message.result?.thread?.id) thread = message.result.thread.id;
    pending.delete(message.id);
    process.stdout.write(`${line}\n`);
  });
  child.on("exit", (code) => process.exit(code ?? 1));

  const delay = (ms) => new Promise((done) => setTimeout(done, ms));
  const note = (id, method, params) => send({ method, params: { threadId: thread, turnId: id, ...params } });
  const finish = (id, status, error) =>
    send({ method: "turn/completed", params: { threadId: thread, turn: { id, items: [], status, error: error ?? null } } });

  const play = async (name, id) => {
    for (const step of scenes[name] ?? []) {
      if (step.wait) await delay(step.wait);
      if (step.write) writeFileSync(join(checkout, step.write.path), step.write.text);
      if (step.hold) await new Promise((done) => (waiting = done));
      if (step.deaf) {
        deaf = true;
        await new Promise(() => {});
      }
      if (step.headLink) {
        const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
        for (const part of step.headLink(`https://github.com/o/r/commit/${sha}`)) note(id, part.method, part.params);
      }
      if (step.method) note(id, step.method, step.params);
      if (step.end) return finish(id, step.end, step.error);
    }
    finish(id, "completed");
  };

  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "turn/interrupt" && deaf) return send({ id: message.id, result: {} });
    if (message.method === "turn/interrupt" && waiting) {
      send({ id: message.id, result: {} });
      waiting = null;
      return finish(`scene-${turn}`, "interrupted");
    }
    const scene = message.method === "turn/start" && /\[scene:([a-z-]+)\]/.exec(message.params?.input?.[0]?.text ?? "");
    if (!scene) {
      if (message.method === "thread/start" || message.method === "thread/resume") pending.set(message.id, "thread");
      child.stdin.write(`${line}\n`);
      return;
    }
    turn += 1;
    checkout = message.params.cwd;
    const id = `scene-${turn}`;
    send({ method: "turn/started", params: { threadId: thread, turn: { id, items: [], status: "inProgress" } } });
    send({ id: message.id, result: { turn: { id, items: [], status: "inProgress" } } });
    void play(scene[1], id);
  });
}
