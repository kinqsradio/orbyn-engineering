import { spawn } from "node:child_process";

// Query only the known service and recursively discovered children. CommandLine,
// ExecutablePath, environment and unrelated processes are never requested.
const query = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$rootPid = [uint32]$env:ORBYN_SMOKE_SERVICE_PID
$rows = New-Object System.Collections.ArrayList
$queue = New-Object System.Collections.Queue
$seen = @{}
$root = Get-CimInstance Win32_Process -Filter "ProcessId=$rootPid" -Property ProcessId,ParentProcessId,Name -OperationTimeoutSec 1
if ($null -ne $root) { $queue.Enqueue($root) }
while ($queue.Count -gt 0 -and $rows.Count -lt 64) {
  $item = $queue.Dequeue()
  if ($seen.ContainsKey([uint32]$item.ProcessId)) { continue }
  $seen[[uint32]$item.ProcessId] = $true
  [void]$rows.Add([pscustomobject]@{ pid=[uint32]$item.ProcessId; ppid=[uint32]$item.ParentProcessId; name=[string]$item.Name })
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($item.ProcessId)" -Property ProcessId,ParentProcessId,Name -OperationTimeoutSec 1 | Select-Object -First 64)
  foreach ($child in $children) { $queue.Enqueue($child) }
}
[pscustomobject]@{ processes=$rows.ToArray(); truncated=($queue.Count -gt 0) } | ConvertTo-Json -Depth 4 -Compress
`;

// Diagnostics have their own bounded lifetime and capture budget. They must not
// replace the smoke failure or leave an inspector alive after forced shutdown.
export async function serviceProcesses(pid) {
  if (process.platform !== "win32") return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "no_service_pid" };
  const inspector = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, ORBYN_SMOKE_SERVICE_PID: String(pid) },
  });
  const output = [];
  let bytes = 0;
  let overflow = false;
  const exited = new Promise((resolve) => {
    inspector.once("error", () => resolve({ status: "inspector_failed" }));
    inspector.once("close", (code) => resolve({ status: code === 0 ? "ok" : "inspector_failed" }));
  });
  inspector.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 32 * 1024) {
      overflow = true;
      inspector.kill("SIGKILL");
    } else {
      output.push(chunk);
    }
  });
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "inspector_timed_out" }), 3_000);
  });
  let result;
  try {
    result = await Promise.race([exited, deadline]);
  } finally {
    clearTimeout(timer);
  }
  if (result.status === "inspector_timed_out") {
    inspector.kill("SIGKILL");
    let reaped;
    try {
      reaped = await Promise.race([exited, new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 1_000);
      })]);
    } finally {
      clearTimeout(timer);
    }
    return reaped ? result : { status: "inspector_did_not_exit", pid: inspector.pid };
  }
  if (overflow) return { status: "inspector_output_limit" };
  if (result.status !== "ok") return result;
  try {
    const value = JSON.parse(Buffer.concat(output).toString("utf8").replace(/^\uFEFF/, ""));
    const rows = Array.isArray(value.processes) ? value.processes : [];
    return {
      status: "ok", truncated: value.truncated === true || rows.length > 64,
      processes: rows.slice(0, 64).filter((row) => Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.ppid) && typeof row.name === "string")
        .map(({ pid, ppid, name }) => ({ pid, ppid, name: name.slice(0, 128) })),
    };
  } catch {
    return { status: "inspector_invalid_output" };
  }
}
