import assert from "node:assert/strict";
import test from "node:test";
import { startupDiagnostics } from "./smoke-app-diagnostics.mjs";

test("startup diagnostics report where a cold service stopped", () => {
  const stderr = [
    "[orbyn-startup] setup-started", "[orbyn-startup] window-ready",
    "[orbyn-startup] tray-ready", "[orbyn-startup] service-spawned",
    "[orbyn-startup] readiness-timeout",
  ].join("\r\n");
  assert.equal(startupDiagnostics(stderr),
    "setup-started -> window-ready -> tray-ready -> service-spawned -> readiness-timeout");
});

test("startup diagnostics exclude tokens, paths, arbitrary stderr and unknown phases", () => {
  const stderr = [
    'http://127.0.0.1:1234/?token=private-test-token',
    '[orbyn-startup] C:/private/profile',
    '[orbyn-startup] service-spawned token=private-test-token',
    '[orbyn-startup] unknown-phase',
    'prefix [orbyn-startup] window-ready',
    '[orbyn-startup] window-ready',
    '[orbyn-startup] window-ready',
  ].join("\n");
  assert.equal(startupDiagnostics(stderr), "window-ready");
  assert.equal(startupDiagnostics("private-test-token"), "no startup milestones reported");
});
