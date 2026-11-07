import { chromium, expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { settled, startProject, type Service } from "./service";

/**
 * Phase 0 performance baseline (local only, not committed). Production UI served by the
 * real service, protocol-double engine, fresh headless Chromium per measurement.
 */
const OUT = process.env.PERF_OUT ?? "perf-baseline.json";
const RUNS = 5;
const TURNS = Number(process.env.PERF_TURNS ?? 40); // 50 items per turn
let service: Service;
let projectId = "";
let engine = "";
const report: Record<string, unknown> = {};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;

const INIT = `(() => {
  const w = window; w.__perf = { lcp: 0, cls: 0, events: [], firstUsable: 0, shifts: [], lcpEl: "" };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { w.__perf.lcp = e.startTime; w.__perf.lcpEl = e.element ? (e.element.tagName + "." + e.element.className) : ""; } }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { w.__perf.cls += e.value; w.__perf.shifts.push({ t: Math.round(e.startTime), v: +e.value.toFixed(4), src: (e.sources || []).map((x) => x.node ? (x.node.nodeName + "." + (x.node.className || "")) : "?").slice(0, 4) }); } }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.events.push({ name: e.name, duration: e.duration, start: e.startTime, processing: e.processingEnd - e.processingStart, delay: e.processingStart - e.startTime }); }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  const check = () => { if (!w.__perf.firstUsable && document.querySelector(".sidebar-nav") && document.querySelector("main, [role=main]")) { requestAnimationFrame(() => { w.__perf.firstUsable = performance.now(); }); } };
  new MutationObserver(check).observe(document, { subtree: true, childList: true });
})();`;

async function fresh() {
  const browser = await chromium.launch({ args: ["--in-process-gpu"] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  page.on("crash", () => console.log("PAGE CRASH"));
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const metric = async (name: string) => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((m: { name: string }) => m.name === name)?.value ?? 0;
  };
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return { heap_used_mb: +((await metric("JSHeapUsedSize")) / 2 ** 20).toFixed(1), dom_nodes: await metric("Nodes") };
  };
  return { browser, page, heap };
}

const perf = (page: Page) => page.evaluate(() => (window as unknown as { __perf: { lcp: number; cls: number; firstUsable: number; events: { name: string; duration: number }[] } }).__perf);

async function makeThread(title: string, turns: number): Promise<string> {
  const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine, model: null, title, worktree: null, skill_profile: null });
  for (let n = 0; n < turns; n++) {
    await service.api("POST", `/api/threads/${thread.id}/runs`, { prompt: `[scene:chunk] turn ${n}` });
    await settled(service, thread.id);
  }
  return thread.id;
}

test.beforeAll(async () => {
  test.setTimeout(1_800_000);
  const started = await startProject({ scenes: true, builtUi: true });
  ({ service, projectId } = started);
  engine = started.engines.find((e) => /codex/i.test(e.id) || /codex/i.test(e.name))?.id ?? started.engines[0]!.id;
});
test.afterAll(async () => {
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  await service.stop();
});

test("startup to first usable screen, LCP, CLS, idle memory", async () => {
  test.setTimeout(300_000);
  const usable: number[] = [], lcp: number[] = [], cls: number[] = [], heaps: number[] = [], nodes: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const { browser, page, heap } = await fresh();
    await page.goto(service.page);
    await page.waitForFunction(() => (window as unknown as { __perf: { firstUsable: number } }).__perf.firstUsable > 0, null, { timeout: 30_000 });
    await page.waitForTimeout(3_000);
    const p = await perf(page);
    usable.push(Math.round(p.firstUsable)); lcp.push(Math.round(p.lcp)); cls.push(+p.cls.toFixed(4));
    const h = await heap(); heaps.push(h.heap_used_mb); nodes.push(h.dom_nodes);
    if (i === 0) { await page.screenshot({ path: "perf-home.png" }); report.startup_detail = { shifts: (p as unknown as { shifts: unknown }).shifts, lcp_element: (p as unknown as { lcpEl: string }).lcpEl }; }
    await browser.close();
  }
  report.startup_web = { runs: RUNS, first_usable_ms: { median: median(usable), all: usable }, lcp_ms: { median: median(lcp), all: lcp }, cls: { max: Math.max(...cls), all: cls } };
  report.idle_memory = { heap_used_mb: { median: median(heaps), all: heaps }, dom_nodes: median(nodes) };
});

test("long thread: memory, scroll, typing, thread and tab switch", async () => {
  test.setTimeout(1_500_000);
  const t0 = Date.now();
  const longId = await makeThread("Long thread", TURNS);
  const shortId = await makeThread("Short thread", 1);
  report.seed = { turns: TURNS, items_per_turn: 50, seed_ms: Date.now() - t0 };
  const { browser, page, heap } = await fresh();
  try {
    const openStart = Date.now();
    await page.goto(`${service.page}#/threads/${longId}`);
    await expect(page.locator(".transcript")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(`Reply 24`).last()).toBeVisible({ timeout: 120_000 });
    const openMs = Date.now() - openStart;
    await page.waitForTimeout(2_000);
    report.long_thread_open = { wall_ms: openMs, ...(await heap()) };
    await page.screenshot({ path: "perf-long-thread.png" });

    // Scroll: drive scrollTop each frame for 4 s from bottom to top, record frame intervals.
    const scroll = await page.evaluate(async () => {
      const el = document.querySelector(".transcript") as HTMLElement;
      const total = el.scrollHeight - el.clientHeight;
      el.scrollTop = total;
      await new Promise((r) => setTimeout(r, 500));
      const frames: number[] = [];
      let last = performance.now();
      const start = last;
      await new Promise<void>((done) => {
        const step = (now: number) => {
          frames.push(now - last); last = now;
          const t = (now - start) / 4000;
          el.scrollTop = total * (1 - Math.min(1, t));
          if (t < 1) requestAnimationFrame(step); else done();
        };
        requestAnimationFrame(step);
      });
      frames.shift();
      const sorted = [...frames].sort((a, b) => a - b);
      return { scroll_height_px: el.scrollHeight, frames: frames.length, fps: +(frames.length / 4).toFixed(1), p95_frame_ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1), max_frame_ms: +(sorted[sorted.length - 1] ?? 0).toFixed(1), long_frames_over_33ms: frames.filter((f) => f > 33.4).length };
    });
    report.scroll_long_thread = scroll;

    // Typing: 120 characters at 30 ms per key into the composer; Event Timing durations (>=16 ms recorded).
    await page.evaluate(() => { (window as unknown as { __perf: { events: unknown[] } }).__perf.events = []; });
    const box = page.getByRole("textbox", { name: /^Message/ });
    await box.click();
    const typeStart = Date.now();
    await page.keyboard.type("a".repeat(120), { delay: 30 });
    const typeWall = Date.now() - typeStart;
    await page.waitForTimeout(500);
    const ev = (await perf(page)).events.filter((e) => ["keydown", "keypress", "keyup", "input", "beforeinput"].includes(e.name));
    const durs = ev.map((e) => e.duration);
    // Per-key paint latency: rAF after each input event, measured in page.
    const lat = await page.evaluate(async () => {
      const el = document.activeElement as HTMLTextAreaElement;
      const out: number[] = [];
      for (let i = 0; i < 40; i++) {
        const t = performance.now();
        el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "b" }));
        document.execCommand("insertText", false, "b");
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        out.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 30));
      }
      return out;
    });
    report.typing_long_thread = { keys: 120, wall_ms: typeWall, event_entries_over_16ms: durs.length, event_duration_max_ms: durs.length ? Math.max(...durs) : 0, event_duration_p95_ms: durs.length ? pct(durs, 0.95) : 0, input_to_next_frame_ms: { median: +median(lat).toFixed(1), p95: +pct(lat, 0.95).toFixed(1), max: +Math.max(...lat).toFixed(1) } };
    await box.fill("").catch((e) => { report.fill_error = String(e); });
    console.log("after typing");

    // Thread switch via the sidebar row, timed click to the other transcript's content.
    const switches: { to: string; ms: number }[] = [];
    for (let i = 0; i < 3; i++) {
      for (const [title, id, marker] of [["Short thread", shortId, "Reply 24"], ["Long thread", longId, "Reply 24"]] as const) {
        console.log("switch", title);
        const row = page.locator(`li[data-thread-item="${id}"]`).getByText(title, { exact: true }).first();
        const t = Date.now();
        await row.click();
        await expect(page).toHaveURL(new RegExp(id));
        await expect(page.getByText(marker).last()).toBeVisible({ timeout: 60_000 });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        switches.push({ to: title, ms: Date.now() - t });
      }
    }
    report.thread_switch = { to_short_ms: switches.filter((s) => s.to === "Short thread").map((s) => s.ms), to_long_ms: switches.filter((s) => s.to === "Long thread").map((s) => s.ms) };

    // Side panel tabs on the long thread.
    const tablist = page.getByRole("tablist", { name: "Context" });
    if (!(await tablist.isVisible())) await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Surfaces" }).click();
    await tablist.waitFor({ timeout: 10_000 }).catch(() => {});
    const tabTimes: Record<string, number[]> = {};
    if (await tablist.isVisible()) {
      const tabs = tablist.getByRole("tab");
      const n = await tabs.count();
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < n; i++) {
          const tab = tabs.nth(i);
          const name = (await tab.getAttribute("aria-label")) ?? (await tab.innerText());
          const t = Date.now();
          await tab.click();
          await expect(tab).toHaveAttribute("aria-selected", "true");
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          (tabTimes[name] ??= []).push(Date.now() - t);
        }
      }
      report.panel_tab_switch_ms = tabTimes;
    } else {
      report.panel_tab_switch_ms = "side panel not open; not measured";
    }
    const all = (await perf(page)).events;
    report.event_timing_session = { entries_over_16ms: all.length, worst_ms: all.length ? Math.max(...all.map((e) => e.duration)) : 0, worst: all.sort((a, b) => b.duration - a.duration).slice(0, 5) };
    report.long_thread_end = await heap();
  } finally {
    await browser.close();
  }
});
