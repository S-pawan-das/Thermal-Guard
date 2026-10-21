import assert from "node:assert/strict";
import { Forecaster, predictRisk, featurize, FEATURE_COUNT, HISTORY, HORIZON, MIN_HISTORY, type Reading } from "../../shared/forecast";
import { FORECAST_MODEL } from "../../shared/forecastModel";
import { getState } from "../src/simulator";
import { ThermalSim, defaultScenario } from "../src/thermal";
import type { PlanZone } from "../../shared/types";

let n = 0;
const ok = (name: string, fn: () => void) => { try { fn(); console.log(`  ok  ${name}`); } catch (e) { n++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); } };
const L = { type: "cold-storage" as const, minC: 2, maxC: 8, warnMarginC: 1 };
const flat = (v: number): Reading => ({ avg: v, min: v, max: v });
const M = FORECAST_MODEL;

console.log("-- early-warning model --");
ok("model file is well-formed (shapes match the features)", () => {
  assert.equal(M.mean.length, FEATURE_COUNT); assert.equal(M.std.length, FEATURE_COUNT);
  assert.equal(M.layers[0].in, FEATURE_COUNT); assert.equal(M.layers[M.layers.length - 1].out, 1);
  M.layers.forEach((l, i) => { assert.equal(l.w.length, l.in * l.out); assert.equal(l.b.length, l.out); if (i) assert.equal(l.in, M.layers[i - 1].out); });
  assert.ok([...M.mean, ...M.std, ...M.layers.flatMap((l) => [...l.w, ...l.b])].every(Number.isFinite));
  assert.equal(M.horizon, HORIZON); assert.equal(M.history, HISTORY);
  assert.ok(M.alarm.threshold > 0 && M.alarm.threshold <= 1 && M.alarm.release < M.alarm.threshold);
});
ok("risk is always a finite number between 0 and 1, even for absurd inputs", () => {
  for (const v of [-1e9, -100, 0, 5, 1e6, NaN, Infinity]) {
    const r = predictRisk(M, featurize([flat(v), flat(v), flat(v)], L));
    assert.ok(Number.isFinite(r) && r >= 0 && r <= 1, `risk ${r} for ${v}`);
  }
});
ok("a steady zone in the middle of its range never raises the alarm", () => {
  const f = new Forecaster(M);
  for (let t = 0; t < 400; t++) { const r = f.observe("a", flat(5 + 0.05 * Math.sin(t / 7)), L); assert.equal(r.alert, false, `alarm at step ${t}`); }
});
ok("a steady rise towards the max limit raises the alarm BEFORE the zone goes out of range", () => {
  const f = new Forecaster(M);
  let warnedAt = -1, breachAt = -1;
  for (let t = 0; t < 200; t++) {
    const v = 4 + 0.1 * Math.max(0, t - 30); // steady 0.1 °C/step rise from step 30
    const r = f.observe("a", flat(v), L);
    if (r.alert && warnedAt < 0) warnedAt = t;
    if (v > L.maxC && breachAt < 0) { breachAt = t; break; }
  }
  assert.ok(breachAt > 0 && warnedAt >= 0 && warnedAt < breachAt, `warned at ${warnedAt}, breach at ${breachAt}`);
});
ok("an already out-of-range zone reports risk 1 and the alarm on", () => {
  const f = new Forecaster(M);
  const r = f.observe("a", flat(30), L);
  assert.deepEqual([r.risk, r.alert], [1, true]);
});
ok("the model stays quiet until it has enough history, and editing limits starts it fresh", () => {
  const f = new Forecaster(M);
  for (let t = 0; t < MIN_HISTORY - 1; t++) assert.equal(f.observe("a", flat(5 + 0.1 * t), L).risk, 0);
  f.observe("a", flat(40), { ...L, maxC: 100 }); // limits changed: history cleared, so no stale alarm
  assert.equal(f.observe("a", flat(40), { ...L, maxC: 100 }).risk, 0);
});
ok("same readings give the same risk (deterministic)", () => {
  const run = () => { const f = new Forecaster(M); let r = 0; for (let t = 0; t < 60; t++) r = f.observe("a", flat(4 + t * 0.05), L).risk; return r; };
  assert.equal(run(), run());
});
ok("getState carries the forecast only for zones that have one", () => {
  const z: PlanZone = { id: "z", name: "Z", x: 100, y: 96, w: 200, h: 192, type: "general", minC: 15, maxC: 30, warnMarginC: 2 };
  const s = new ThermalSim(defaultScenario(), [z]);
  assert.equal(getState(s).zones[0].ai, undefined);
  const withAi = getState(s, new Date(), new Map([["z", { risk: 0.4, alert: false, horizon: HORIZON }]]));
  assert.deepEqual(withAi.zones[0].ai, { risk: 0.4, alert: false, horizon: HORIZON });
});
if (n) { console.log(`\n${n} check(s) failed`); process.exit(1); }
console.log("\nall forecast checks passed");
