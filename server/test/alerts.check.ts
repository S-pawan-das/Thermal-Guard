import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AlertEngine, nextLevel, type AlertConfig } from "../src/alerts";
import { ThermalSim, defaultScenario } from "../src/thermal";
import { getState } from "../src/simulator";
import type { PlanZone, Zone } from "../../shared/types";

let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve().then(fn).then(() => console.log(`  ok  ${name}`), (e) => { n++; console.log(`FAIL  ${name}\n      ${e.message}`); });

// Zone limits 2..8, warning margin 1 (warning when the hottest cell is above 7, or the coldest below 3).
const zone = (minCell: number, maxCell: number, o: Partial<Zone> = {}): Zone => ({
  id: "z1", name: "Cold Room", type: "cold-storage", minC: 2, maxC: 8, warnMarginC: 1,
  temperatureC: (minCell + maxCell) / 2, minCellC: minCell, maxCellC: maxCell, timestamp: "t", status: "normal", ...o,
});
const hi = (max: number) => zone(5, max); // only the high side moves
const lo = (min: number) => zone(min, 5); // only the low side moves
const mk = (cfg: Partial<AlertConfig> = {}) => {
  let t = 1_000_000;
  const e = new AlertEngine({ hysteresisC: 0.3, cooldownMs: 60_000, maxHistory: 500, ...cfg }, () => t);
  return { e, adv: (ms: number) => { t += ms; } };
};
const feed = (e: AlertEngine, readings: Zone[]) => readings.map((z) => e.evaluate([z]));
const sev = (e: AlertEngine) => e.active().map((a) => `${a.kind}:${a.severity}`);

async function main() {
  console.log("-- thresholds --");
  await ok("normal readings create no alerts, however often they repeat", () => {
    const { e } = mk();
    for (let i = 0; i < 50; i++) assert.deepEqual(e.evaluate([zone(4, 6)]), []);
    assert.equal(e.list().length, 0);
  });
  await ok("high warning starts inside the margin (above maxC - warn), not before", () => {
    const { e } = mk();
    assert.equal(e.evaluate([hi(6.9)]).length, 0);
    const c = e.evaluate([hi(7.1)]);
    assert.deepEqual(c.map((x) => [x.type, x.alert.severity, x.alert.kind]), [["created", "warning", "high"]]);
  });
  await ok("high critical only when the limit is CROSSED (exactly at the limit is a warning)", () => {
    const a = mk().e; a.evaluate([hi(8.0)]); assert.deepEqual(sev(a), ["high:warning"]);
    const b = mk().e; b.evaluate([hi(8.2)]); assert.deepEqual(sev(b), ["high:critical"]);
  });
  await ok("low-temperature events: warning below minC + warn, critical below minC", () => {
    const { e } = mk();
    assert.equal(e.evaluate([lo(3.1)]).length, 0);
    e.evaluate([lo(2.9)]); assert.deepEqual(sev(e), ["low:warning"]);
    e.evaluate([lo(1.9)]); assert.deepEqual(sev(e), ["low:critical"]);
    assert.match(e.active()[0].reason, /Coldest cell reads 1\.9 °C, below the 2 °C minimum/);
  });
  await ok("high and low logic is symmetric (same distance to the limit -> same severity)", () => {
    for (const m of [-0.2, 0, 0.5, 0.99, 1, 1.5]) {
      const h = mk().e, l = mk().e;
      h.evaluate([hi(8 - m)]); l.evaluate([lo(2 + m)]);
      assert.deepEqual(h.active().map((a) => a.severity), l.active().map((a) => a.severity), `m=${m}`);
    }
  });
  await ok("warning margin 0 means no warning band: normal then straight to critical", () => {
    const { e } = mk();
    e.evaluate([hi(7.99, ) && zone(5, 7.99, { warnMarginC: 0 })]); assert.equal(e.active().length, 0);
    e.evaluate([zone(5, 8.1, { warnMarginC: 0 })]); assert.deepEqual(sev(e), ["high:critical"]);
  });
  await ok("escalation closes the warning and opens the critical alert", () => {
    const { e } = mk();
    const out = feed(e, [hi(7.5), hi(8.5)]).flat().map((c) => `${c.type}:${c.alert.severity}`);
    assert.deepEqual(out, ["created:warning", "resolved:warning", "created:critical"]);
    assert.equal(e.list().find((a) => a.severity === "warning")!.resolution, "escalated");
  });

  console.log("-- hysteresis and duplicates --");
  await ok("nextLevel: leaving a level needs the margin to improve by the hysteresis", () => {
    assert.equal(nextLevel(2, 0.1, 1, 0.3), 2); assert.equal(nextLevel(2, 0.4, 1, 0.3), 1); assert.equal(nextLevel(2, 1.4, 1, 0.3), 0);
    assert.equal(nextLevel(1, 1.2, 1, 0.3), 1); assert.equal(nextLevel(1, 1.4, 1, 0.3), 0); assert.equal(nextLevel(0, 1.2, 1, 0.3), 0);
  });
  await ok("critical recovers in steps: stays critical until 0.3 °C inside, then warning, then normal", () => {
    const { e } = mk();
    const steps = [8.2, 7.9, 7.75, 7.6, 7.0, 6.6].map((v) => { e.evaluate([hi(v)]); return sev(e).join() || "none"; });
    assert.deepEqual(steps, ["high:critical", "high:critical", "high:critical", "high:warning", "high:warning", "none"]);
  });
  await ok("no flicker: a reading wobbling around the warning threshold gives ONE alert and no resolve", () => {
    const { e } = mk();
    const changes = [];
    for (let i = 0; i < 60; i++) changes.push(...e.evaluate([hi(i % 2 ? 6.95 : 7.05)]));
    assert.deepEqual(changes.map((c) => c.type), ["created"]);
    assert.equal(e.list().length, 1);
  });
  await ok("duplicate suppression: identical readings 100 times = one alert, no further events", () => {
    const { e } = mk();
    assert.equal(e.evaluate([hi(8.4)]).length, 1);
    for (let i = 0; i < 100; i++) assert.deepEqual(e.evaluate([hi(8.4)]), []);
    assert.equal(e.list().length, 1);
  });
  await ok("worst reading is tracked quietly (no event) while the alert is active", () => {
    const { e } = mk();
    e.evaluate([hi(8.2)]);
    assert.deepEqual(e.evaluate([hi(8.6)]), []);
    assert.equal(e.active()[0].peakC, 8.6); assert.equal(e.active()[0].readingC, 8.2);
  });
  await ok("cooldown: a recurrence inside the cooldown RE-OPENS the same alert; after it, a new alert", () => {
    const { e, adv } = mk();
    e.evaluate([hi(8.2)]); const id = e.list()[0].id;
    e.evaluate([hi(5)]); assert.equal(e.active().length, 0);
    adv(10_000);
    const c = e.evaluate([hi(8.3)]);
    assert.deepEqual(c.map((x) => [x.type, x.alert.id, x.alert.occurrences]), [["reopened", id, 2]]);
    assert.equal(e.list().length, 1);
    e.evaluate([hi(5)]); adv(61_000);
    e.evaluate([hi(8.3)]);
    assert.equal(e.list().length, 2); assert.notEqual(e.active()[0].id, id);
  });
  await ok("history has stable, unique ids and full details", () => {
    const { e } = mk();
    e.evaluate([hi(8.2), lo(1) && zone(1, 5, { id: "z2", name: "Freezer" })]);
    const ids = e.list().map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
    const a = e.list()[0];
    for (const k of ["id", "zoneId", "zoneName", "severity", "kind", "reason", "readingC", "limitC", "startedAt"] as const) assert.ok(a[k] !== undefined, k);
    assert.match(a.startedAt, /^\d{4}-\d\d-\d\dT/);
  });

  console.log("-- reset, removal and invalid input --");
  await ok("resolveAll closes active alerts but KEEPS history; the same condition afterwards is a NEW alert", () => {
    const { e } = mk();
    e.evaluate([hi(8.2)]); const id = e.list()[0].id;
    const c = e.resolveAll("scenario reset");
    assert.deepEqual(c.map((x) => x.alert.resolution), ["scenario reset"]);
    assert.equal(e.active().length, 0); assert.equal(e.list().length, 1);
    e.evaluate([hi(8.2)]);
    assert.equal(e.list().length, 2); assert.notEqual(e.active()[0].id, id);
  });
  await ok("clearHistory removes resolved alerts only", () => {
    const { e } = mk();
    e.evaluate([hi(8.2)]); e.evaluate([hi(5)]); e.evaluate([lo(1.5)]);
    assert.equal(e.clearHistory(), 1); assert.deepEqual(sev(e), ["low:critical"]); assert.equal(e.list().length, 1);
  });
  await ok("a zone that disappears gets its alerts closed", () => {
    const { e } = mk();
    e.evaluate([hi(8.2)]);
    const c = e.evaluate([]);
    assert.deepEqual(c.map((x) => x.alert.resolution), ["zone removed"]);
  });
  await ok("invalid readings or limits never create alerts and never throw", () => {
    const { e } = mk();
    for (const z of [zone(NaN, 5), zone(5, Infinity), zone(5, 9, { minC: 8, maxC: 8 }), zone(5, 9, { minC: 9, maxC: 2 }), zone(5, 9, { warnMarginC: -1 }), zone(5, 9, { maxC: NaN }), zone(5, 9, { warnMarginC: undefined as unknown as number })])
      assert.deepEqual(e.evaluate([z]), []);
    assert.equal(e.list().length, 0);
  });
  await ok("history is capped; oldest resolved alerts are dropped first", () => {
    const { e } = mk({ maxHistory: 5, cooldownMs: 0 });
    for (let i = 0; i < 20; i++) { e.evaluate([hi(8.5)]); e.evaluate([hi(5)]); }
    assert.ok(e.list().length <= 5);
  });

  console.log("-- persistence --");
  await ok("load() restores history, closes alerts that were active at shutdown, continues ids, skips garbage", () => {
    const a = mk().e; a.evaluate([hi(8.2), zone(1.5, 5, { id: "z2", name: "F" })]); // both zones present, both alerts active
    const saved = JSON.parse(JSON.stringify(a.list()));
    const b = mk().e;
    b.load([...saved, null, 5, { id: "x" }, { ...saved[0], kind: "sideways" }]);
    assert.equal(b.list().length, saved.length);
    assert.ok(b.list().every((x) => x.status === "resolved" && x.resolution === "server restart"));
    b.evaluate([hi(8.2)]);
    assert.equal(b.active()[0].id, `A-${String(saved.length + 1).padStart(6, "0")}`);
    b.load("nonsense"); assert.equal(b.list().length, 0);
  });
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tg-alerts-"));
  const { loadAlertHistory, saveAlertHistory, ALERTS_FILE } = await import("../src/storage");
  await ok("alert history file round-trips; a corrupt file is set aside, not overwritten", async () => {
    assert.deepEqual(await loadAlertHistory(), []);
    const { e } = mk(); e.evaluate([hi(8.2)]);
    await saveAlertHistory(e.list());
    assert.deepEqual(await loadAlertHistory(), JSON.parse(JSON.stringify(e.list())));
    fs.writeFileSync(ALERTS_FILE, "{oops");
    assert.deepEqual(await loadAlertHistory(), []);
    assert.equal(fs.readFileSync(`${ALERTS_FILE}.corrupt`, "utf8"), "{oops");
  });

  console.log("-- alerts come only from real simulated readings --");
  const planZone = (o: Partial<PlanZone> & { id: string }): PlanZone => ({ name: o.id, x: 100, y: 96, w: 200, h: 192, type: "cold-storage", minC: 2, maxC: 8, warnMarginC: 1, ...o });
  const cold = planZone({ id: "cold" });
  const hot = planZone({ id: "hot", x: 600, type: "general", minC: 15, maxC: 30, warnMarginC: 2 });
  await ok("an undisturbed simulation raises no alerts for 1000 steps", () => {
    const sim = new ThermalSim(defaultScenario(), [cold, hot]);
    const { e } = mk();
    for (let i = 0; i < 1000; i++) { sim.tick(); e.evaluate(getState(sim).zones); }
    assert.equal(e.list().length, 0);
  });
  await ok("cooling failure -> high warning, then high critical, never a low alert; reset closes them", () => {
    const sim = new ThermalSim(defaultScenario(), [cold, hot]);
    const { e } = mk();
    sim.tick(50); sim.triggerFailure("cold");
    for (let i = 0; i < 300; i++) { sim.tick(); e.evaluate(getState(sim).zones); }
    assert.deepEqual(e.list().map((a) => `${a.kind}:${a.severity}`), ["high:warning", "high:critical"]);
    assert.ok(e.list().every((a) => a.zoneId === "cold"));
    sim.reset(); e.resolveAll("scenario reset"); e.evaluate(getState(sim).zones);
    assert.equal(e.active().length, 0); assert.equal(e.list().length, 2);
  });
  await ok("fire in a general zone raises a high alert only in that zone", () => {
    const sim = new ThermalSim(defaultScenario(), [cold, hot]);
    const { e } = mk();
    sim.startFire("hot");
    for (let i = 0; i < 100; i++) { sim.tick(); e.evaluate(getState(sim).zones); }
    assert.ok(e.active().length >= 1 && e.active().every((a) => a.zoneId === "hot" && a.kind === "high"));
  });
  await ok("set-temperature below minC raises a low alert that clears after recovery", () => {
    const sim = new ThermalSim(defaultScenario(), [cold]);
    const { e } = mk();
    sim.setZoneTemperature("cold", 0.5); sim.tick(); e.evaluate(getState(sim).zones);
    assert.ok(e.active().some((a) => a.kind === "low" && a.severity === "critical"));
    for (let i = 0; i < 80; i++) { sim.tick(); e.evaluate(getState(sim).zones); }
    assert.equal(e.active().length, 0);
  });

  console.log(n ? `\n${n} FAILED` : "\nAll alert checks passed");
  process.exit(n ? 1 : 0);
}
main();
