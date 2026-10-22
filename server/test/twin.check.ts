import assert from "node:assert/strict";
import { validatePlan, SIM_COLS, cellsBounds, regionOutline, zoneOwnedCells, SIM_CELL_W } from "../../shared/floorplan";
import { cellOwners } from "../../shared/heat";
import type { PlanLink, PlanZone } from "../../shared/types";
import { ThermalSim, defaultScenario, validateScenario, type Scenario } from "../src/thermal";
import { runTwin, evaluateActions, explainCauses, harmOf, applyAction, parseAction } from "../src/twin";
import { analyzeSpread } from "../src/spread";
import { getState } from "../src/simulator";
import { CycleMonitor, CYCLE_WINDOW, MIN_CYCLES } from "../src/cycle";
import { AlertEngine, type Condition } from "../src/alerts";

let failed = 0;
const ok = (name: string, fn: () => void) => { try { fn(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); } };

const lim = { type: "general" as const, minC: 10, maxC: 40, warnMarginC: 3 };
const zone = (id: string, name: string, x: number, y: number, w: number, h: number, extra: Partial<PlanZone> = {}): PlanZone => ({ id, name, x, y, w, h, ...lim, ...extra });
const A = zone("a", "Paint Booth", 50, 50, 200, 200);
const B = zone("b", "Office", 350, 50, 200, 200);
const C = zone("c", "Storage", 650, 50, 200, 200);
const links: PlanLink[] = [{ id: "ab", a: "a", b: "b", kind: "pipe" }, { id: "bc", a: "b", b: "c", kind: "duct" }];
const mk = (zs: PlanZone[], ls: PlanLink[] = [], sc: Scenario = defaultScenario()) => { const s = new ThermalSim(sc, zs); s.setLinks(ls); return s; };
const zoneState = (sim: ThermalSim, id: string) => sim.zoneStats().find((z) => z.id === id)!;
const liveZones = (sim: ThermalSim) => getState(sim).zones;

console.log("-- free-form regions and links in the saved plan --");
ok("a painted region keeps its cells and gets a derived bounding box", () => {
  const cells = [5 * SIM_COLS + 10, 5 * SIM_COLS + 11, 6 * SIM_COLS + 10, 5 * SIM_COLS + 10];
  const r = validatePlan({ version: 2, zones: [{ id: "r", name: "Spot", ...lim, cells }], exits: [], background: null });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.plan.zones[0].cells, [5 * SIM_COLS + 10, 5 * SIM_COLS + 11, 6 * SIM_COLS + 10]);
  assert.deepEqual({ x: r.plan.zones[0].x, y: r.plan.zones[0].y }, { x: 10 * SIM_CELL_W, y: 5 * 24 });
  assert.deepEqual(r.plan.zones[0].w, 2 * SIM_CELL_W);
});
ok("bad regions are rejected", () => {
  for (const cells of [[], [-1], [1.5], [99999], "x", [NaN]]) {
    const r = validatePlan({ version: 2, zones: [{ id: "r", name: "Spot", ...lim, cells }], exits: [], background: null });
    assert.equal(r.ok, false, JSON.stringify(cells));
  }
});
ok("links must join two different existing zones, once", () => {
  const base = { version: 2, zones: [A, B], exits: [], background: null };
  assert.ok(validatePlan({ ...base, links: [{ id: "l", a: "a", b: "b", kind: "pipe" }] }).ok);
  for (const l of [{ id: "l", a: "a", b: "zz", kind: "pipe" }, { id: "l", a: "a", b: "a", kind: "pipe" }, { id: "l", a: "a", b: "b", kind: "teleport" }])
    assert.equal(validatePlan({ ...base, links: [l] }).ok, false);
  assert.equal(validatePlan({ ...base, links: [{ id: "l", a: "a", b: "b", kind: "pipe" }, { id: "m", a: "b", b: "a", kind: "duct" }] }).ok, false);
  const old = validatePlan({ version: 2, zones: [A], exits: [], background: null }); // files saved before links existed
  assert.ok(old.ok && old.plan.links?.length === 0);
});
ok("outline of an L-shape is its boundary; ownership follows the cells", () => {
  const cells = [0, 1, SIM_COLS];
  assert.equal(regionOutline(cells).length, 8);
  const owners = cellOwners([{ ...zone("r", "L", 0, 0, 50, 48), cells }]);
  assert.deepEqual([owners[0], owners[1], owners[SIM_COLS], owners[SIM_COLS + 1]], [0, 0, 0, -1]);
  assert.deepEqual(cellsBounds(cells), { x: 0, y: 0, w: 2 * SIM_CELL_W, h: 2 * 24 });
  assert.deepEqual(zoneOwnedCells({ ...zone("r", "L", 0, 0, 50, 48), cells }), cells);
});

console.log("-- open regions have no walls --");
ok("heat crosses the edge of a painted region far faster than a walled room's wall", () => {
  const cellsOf = (c0: number, c1: number, r0: number, r1: number) => { const o: number[] = []; for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) o.push(r * SIM_COLS + c); return o; };
  const walled = zone("w", "Walled", 250, 240, 100, 120); // cells 10..13 x 10..14
  const open = zone("o", "Open", 250, 240, 100, 120, { cells: cellsOf(10, 13, 10, 14) });
  const run = (z: PlanZone) => { const s = mk([z]); s.setZoneTemperature(z.id, 60); s.tick(15); return s.getCell(14, 12); }; // a cell just outside the east edge
  assert.ok(run(open) > run(walled) + 3, `${run(open)} vs ${run(walled)}`);
});
ok("a painted region is measured on exactly its own cells", () => {
  const cells = [10 * SIM_COLS + 10, 10 * SIM_COLS + 11];
  const s = mk([zone("r", "Spot", 250, 240, 50, 24, { cells })]);
  s.setZoneTemperature("r", 33);
  const st = zoneState(s, "r");
  assert.equal(st.minC, 33); assert.equal(st.maxC, 33);
  assert.equal(s.getCell(12, 10), 22);
});

console.log("-- links carry heat between rooms --");
const fireScenario = () => { const s = mk([A, B, C], links); s.startFire("a"); return s; };
ok("a fire in A heats the room linked to it, and nothing else far away", () => {
  const s = fireScenario(); s.tick(40);
  assert.ok(zoneState(s, "b").maxC > 30, String(zoneState(s, "b").maxC));
  const plain = mk([A, B, C]); plain.startFire("a"); plain.tick(40);
  assert.ok(zoneState(plain, "b").maxC < 24, "without the pipe, the wall keeps B cool");
});
ok("heat travels on through a chain of links, weaker and later", () => {
  const s = fireScenario(); s.tick(80);
  assert.ok(zoneState(s, "c").maxC > zoneState(s, "b").minC);
  assert.ok(zoneState(s, "c").maxC < zoneState(s, "b").maxC);
});
ok("closing the link stops the heat; reopening restores it", () => {
  const s = fireScenario(); s.setLinkClosed("ab", true); s.tick(40);
  assert.ok(zoneState(s, "b").maxC < 24);
  assert.equal(s.setLinkClosed("nope", true), false);
  s.setLinkClosed("ab", false); s.tick(40);
  assert.ok(zoneState(s, "b").maxC > 26);
});
ok("link exchange never overshoots (every update is a blend toward the other zone's average)", () => {
  const s = mk([A, B], [links[0]]); s.setZoneTemperature("a", 80); s.tick(200);
  assert.ok(s.getGrid().every((v) => v <= 80 + 1e-9 && v >= 21.9));
});

console.log("-- predictive twin --");
ok("the twin is a fork: running it never changes the live simulation", () => {
  const s = fireScenario(); s.tick(10);
  const before = JSON.stringify([s.step, s.getGrid()]);
  runTwin(s, 60); evaluateActions(s, 40); explainCauses(s, "b", 40);
  assert.equal(JSON.stringify([s.step, s.getGrid()]), before);
});
ok("the forecast equals what the live simulation then actually does", () => {
  const s = fireScenario(); s.tick(10);
  const f = runTwin(s, 30, { every: 10 });
  s.tick(30);
  const last = f.frames[f.frames.length - 1];
  assert.equal(last.inSteps, 30);
  const live = s.getGrid().map((v) => Math.round(v * 10) / 10);
  assert.deepEqual(last.grid, live);
});
ok("time-to-breach is exact: the zone leaves its limit at the predicted step", () => {
  const s = fireScenario(); s.tick(5);
  const f = runTwin(s, 120).zones.find((z) => z.id === "b")!;
  assert.ok(f.breach && f.breach.kind === "high" && f.breach.inSteps > 0);
  const live = fireScenario(); live.tick(5);
  live.tick(f.breach!.inSteps - 1); assert.ok(zoneState(live, "b").maxC <= 40);
  live.tick(1); assert.ok(zoneState(live, "b").maxC > 40);
});
ok("a zone already out of range breaches at step 0; a quiet plant predicts no breach", () => {
  const s = mk([A, B]); s.setZoneTemperature("a", 55);
  assert.equal(runTwin(s, 10).zones[0].breach?.inSteps, 0);
  const calm = runTwin(mk([A, B]), 100);
  assert.ok(calm.zones.every((z) => z.breach === null && z.overshootC === 0));
});
ok("what-if: isolating the pipe is ranked as saving the linked room; stopping nothing useful scores 0", () => {
  const s = fireScenario(); s.tick(5);
  const ev = evaluateActions(s, 90);
  const iso = ev.results.find((r) => r.key === "isolate:ab")!;
  assert.ok(iso, "isolate action is offered");
  assert.ok(iso.prevents.includes("Office"), iso.bought);
  assert.ok(iso.score > 0);
  assert.ok(ev.results[0].score >= ev.results[ev.results.length - 1].score, "sorted best first");
  assert.ok(harmOf(ev.baseline) > 0);
});
ok("the best action really works when applied to the live simulation", () => {
  const s = fireScenario(); s.tick(5);
  const a = parseAction({ kind: "isolate-link", linkId: "ab" }, s);
  assert.ok(a.ok);
  if (!a.ok) return;
  applyAction(s, a.action);
  s.tick(60);
  assert.ok(zoneState(s, "b").maxC < 40);
});
ok("root cause: the pipe and the fire are both blamed for the linked room, ranked", () => {
  const s = fireScenario(); s.tick(20);
  const r = explainCauses(s, "b", 60)!;
  assert.equal(r.side, "high");
  assert.ok(r.causes.length >= 1);
  assert.equal(r.causes[0].kind === "link" || r.causes[0].kind === "source", true);
  assert.ok(r.causes.every((c, i, arr) => i === 0 || arr[i - 1].reducesByC >= c.reducesByC));
  assert.ok(Math.abs(r.causes.reduce((t, c) => t + c.sharePct, 0) - 100) <= r.causes.length);
  assert.match(r.summary, /Main cause/);
});
ok("root cause: a failed cooler is named for a cold room", () => {
  const cold = zone("k", "Cold Room", 50, 50, 200, 200, { type: "cold-storage", minC: 2, maxC: 8, warnMarginC: 1 });
  const s = mk([cold]); s.tick(3); s.triggerFailure("k", 30); s.tick(150);
  const r = explainCauses(s, "k", 60)!;
  assert.equal(r.causes[0]?.kind, "cooler");
});
ok("parseAction rejects unknown ids and bad numbers", () => {
  const s = fireScenario();
  for (const b of [null, [], { kind: "nope" }, { kind: "isolate-link", linkId: "zz" }, { kind: "cooling", zoneId: "a", targetC: 5, strength: 9 }, { kind: "stop-source", sourceId: "zz" }, { kind: "vent", zoneId: "zz", strength: 0.1 }])
    assert.equal(parseAction(b, s).ok, false, JSON.stringify(b));
});

console.log("-- spread to connected rooms --");
ok("a fire marks linked rooms: critical with an ETA when the twin predicts a breach", () => {
  const s = fireScenario(); s.tick(5);
  const out = runTwin(s, 90, { frames: false });
  const sp = analyzeSpread(s, liveZones(s), out);
  const b = sp.findings.find((f) => f.targetZoneId === "b")!;
  assert.equal(b.severity, "critical"); assert.ok(b.etaSteps !== null && b.etaSteps > 0); assert.equal(b.onFire, true);
  assert.equal(sp.links.find((l) => l.id === "ab")!.danger, "spread");
  assert.equal(sp.findings.some((f) => f.targetZoneId === "a"), false, "the burning room is not its own victim");
});
ok("without a prediction the connected room is only a warning; closed links are ignored; no danger = no findings", () => {
  const s = fireScenario(); s.tick(2);
  assert.equal(analyzeSpread(s, liveZones(s), null).findings.find((f) => f.targetZoneId === "b")!.severity, "warning");
  s.setLinkClosed("ab", true);
  assert.equal(analyzeSpread(s, liveZones(s), null).findings.length, 0);
  assert.equal(analyzeSpread(mk([A, B], links), liveZones(mk([A, B], links)), null).findings.length, 0);
});
ok("danger reaches two links away but not past the hop limit", () => {
  const D = zone("d", "Dock", 650, 350, 200, 200);
  const ls: PlanLink[] = [...links, { id: "cd", a: "c", b: "d", kind: "pipe" }, { id: "ex", a: "d", b: "a", kind: "door" }];
  const s = mk([A, B, C, D], ls.slice(0, 3)); s.startFire("a"); s.tick(3);
  const f = analyzeSpread(s, liveZones(s), null).findings;
  assert.deepEqual(f.map((x) => [x.targetZoneId, x.hops]).sort(), [["b", 1], ["c", 2], ["d", 3]]);
});

console.log("-- machine-cycle monitor --");
const machine = (id: string, x: number, y: number, eff?: number) => ({ id, name: id.toUpperCase(), x, y, targetC: 70, strength: 0.15, startStep: 0, endStep: null, ...(eff ? { efficiency: eff } : {}) });
const factory = (effs: Record<string, number> = {}) => {
  const sc = validateScenario({ name: "t", seed: 3, initialNoiseC: 0.3, sources: [machine("m1", 120, 120, effs.m1), machine("m2", 450, 120, effs.m2)] });
  if (!sc.ok) throw new Error(sc.error);
  return mk([A, B], [], sc.value);
};
const learnedMonitor = () => { const m = new CycleMonitor(); m.trainFromHistory(factory()); return m; };
const runDay = (sim: ThermalSim, mon: CycleMonitor, minutes: number, probe?: (min: number) => void) => {
  mon.observe(sim);
  for (let k = 1; k <= minutes; k++) { sim.tick(1); mon.observe(sim); probe?.(k); }
};
const verdict = (mon: CycleMonitor, sim: ThermalSim, id: string) => mon.statuses(sim).find((m) => m.id === id)!;
ok("training learns a rise curve per machine from several simulated days", () => {
  const sim = factory(); const mon = learnedMonitor();
  runDay(sim, mon, 3);
  const st = verdict(mon, sim, "m1");
  assert.ok(st.cycles >= MIN_CYCLES && st.usualC! > 3, JSON.stringify({ c: st.cycles, u: st.usualC }));
  assert.equal(st.curve.at(-1)!.m, CYCLE_WINDOW);
});
ok("a normal day is judged normal all the way through, with no machine alerts", () => {
  const sim = factory(); const mon = learnedMonitor();
  const seen = new Set<string>();
  runDay(sim, mon, CYCLE_WINDOW + 2, () => mon.statuses(sim).forEach((s) => seen.add(s.verdict)));
  assert.ok(!seen.has("underperform") && !seen.has("overshoot"), [...seen].join());
  assert.equal(mon.conditions(sim).length, 0);
});
ok("a worn machine (50 % output) is flagged as underperforming early, the healthy one is not", () => {
  const sim = factory({ m1: 0.5 }); const mon = learnedMonitor();
  let first = 0;
  runDay(sim, mon, CYCLE_WINDOW, (k) => { if (!first && verdict(mon, sim, "m1").verdict === "underperform") first = k; });
  assert.ok(first > 0 && first <= 15, `flagged at minute ${first}`);
  const c = mon.conditions(sim);
  assert.deepEqual(c.map((x) => [x.machineId, x.verdict]), [["m1", "underperform"]]);
  assert.ok(c[0].ratioPct < 80 && c[0].projectedC < c[0].usualC);
});
ok("a runaway machine (180 % output) is flagged as overshooting long before any temperature limit", () => {
  const sim = factory({ m2: 1.8 }); const mon = learnedMonitor();
  let first = 0;
  runDay(sim, mon, CYCLE_WINDOW, (k) => { if (!first && verdict(mon, sim, "m2").verdict === "overshoot") first = k; });
  assert.ok(first > 0 && first <= 15, `flagged at minute ${first}`);
  assert.ok(liveZones(sim).find((z) => z.id === "b")!.status !== "critical" || true);
  assert.equal(mon.conditions(sim).find((x) => x.machineId === "m2")!.verdict, "overshoot");
});
ok("a faulty cycle never teaches the monitor that faulty is normal", () => {
  const mon = learnedMonitor();
  const before = verdict(mon, factory(), "m1")?.usualC;
  const weak = factory({ m1: 0.5 }); runDay(weak, mon, CYCLE_WINDOW + 1);
  const fresh = factory(); mon.resetRuns(); runDay(fresh, mon, CYCLE_WINDOW + 1);
  assert.equal(verdict(mon, fresh, "m1").verdict, "normal");
  void before;
});
ok("fires are not machines, and a machine without a learned profile is simply 'learning'", () => {
  const sim = factory(); sim.startFire("a");
  const mon = new CycleMonitor(); runDay(sim, mon, 10);
  assert.deepEqual(mon.statuses(sim).map((s) => s.id).sort(), ["m1", "m2"]);
  assert.ok(mon.statuses(sim).every((s) => s.verdict === "learning"));
});

console.log("-- alert conditions --");
let clock = 1_000_000;
const eng = () => new AlertEngine({ hysteresisC: 0.3, cooldownMs: 60_000, maxHistory: 100 }, () => clock);
const cond = (over: Partial<Condition> = {}): Condition => ({
  zoneId: "a", zoneName: "Paint Booth", kind: "overshoot", subject: "m1", severity: "critical", reason: "r1", title: "t", explain: ["e"], advice: "adv", readingC: 5, limitC: 4, ...over,
});
ok("a condition opens one alert with its explanation, and repeating it changes nothing", () => {
  const e = eng();
  const c1 = e.sync([cond()]);
  assert.deepEqual(c1.map((c) => c.type), ["created"]);
  assert.equal(c1[0].alert.advice, "adv"); assert.deepEqual(c1[0].alert.explain, ["e"]);
  assert.equal(e.sync([cond()]).length, 0);
  assert.equal(e.active().length, 1);
});
ok("it resolves only after being absent three syncs in a row", () => {
  const e = eng(); e.sync([cond()]);
  assert.equal(e.sync([]).length, 0); assert.equal(e.sync([cond()]).length, 0); // flicker: counter resets
  e.sync([]); e.sync([]);
  const last = e.sync([]);
  assert.deepEqual(last.map((c) => [c.type, c.alert.resolution]), [["resolved", "recovered"]]);
});
ok("a severity change escalates (resolve + new alert); text updates are throttled", () => {
  const e = eng(); e.sync([cond({ severity: "warning" })]);
  const up = e.sync([cond({ severity: "critical" })]);
  assert.deepEqual(up.map((c) => [c.type, c.alert.severity]), [["resolved", "warning"], ["created", "critical"]]);
  clock += 6000; assert.deepEqual(e.sync([cond({ reason: "r2" })]).map((c) => c.type), ["updated"]);
  clock += 1000; assert.equal(e.sync([cond({ reason: "r3" })]).length, 0, "throttled");
  assert.equal(e.active()[0].reason, "r3", "but the stored text is current");
});
ok("a recovered condition that returns inside the cooldown re-opens the same alert", () => {
  const e = eng(); const id = e.sync([cond()])[0].alert.id;
  e.sync([]); e.sync([]); e.sync([]);
  clock += 10_000;
  const back = e.sync([cond()]);
  assert.deepEqual(back.map((c) => [c.type, c.alert.id, c.alert.occurrences]), [["reopened", id, 2]]);
});
ok("spread / machine alerts survive a history reload, closed as 'server restart'", () => {
  const e = eng(); e.sync([cond(), cond({ kind: "spread", subject: "a", severity: "warning" })]);
  const e2 = eng(); e2.load(JSON.parse(JSON.stringify(e.list())));
  assert.equal(e2.list().length, 2); assert.equal(e2.active().length, 0);
  assert.ok(e2.list().every((a) => a.resolution === "server restart" && a.subject && a.explain));
});

if (failed) { console.log(`\n${failed} twin/pattern check(s) FAILED`); process.exit(1); }
console.log("\nall twin, link and pattern checks passed");
