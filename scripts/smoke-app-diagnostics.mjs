// Only fixed milestones may enter CI output; never forward raw shell stderr.
const PHASES = new Set([
  "setup-started", "window-ready", "tray-ready", "service-spawned",
  "readiness-received", "readiness-timeout", "readiness-disconnected",
]);

export function startupDiagnostics(stderr) {
  const seen = new Set();
  for (const line of stderr.split(/\r?\n/)) {
    const match = /^\[orbyn-startup\] ([a-z-]+)$/.exec(line);
    if (match && PHASES.has(match[1])) seen.add(match[1]);
  }
  return [...seen].join(" -> ") || "no startup milestones reported";
}
