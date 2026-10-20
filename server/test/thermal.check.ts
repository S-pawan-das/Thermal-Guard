import assert from "node:assert/strict";
import { ThermalSim, defaultScenario, validateScenario, validateSource, validateFire, validateSetTemperature, validateFailure, PARAM_LIMITS, type Scenario } from "../src/thermal";
import { getState } from "../src/simulator";
import { planToSimCell, simCellToPlan, zoneSimCells, SIM_COLS, SIM_ROWS, TEMP_MIN, TEMP_MAX } from "../../shared/floorplan";
import type { PlanZone } from "../../shared/types";

let n = 0;
const ok = (name: string, fn: () => void) => { try { fn(); console.log(`  ok  ${name}`); } catch (e) { n++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); } };

// Zone edges are aligned to the 25 x 24 cell grid so the numbers below are easy to reason about.
const cold: PlanZone = { id: "cold", name: "Cold", x: 100, y: 96, w: 200, h: 192, type: "cold-storage", minC: 2, maxC: 8, warnMarginC: 1 };
const hot: PlanZone = { id: "hot", name: "Hot", x: 600, y: 96, w: 200, h: 192, type: "general", minC: 15, maxC: 30, warnMarginC: 2 };
const nextToCold: PlanZone = { id: "b", name: "B", x: 300, y: 96, w: 200, h: 192, type: "general", minC: 10, maxC: 30, warnMarginC: 2 };
const scen = (o: Partial<Scenario> = {}): Scenario => ({ ...defaultScenario(), ...o });
const fire = (over: object = {}) => ({ id: "f", x: 500, y: 300, targetC: 300, strength: 0.3, startStep: 0, endStep: null, ...over });
const stat = (s: ThermalSim, id: string) => s.zoneStats().find((z) => z.id === id)!;
const allFiniteInRange = (g: number[]) => g.every((v) => Number.isFinite(v) && v >= TEMP_MIN && v <= TEMP_MAX);
const AMB = 22;

console.log("-- grid and coordinates --");
ok("grid is 40 x 25 on the 1000 x 600 plan; cells map back to plan units", () => {
  assert.deepEqual([SIM_COLS, SIM_ROWS], [40, 25]);
  assert.deepEqual(planToSimCell(0, 0), { col: 0, row: 0 });
  assert.deepEqual(planToSimCell(1000, 600), { col: 39, row: 24 });
  assert.deepEqual(planToSimCell(26, 25), { col: 1, row: 1 });
  assert.deepEqual(simCellToPlan(1, 1), { x: 25, y: 24, w: 25, h: 24 });
  assert.deepEqual(zoneSimCells(cold), { c0: 4, c1: 11, r0: 4, r1: 11 });
  assert.deepEqual(zoneSimCells({ x: 0, y: 0, w: 20, h: 20 }), { c0: 0, c1: 0, r0: 0, r1: 0 }); // smallest zone still has a cell
});

console.log("-- simulation --");
ok("1. ambient is stable without a source (no zones, and with a non-cooled zone)", () => {
  for (const zs of [[], [hot]]) {
    const s = new ThermalSim(defaultScenario(), zs);
    s.tick(2000);
    for (const v of s.getGrid()) assert.ok(Math.abs(v - AMB) < 1e-9, `drifted to ${v}`);
  }
});
ok("2. temperature rises at an active heat source (and not without it)", () => {
  const s = new ThermalSim(scen({ sources: [fire()] }));
  const ref = new ThermalSim();
  const p = planToSimCell(500, 300);
  s.tick(30); ref.tick(30);
  assert.ok(s.getCell(p.col, p.row) > AMB + 20, `source cell ${s.getCell(p.col, p.row)}`);
  assert.ok(Math.abs(ref.getCell(p.col, p.row) - AMB) < 1e-9);
  assert.ok(s.getCell(p.col, p.row) <= 300 + 1e-9, "source must not exceed its target");
});
ok("2b. a source starts and stops on schedule", () => {
  const s = new ThermalSim(scen({ sources: [fire({ startStep: 10, endStep: 20 })] }));
  const p = planToSimCell(500, 300);
  s.tick(10); assert.ok(Math.abs(s.getCell(p.col, p.row) - AMB) < 1e-9, "should not heat before startStep");
  s.tick(10); const hotCell = s.getCell(p.col, p.row); assert.ok(hotCell > AMB + 20);
  s.tick(100); assert.ok(s.getCell(p.col, p.row) < hotCell, "should cool after endStep");
});
ok("3. heat spreads to neighbours, weaker with distance", () => {
  const s = new ThermalSim(scen({ sources: [fire()] }));
  s.tick(100);
  const { col, row } = planToSimCell(500, 300);
  const d = (k: number) => s.getCell(col + k, row);
  assert.ok(d(0) > d(1) && d(1) > d(2) && d(2) > d(5) && d(5) > AMB + 0.1, [d(0), d(1), d(2), d(5)].join(" > "));
  assert.ok(s.getCell(col, row + 1) > AMB + 1 && s.getCell(col, row - 1) > AMB + 1, "vertical neighbours warm too");
  assert.ok(s.getCell(0, 0) < AMB + 0.05, "far corner is still about ambient");
});
ok("4. cooling failure: cold room holds its setpoint, then warms gradually toward ambient", () => {
  const s = new ThermalSim(defaultScenario(), [cold]);
  assert.ok(Math.abs(stat(s, "cold").avgC - 5) < 1e-9, "starts at the setpoint (middle of 2-8)");
  s.tick(100);
  assert.ok(stat(s, "cold").avgC > 4.9 && stat(s, "cold").maxC < 6.5, "healthy cooler holds the room cold");
  s.triggerFailure("cold");
  let prev = stat(s, "cold").avgC, crossed = -1;
  for (let i = 1; i <= 800; i++) {
    s.tick();
    const st = stat(s, "cold");
    assert.ok(st.avgC >= prev - 1e-9, "warming must be monotonic");
    assert.ok(st.maxC <= AMB + 1e-9, "never warmer than ambient");
    assert.ok(st.avgC - prev < 0.5, "no sudden jumps");
    if (crossed < 0 && st.maxC > 8) crossed = i;
    prev = st.avgC;
  }
  assert.ok(crossed > 5 && crossed < 200, `crossed the max limit after ${crossed} steps`);
  assert.ok(prev > 21.5, `ends near ambient (${prev})`);
});
ok("4b. failureTempC makes the room settle lower than ambient", () => {
  const a = new ThermalSim(defaultScenario(), [cold]), b = new ThermalSim(defaultScenario(), [cold]);
  a.triggerFailure("cold"); b.triggerFailure("cold", 12);
  a.tick(800); b.tick(800);
  assert.ok(stat(b, "cold").avgC < stat(a, "cold").avgC - 2 && stat(b, "cold").avgC > 12);
});
ok("4c. a scheduled failure (scenario) fires at its step", () => {
  const s = new ThermalSim(scen({ failures: [{ zoneId: "*", atStep: 50 }] }), [cold]);
  s.tick(50); const before = stat(s, "cold").avgC;
  assert.ok(before < 6.5);
  s.tick(100); assert.ok(stat(s, "cold").avgC > before + 5);
});
ok("5. reset restores the exact initial state", () => {
  const s = new ThermalSim(scen({ sources: [fire()], seed: 7, initialNoiseC: 0.5 }), [cold, hot]);
  const g0 = s.getGrid();
  s.addSource(fire({ id: "x", x: 100, y: 100 }));
  s.triggerFailure("cold");
  s.tick(300);
  assert.notDeepEqual(s.getGrid(), g0);
  s.reset();
  assert.equal(s.step, 0);
  assert.deepEqual(s.getGrid(), g0);
  const fresh = new ThermalSim(scen({ sources: [fire()], seed: 7, initialNoiseC: 0.5 }), [cold, hot]);
  s.tick(60); fresh.tick(60);
  assert.deepEqual(s.getGrid(), fresh.getGrid(), "same scenario gives the same run after a reset");
});
ok("5b. same seed = identical runs; different seed = different start", () => {
  const mk = (seed: number) => new ThermalSim(scen({ seed, initialNoiseC: 0.5 }), [cold]);
  const a = mk(7), b = mk(7), c = mk(8);
  a.tick(100); b.tick(100);
  assert.deepEqual(a.getGrid(), b.getGrid());
  assert.notDeepEqual(mk(7).getGrid(), c.getGrid());
});
ok("6. no invalid numbers after thousands of steps, even with extreme settings", () => {
  const extreme = scen({
    params: { ambientC: 60, diffusion: 0.2, ambientRate: 0.2, wallConductance: 1, failureRate: 0.2 },
    sources: [fire({ targetC: 1000, strength: 1 }), fire({ id: "g", x: 100, y: 100, targetC: -100, strength: 1 })],
    failures: [{ zoneId: "*", atStep: 5, failureTempC: -100 }],
  });
  const s = new ThermalSim(extreme, [cold, hot]);
  for (let i = 0; i < 50; i++) { s.tick(100); assert.ok(allFiniteInRange(s.getGrid())); }
});
ok("6b. NaN / absurd settings are clamped; corrupted cells are repaired", () => {
  const bad = scen({ params: { ambientC: NaN, diffusion: 99, ambientRate: -5, wallConductance: Infinity, failureRate: NaN }, sources: [fire({ targetC: NaN, strength: NaN })], seed: NaN, initialNoiseC: Infinity });
  const s = new ThermalSim(bad, [hot]);
  for (const k of Object.keys(PARAM_LIMITS) as (keyof typeof PARAM_LIMITS)[]) {
    const v = s.getScenario().params[k];
    assert.ok(Number.isFinite(v) && v >= PARAM_LIMITS[k][0] && v <= PARAM_LIMITS[k][1], k);
  }
  (s as unknown as { T: Float64Array }).T[10] = NaN;
  (s as unknown as { T: Float64Array }).T[11] = Infinity;
  s.tick(5);
  assert.ok(allFiniteInRange(s.getGrid()));
});
ok("6c. stable: heat never exceeds the hottest value or drops below the coldest (max principle)", () => {
  const s = new ThermalSim(scen({ params: { ...defaultScenario().params, diffusion: 0.2, ambientRate: 0.2 }, sources: [fire({ targetC: 100, strength: 1, startStep: 0, endStep: 1 })] }));
  for (let i = 0; i < 500; i++) { s.tick(); const g = s.getGrid(); assert.ok(Math.max(...g) <= 100 + 1e-9 && Math.min(...g) >= AMB - 1e-9); }
});
ok("7. walls: conductance 0 blocks heat between zones, 1 lets it through", () => {
  const run = (wall: number) => {
    const s = new ThermalSim(scen({ params: { ...defaultScenario().params, wallConductance: wall }, sources: [fire({ x: 0, y: 0, zoneId: "cold" })] }), [{ ...cold, type: "general" }, nextToCold]); // no cooler, so heat is not removed
    s.tick(300);
    return stat(s, "b").maxC;
  };
  assert.ok(run(0) <= AMB + 1e-9, "sealed wall");
  assert.ok(run(1) > AMB + 0.5, "no wall");
});

console.log("-- simulator controls --");
const ids = ["cold", "hot"], cooled = ["cold"];
ok("controls reject unknown zone ids, missing ids and non-object bodies", () => {
  for (const body of [{ zoneId: "nope" }, {}, { zoneId: 5 }, { zoneId: "" }, null, [], "x"]) {
    assert.equal(validateFire(body, ids).ok, false, JSON.stringify(body));
    assert.equal(validateSetTemperature({ ...(body as object), temperatureC: 5 }, ids).ok, false);
  }
  assert.equal(validateFailure({ zoneId: "nope" }, ids, cooled).ok, false);
  assert.equal(validateFailure({ zoneId: "hot" }, ids, cooled).ok, false, "a zone without a cooler cannot fail one");
  assert.equal(validateFailure({ zoneId: "*" }, ids, []).ok, false);
  assert.equal(validateFailure({ zoneId: "cold" }, ids, cooled).ok, true);
  assert.equal(validateFailure({}, ids, cooled).ok, true, "defaults to every cooled zone");
});
ok("set-temperature rejects NaN, Infinity, strings, missing and out-of-range values", () => {
  for (const t of [NaN, Infinity, -Infinity, "5", null, undefined, {}, 2000, -500]) assert.equal(validateSetTemperature({ zoneId: "cold", temperatureC: t }, ids).ok, false, String(t));
  assert.deepEqual(validateSetTemperature({ zoneId: "cold", temperatureC: -18.5 }, ids), { ok: true, value: { zoneId: "cold", temperatureC: -18.5 } });
});
ok("fire parameters are validated and defaulted", () => {
  assert.deepEqual(validateFire({ zoneId: "hot" }, ids), { ok: true, value: { zoneId: "hot", targetC: 300, strength: 0.3 } });
  for (const b of [{ zoneId: "hot", strength: 2 }, { zoneId: "hot", targetC: NaN }, { zoneId: "hot", targetC: 9999 }]) assert.equal(validateFire(b, ids).ok, false);
});
ok("startFire: heats the zone, one fire per zone, unknown zone refused", () => {
  const s = new ThermalSim(defaultScenario(), [cold, hot]);
  assert.equal(s.startFire("nope"), false);
  s.startFire("hot"); s.startFire("hot");
  assert.deepEqual(s.status().fires, [{ id: "fire-hot", zoneId: "hot" }]);
  s.tick(30);
  assert.ok(stat(s, "hot").maxC > 40);
});
ok("setZoneTemperature sets every covered cell exactly and refuses unknown zones / invalid numbers", () => {
  const s = new ThermalSim(defaultScenario(), [cold, hot]);
  assert.equal(s.setZoneTemperature("nope", 5), false);
  assert.equal(s.setZoneTemperature("hot", NaN), false);
  assert.ok(s.setZoneTemperature("hot", 40));
  const h = stat(s, "hot"); assert.deepEqual([h.minC, h.maxC, h.avgC], [40, 40, 40]);
  s.setZoneTemperature("hot", 9999); assert.equal(stat(s, "hot").maxC, TEMP_MAX);
});
ok("pause freezes the simulation and resume continues; status reports it", () => {
  const s = new ThermalSim(scen({ sources: [fire()] }));
  s.tick(10); const g = s.getGrid(), step = s.step;
  s.paused = true; s.tick(100);
  assert.deepEqual(s.getGrid(), g); assert.equal(s.step, step); assert.equal(s.status().paused, true);
  s.paused = false; s.tick(5); assert.equal(s.step, step + 5);
});
ok("reset removes runtime fires and failed coolers and restores the documented baseline", () => {
  const s = new ThermalSim(defaultScenario(), [cold, hot]);
  const g0 = s.getGrid();
  assert.equal(s.status().baseline, true);
  s.startFire("hot"); s.triggerFailure("cold");
  s.tick(40);
  assert.equal(s.status().baseline, false);
  assert.deepEqual([s.status().fires.length, s.status().failedCoolers], [1, ["cold"]]);
  s.reset();
  assert.deepEqual(s.status(), { paused: false, step: 0, scenario: "ambient", fires: [], failedCoolers: [], baseline: true });
  assert.deepEqual(s.getGrid(), g0);
  s.tick(200); assert.ok(Math.abs(stat(s, "hot").maxC - AMB) < 0.05, "no fire left running (only faint seepage from the cold room)"); assert.ok(stat(s, "cold").maxC < 6.5, "cooler works again");
});

console.log("-- zone statistics and status --");
ok("zone stats: min <= avg <= max over intersecting cells", () => {
  const s = new ThermalSim(scen({ sources: [fire({ x: 0, y: 0, zoneId: "hot" })] }), [cold, hot]);
  s.tick(50);
  const h = stat(s, "hot");
  assert.ok(h.minC <= h.avgC && h.avgC <= h.maxC && h.maxC > h.minC + 5);
});
ok("live state: healthy cold room is normal; overheating makes a zone critical; failure makes the cold room critical", () => {
  const s = new ThermalSim(scen({ sources: [fire({ x: 0, y: 0, zoneId: "hot" })] }), [cold, hot]);
  s.tick(60);
  const st = getState(s, new Date(0)).zones;
  assert.equal(st.find((z) => z.id === "cold")!.status, "normal");
  const h = st.find((z) => z.id === "hot")!;
  assert.equal(h.status, "critical"); assert.ok(h.maxCellC > 30 && h.temperatureC < h.maxCellC);
  s.triggerFailure("cold"); s.tick(100);
  assert.equal(getState(s, new Date(0)).zones.find((z) => z.id === "cold")!.status, "critical");
});

console.log("-- API validation --");
ok("valid scenario accepted; bad ones rejected", () => {
  assert.equal(validateScenario({}).ok, true);
  assert.equal(validateScenario({ seed: 3, params: { diffusion: 0.15 }, sources: [fire()], failures: [{ zoneId: "*", atStep: 10, failureTempC: 12 }] }).ok, true);
  for (const bad of [null, [], "x", { params: { diffusion: 0.5 } }, { params: { diffusion: NaN } }, { params: { nope: 1 } }, { params: { ambientC: "22" } },
    { seed: 1.5 }, { initialNoiseC: -1 }, { sources: [fire({ strength: -1 })] }, { sources: [fire({ targetC: 5000 })] }, { sources: [fire({ x: undefined })] },
    { sources: [fire({ startStep: 5, endStep: 5 })] }, { sources: Array.from({ length: 21 }, (_, i) => fire({ id: `s${i}` })) },
    { failures: [{ atStep: 1 }] }, { failures: [{ zoneId: "a", atStep: -1 }] }, { failures: [{ zoneId: "a", failureTempC: Infinity }] }])
    assert.equal(validateScenario(bad).ok, false, JSON.stringify(bad)?.slice(0, 60));
  assert.equal(validateSource(fire({ id: "bad id!" })).ok, false);
});

console.log(n ? `\n${n} FAILED` : "\nAll simulation checks passed");
process.exit(n ? 1 : 0);
