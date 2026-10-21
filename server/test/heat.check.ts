import assert from "node:assert/strict";
import { heatRgb, limitsPosition, absoluteRange, cellOwners, colourPositions, MIN_ABS_SPAN } from "../../shared/heat";
import { getState } from "../src/simulator";
import { ThermalSim, defaultScenario } from "../src/thermal";
import { SIM_COLS, SIM_ROWS } from "../../shared/floorplan";
import type { PlanZone } from "../../shared/types";

let n = 0;
const ok = (name: string, fn: () => void) => { try { fn(); console.log(`  ok  ${name}`); } catch (e) { n++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); } };
const zone: PlanZone = { id: "z", name: "Z", x: 100, y: 96, w: 200, h: 192, type: "general", minC: 10, maxC: 30, warnMarginC: 2 };

console.log("-- heatmap colouring --");
ok("colour scale runs blue -> red and survives bad input", () => {
  const [r0, , b0] = heatRgb(0), [r1, , b1] = heatRgb(1);
  assert.ok(b0 > r0 && r1 > b1);
  assert.deepEqual(heatRgb(NaN), heatRgb(0));
  assert.deepEqual(heatRgb(-5), heatRgb(0));
  assert.deepEqual(heatRgb(7), heatRgb(1));
});
ok("limits scale: min limit 0.15, middle 0.5, max limit 0.85, saturates beyond", () => {
  assert.ok(Math.abs(limitsPosition(10, 10, 30) - 0.15) < 1e-9);
  assert.ok(Math.abs(limitsPosition(20, 10, 30) - 0.5) < 1e-9);
  assert.ok(Math.abs(limitsPosition(30, 10, 30) - 0.85) < 1e-9);
  assert.equal(limitsPosition(500, 10, 30), 1);
  assert.equal(limitsPosition(-500, 10, 30), 0);
  assert.equal(limitsPosition(NaN, 10, 30), 0.5);
});
ok("absolute range is never narrower than the minimum span", () => {
  const r = absoluteRange([22, 22, 22]);
  assert.ok(r.hi - r.lo >= MIN_ABS_SPAN);
  assert.deepEqual(absoluteRange([]), { lo: 0, hi: MIN_ABS_SPAN });
});
ok("cell owners follow the engine rule (centre inside the zone)", () => {
  const o = cellOwners([zone]);
  assert.equal(o.length, SIM_COLS * SIM_ROWS);
  assert.equal(o[4 * SIM_COLS + 4], 0); // cell (4,4) starts at the zone corner
  assert.equal(o[3 * SIM_COLS + 4], -1);
  assert.equal(o.filter((v) => v === 0).length, 8 * 8);
});
ok("a hot cell inside a zone is coloured hotter than the same temperature in a cold zone", () => {
  const cold: PlanZone = { ...zone, id: "c", x: 600, minC: 2, maxC: 8 };
  const owners = cellOwners([zone, cold]);
  const values = new Array(SIM_COLS * SIM_ROWS).fill(25);
  const { u } = colourPositions(values, [zone, cold], owners, "limits");
  assert.ok(u[4 * SIM_COLS + 4] < u[4 * SIM_COLS + 24]); // 25 °C is fine in Z, far too warm in the cold room
});
console.log("-- live state carries the grid --");
ok("getState includes a full, finite, rounded grid", () => {
  const s = new ThermalSim({ ...defaultScenario(), sources: [{ id: "m", x: 500, y: 300, targetC: 60, strength: 0.2, startStep: 0, endStep: null }] }, [zone]);
  s.tick(50);
  const g = getState(s).grid!;
  assert.equal(g.cols, SIM_COLS); assert.equal(g.rows, SIM_ROWS); assert.equal(g.values.length, SIM_COLS * SIM_ROWS);
  assert.ok(g.values.every((v) => Number.isFinite(v) && Math.round(v * 10) === v * 10 || Math.abs(v * 10 - Math.round(v * 10)) < 1e-6));
  assert.ok(Math.max(...g.values) > 30);
});

if (n) { console.log(`\n${n} check(s) failed`); process.exit(1); }
console.log("\nall heat checks passed");
