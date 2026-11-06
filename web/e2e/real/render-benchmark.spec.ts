import { chromium, expect, test } from "@playwright/test";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/**
 * O27: replays a seeded 50 KiB reply through the real service in fixed deltas, in a
 * fresh browser, and records main-thread time, heap and DOM mutations. It measures
 * this UI only; the reference UI is not run here. The bounds are generous: the
 * numbers are the evidence, attached to the report, and the test fails only on a
 * render that is lost or wildly slow.
 */

/** The `bench` scene in scenes.mjs: 200 deltas of 256 bytes, 10 ms apart, ending `END.`. */
const BENCH_DELTAS = 200;
const BENCH_DELTA_BYTES = 256;
const BENCH_DELTA_MS = 10;
const REPLY_BYTES = BENCH_DELTAS * BENCH_DELTA_BYTES;

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());

test("a seeded 50 KiB reply streams in fixed deltas within a recorded budget", async ({ browserName }, info) => {
  test.setTimeout(90_000);
  // A browser of its own, so no earlier spec has warmed its caches or heap.
  const browser = await chromium.launch({ args: ["--in-process-gpu"] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.goto(`${service.page}#/new/${projectId}`);
    await page.evaluate(() => {
      const counts = { records: 0, nodes: 0 };
      new MutationObserver((records) => {
        counts.records += records.length;
        for (const record of records) counts.nodes += record.addedNodes.length + record.removedNodes.length;
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      (window as unknown as { benchMutations: typeof counts }).benchMutations = counts;
    });
    const metric = async () => {
      const { metrics } = await cdp.send("Performance.getMetrics");
      const values = new Map(metrics.map((entry: { name: string; value: number }) => [entry.name, entry.value]));
      return (name: string) => values.get(name) ?? 0;
    };
    await cdp.send("HeapProfiler.collectGarbage");
    const before = await metric();
    const started = Date.now();
    await send(page, "[scene:bench]");
    await expect(page).toHaveURL(/#\/threads\//);
    await settled(service, threadIdOf(page));
    await expect(page.locator(".msg-assistant").last()).toContainText("END.", { timeout: 30_000 });
    const wall = Date.now() - started;
    const after = await metric();
    const mutations = await page.evaluate(() => (window as unknown as { benchMutations: { records: number; nodes: number } }).benchMutations);
    const report = {
      browser: browserName,
      reply_bytes: REPLY_BYTES,
      deltas: BENCH_DELTAS,
      delta_bytes: BENCH_DELTA_BYTES,
      delta_interval_ms: BENCH_DELTA_MS,
      wall_ms: wall,
      main_thread_task_ms: Math.round((after("TaskDuration") - before("TaskDuration")) * 1000),
      script_ms: Math.round((after("ScriptDuration") - before("ScriptDuration")) * 1000),
      layout_ms: Math.round((after("LayoutDuration") - before("LayoutDuration")) * 1000),
      style_ms: Math.round((after("RecalcStyleDuration") - before("RecalcStyleDuration")) * 1000),
      heap_used_bytes: after("JSHeapUsedSize"),
      heap_growth_bytes: after("JSHeapUsedSize") - before("JSHeapUsedSize"),
      dom_nodes: after("Nodes"),
      mutation_records: mutations.records,
      mutated_nodes: mutations.nodes,
    };
    await info.attach("render-benchmark.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    console.log(`render benchmark ${JSON.stringify(report)}`);
    expect(mutations.records).toBeGreaterThan(0);
    // The ideal replay takes two seconds; anything past this is a render problem.
    expect(report.main_thread_task_ms).toBeLessThan(30_000);
    expect(report.heap_used_bytes).toBeLessThan(512 * 1024 * 1024);
  } finally {
    await browser.close();
  }
});
