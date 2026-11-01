import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { smokeService } from "./smoke-service.mjs";

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "orbyn-smoke-lifecycle-"));
  const data = join(root, "profile");
  const receipt = join(root, "stopped");
  mkdirSync(data);
  try {
    await run({ data, receipt });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const graceful = `
  const fs = require('node:fs');
  const [data, receipt, mode] = process.argv.slice(1);
  // Retain an actual profile handle until parent EOF, then settle asynchronous
  // cleanup before exit. The receipt survives the profile's removal.
  const fd = fs.openSync(require('node:path').join(data, 'held'), 'w');
  process.stdin.resume();
  process.stdin.on('end', () => setTimeout(() => {
    fs.closeSync(fd);
    fs.writeFileSync(receipt, 'released');
  }, 25));
  if (mode !== 'silent') console.log(JSON.stringify({ ready: true }));
`;

test("smoke waits for parent EOF cleanup and exit before removing the profile", async () => {
  await fixture(async ({ data, receipt }) => {
    await smokeService(process.execPath, ["-e", graceful, data, receipt], data, ({ ready }) => {
      assert.equal(ready, true);
      assert.equal(existsSync(receipt), false);
    });
    assert.equal(readFileSync(receipt, "utf8"), "released");
    assert.equal(existsSync(data), false);
  });
});

test("a failed API check still awaits service cleanup", async () => {
  await fixture(async ({ data, receipt }) => {
    await assert.rejects(smokeService(process.execPath, ["-e", graceful, data, receipt], data, () => {
      throw new Error("API rejected");
    }), /API rejected/);
    assert.equal(readFileSync(receipt, "utf8"), "released");
    assert.equal(existsSync(data), false);
  });
});

test("readiness timeout enters cleanup and awaits the known service", async () => {
  await fixture(async ({ data, receipt }) => {
    await assert.rejects(smokeService(process.execPath, ["-e", graceful, data, receipt, "silent"], data, () => {
      assert.fail("a silent service cannot be checked");
    }, { readyMs: 200 }), /Service did not report ready/);
    assert.equal(readFileSync(receipt, "utf8"), "released");
    assert.equal(existsSync(data), false);
  });
});

test("a service that ignores EOF is terminated and fails smoke", async () => {
  await fixture(async ({ data }) => {
    const ignore = `process.stdin.resume(); process.stdin.on('end', () => {}); setInterval(() => {}, 1000); console.log('{}');`;
    await assert.rejects(smokeService(process.execPath, ["-e", ignore], data, () => {}, { shutdownMs: 100 }), /did not stop after parent EOF/);
    assert.equal(existsSync(data), false);
  });
});

test("spawn failure removes the disposable profile and rejects", async () => {
  await fixture(async ({ data }) => {
    await assert.rejects(smokeService(join(data, "missing-program"), [], data, () => {}));
    assert.equal(existsSync(data), false);
  });
});

test("failed diagnostics preserve startup and shutdown errors and still reap the service", async () => {
  await fixture(async ({ data }) => {
    const silent = `process.stdin.resume(); process.stdin.on('end', () => {}); setInterval(() => {}, 1000);`;
    let diagnosed;
    const messages = (error) => [error.message, ...(error.errors ?? []).flatMap(messages)];
    await assert.rejects(smokeService(process.execPath, ["-e", silent], data, () => {
      assert.fail("a silent service cannot be checked");
    }, {
      readyMs: 100, shutdownMs: 100,
      diagnose: async (pid) => { diagnosed = pid; throw new Error("PRIVATE-DIAGNOSTIC-PAYLOAD"); },
    }), (error) => {
      const all = messages(error);
      assert.ok(all.includes("Service did not report ready."));
      assert.ok(all.includes("Service did not stop after parent EOF."));
      assert.ok(all.every((message) => !message.includes("PRIVATE-DIAGNOSTIC-PAYLOAD")));
      return true;
    });
    assert.ok(Number.isSafeInteger(diagnosed) && diagnosed > 0);
    assert.equal(existsSync(data), false);
  });
});

test("early unsuccessful exit fails smoke and still removes the profile", async () => {
  await fixture(async ({ data }) => {
    await assert.rejects(smokeService(process.execPath, ["-e", "process.exit(7)"], data, () => {
      assert.fail("an exited service cannot be checked");
    }), /Smoke check and service shutdown failed/);
    assert.equal(existsSync(data), false);
  });
});

test("a Windows profile lock is a smoke failure, not a warning", { skip: process.platform !== "win32" }, async () => {
  await fixture(async ({ data, receipt }) => {
    const holder = spawn(process.execPath, ["-e", `process.chdir(process.argv[1]); process.stdin.resume(); console.log('holding');`, data], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const exited = once(holder, "exit");
    try {
      await once(holder.stdout, "data");
      await assert.rejects(smokeService(process.execPath, ["-e", graceful, data, receipt], data, () => {}), (error) => {
        assert.match(error.code, /EBUSY|EPERM|EACCES/);
        return true;
      });
      assert.equal(readFileSync(receipt, "utf8"), "released");
      assert.equal(existsSync(data), true);
    } finally {
      holder.stdin.end();
      await exited;
    }
  });
});
