import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { serviceProcesses } from "./smoke-processes.mjs";

async function bounded(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The parent pipe is the service's shutdown protocol. Its exit must settle before
// the disposable profile can be removed, including failed startup and checks.
export async function smokeService(binary, args, data, check, {
  readyMs = 20_000,
  shutdownMs = 5_000,
  env = process.env,
  diagnose = serviceProcesses,
} = {}) {
  const service = spawn(binary, args, { stdio: ["pipe", "pipe", "inherit"], env });
  let stopped = false;
  const exited = new Promise((resolve) => {
    service.once("error", (error) => { stopped = true; resolve({ error }); });
    service.once("exit", (code, signal) => { stopped = true; resolve({ code, signal }); });
  });
  // A failed spawn or early exit can close stdin before cleanup asks for EOF.
  service.stdin.on("error", () => {});
  const lines = createInterface({ input: service.stdout });
  const ready = new Promise((resolve, reject) => {
    lines.once("line", resolve);
    exited.then(({ error, code, signal }) => reject(error ?? new Error(`Service exited before ready: ${code ?? signal}`)));
  });
  let failure;
  let checked;
  try {
    const line = await bounded(ready, readyMs, "Service did not report ready.");
    checked = await check(JSON.parse(line));
  } catch (error) {
    failure = error;
  } finally {
    try {
      service.stdin.end();
      let result;
      try {
        result = await bounded(exited, shutdownMs, "Service did not stop after parent EOF.");
      } catch (error) {
        try {
          const inventory = await diagnose(service.pid);
          if (inventory) console.error("Service process inventory:", JSON.stringify(inventory));
        } catch {
          console.error("Service process inventory unavailable.");
        }
        service.kill("SIGKILL");
        await bounded(exited, shutdownMs, "Service did not exit after forced termination.");
        throw error;
      }
      if (result.error) throw result.error;
      if (result.code !== 0) throw new Error(`Service exited unsuccessfully: ${result.code ?? result.signal}`);
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], "Smoke check and service shutdown failed") : error;
    } finally {
      lines.close();
      try {
        if (!stopped) throw new Error(`Service is still alive; retained profile ${data}`);
        rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch (error) {
        failure = failure ? new AggregateError([failure, error], "Smoke check and profile cleanup failed") : error;
      }
    }
  }
  if (failure) throw failure;
  return checked;
}
