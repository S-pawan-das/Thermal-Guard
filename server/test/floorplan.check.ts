import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  validatePlan, validateLimits, statusFor, migratePlan, emptyPlan, checkName, clampRect, planToCell, cellToPlan,
  DEFAULT_LIMITS, GRID_SIZE,
} from "../../shared/floorplan";
import { TEMPLATES } from "../../client/src/templates";

let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => console.log(`  ok  ${name}`), (e) => { n++; console.log(`FAIL  ${name}\n      ${e.message}`); });
const zone = (o: object = {}) => ({ id: "a1", name: "A", x: 0, y: 0, w: 100, h: 100, ...DEFAULT_LIMITS, ...o });
const plan = (zones: object[] = [], extra: object = {}) => ({ version: 2, zones, exits: [], background: null, ...extra });
const bad = (input: unknown, re: RegExp) => { const r = validatePlan(input); assert.equal(r.ok, false); assert.match((r as { error: string }).error, re); };
const lim = (o: object = {}) => ({ type: "general", minC: 15, maxC: 30, warnMarginC: 2, ...o });
const badLim = (input: unknown, re: RegExp) => { const r = validateLimits(input); assert.equal(r.ok, false, "should be rejected"); assert.match((r as { error: string }).error, re); };

async function main() {
  console.log("-- temperature limits --");
  await ok("cold room 2-8 C is accepted", () => assert.deepEqual(validateLimits(lim({ type: "cold-storage", minC: 2, maxC: 8, warnMarginC: 1 })), { ok: true, limits: lim({ type: "cold-storage", minC: 2, maxC: 8, warnMarginC: 1 }) }));
  await ok("hot-process 20-60 C is accepted", () => assert.equal(validateLimits(lim({ type: "hot-process", minC: 20, maxC: 60, warnMarginC: 5 })).ok, true));
  await ok("negative ranges (freezer -25..-15) are accepted", () => assert.equal(validateLimits(lim({ minC: -25, maxC: -15, warnMarginC: 2 })).ok, true));
  await ok("rejects min >= max", () => { badLim(lim({ minC: 8, maxC: 8 }), /lower than/); badLim(lim({ minC: 9, maxC: 8 }), /lower than/); });
  await ok("rejects NaN, Infinity, null, strings, undefined", () => {
    for (const v of [NaN, Infinity, -Infinity, null, "5", "NaN", undefined, {}, [], true]) {
      badLim(lim({ minC: v }), /finite number/); badLim(lim({ maxC: v }), /finite number/); badLim(lim({ warnMarginC: v }), /finite number/);
    }
  });
  await ok("rejects missing fields", () => {
    for (const k of ["type", "minC", "maxC", "warnMarginC"]) { const o: Record<string, unknown> = lim(); delete o[k]; assert.equal(validateLimits(o).ok, false, k); }
  });
  await ok("rejects malformed payloads", () => { for (const v of [null, undefined, "x", 5, [], [1, 2]]) badLim(v, /JSON object/); });
  await ok("rejects unknown zone type", () => { badLim(lim({ type: "lava" }), /type must be/); badLim(lim({ type: 5 }), /type must be/); });
  await ok("warning margin: negative or >= half the range is rejected; 0 and just-under-half are accepted", () => {
    badLim(lim({ warnMarginC: -0.1 }), /negative/);
    badLim(lim({ minC: 2, maxC: 8, warnMarginC: 3 }), /half the range/);
    assert.equal(validateLimits(lim({ minC: 2, maxC: 8, warnMarginC: 0 })).ok, true);
    assert.equal(validateLimits(lim({ minC: 2, maxC: 8, warnMarginC: 2.9 })).ok, true);
  });
  await ok("rejects absurd temperatures", () => { badLim(lim({ minC: -500 }), /between/); badLim(lim({ maxC: 5000 }), /between/); });
  await ok("plan with a bad limit is rejected, naming the zone", () => bad(plan([zone({ name: "Cold", minC: 9, maxC: 8 })]), /Cold.*lower than/));
  await ok("plan zone missing limits is rejected", () => { const z: Record<string, unknown> = zone(); delete z.minC; bad(plan([z]), /finite number/); });
  await ok("one status rule for every zone type (same numbers -> same status)", () => {
    for (const type of ["general", "hot-process", "cold-storage"]) {
      const l = { minC: 2, maxC: 8, warnMarginC: 1 };
      assert.equal(validateLimits({ type, ...l }).ok, true);
      assert.deepEqual([1.9, 2, 2.9, 3, 5, 7, 7.1, 8, 8.1].map((t) => statusFor(t, l)),
        ["critical", "warning", "warning", "normal", "normal", "normal", "warning", "warning", "critical"]);
    }
  });
  await ok("version-1 plans migrate with default limits", () => {
    const old = { version: 1, zones: [{ id: "z1", name: "Old", x: 0, y: 0, w: 100, h: 100 }], exits: [], background: null };
    assert.equal(validatePlan(old).ok, false); // strict validator needs version 2
    const r = validatePlan(migratePlan(old));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && { ...r.plan.zones[0] }, { id: "z1", name: "Old", x: 0, y: 0, w: 100, h: 100, ...DEFAULT_LIMITS });
  });

  console.log("-- floor plan --");
  await ok("empty plan is valid", () => assert.equal(validatePlan(emptyPlan()).ok, true));
  for (const t of TEMPLATES) {
    await ok(`template "${t.label}" is valid, unique names, grid-aligned`, () => {
      const b = t.build();
      const r = validatePlan({ version: 2, ...b, background: null });
      assert.equal(r.ok, true, r.ok ? "" : r.error);
      assert.ok(b.zones.length >= 5 && b.exits.length >= 1);
      for (const z of b.zones) for (const v of [z.x, z.y, z.w, z.h]) assert.equal(v % GRID_SIZE, 0);
    });
  }
  await ok("cold template has 2-8 C cold rooms", () => {
    const a = TEMPLATES.find((t) => t.key === "cold")!.build().zones.find((z) => z.name === "Cold Room A")!;
    assert.deepEqual([a.type, a.minC, a.maxC], ["cold-storage", 2, 8]);
  });
  await ok("rejects duplicate ids", () => bad(plan([zone(), zone({ name: "B" })]), /Duplicate id/));
  await ok("rejects duplicate names (case-insensitive)", () => bad(plan([zone(), zone({ id: "a2", name: "a" })]), /already exists/));
  await ok("rejects empty / whitespace name", () => bad(plan([zone({ name: "   " })]), /empty/));
  await ok("rejects name over 40 chars", () => bad(plan([zone({ name: "x".repeat(41) })]), /40/));
  await ok("rejects out-of-bounds zone", () => bad(plan([zone({ x: 950 })]), /outside/));
  await ok("rejects negative position", () => bad(plan([zone({ y: -5 })]), /outside/));
  await ok("rejects tiny zone", () => bad(plan([zone({ w: 5 })]), /smaller/));
  await ok("rejects non-numeric geometry", () => { bad(plan([zone({ w: Infinity })]), /geometry/); bad(plan([zone({ h: "9" })]), /geometry/); });
  await ok("rejects bad ids, non-objects, too many zones", () => {
    bad(plan([zone({ id: "../x" })]), /invalid id/); bad([], /object/); bad(null, /object/);
    bad(plan(Array.from({ length: 51 }, (_, i) => zone({ id: `z${i}`, name: `Z${i}` }))), /At most/);
  });
  await ok("rejects exit outside plan and id clash with zone", () => {
    bad(plan([], { exits: [{ id: "e", x: 2000, y: 0 }] }), /outside/);
    bad(plan([zone()], { exits: [{ id: "a1", x: 1, y: 1 }] }), /Duplicate id/);
  });
  await ok("background: png ok; svg / junk rejected", () => {
    assert.equal(validatePlan(plan([], { background: "data:image/png;base64,iVBORw0KGgo=" })).ok, true);
    bad(plan([], { background: "data:image/svg+xml;base64,PHN2Zz4=" }), /Background/);
    bad(plan([], { background: "http://evil/x.png" }), /Background/);
  });
  await ok("strips unknown fields", () => {
    const r = validatePlan(plan([{ ...zone(), evil: 1 }]));
    assert.equal(r.ok && "evil" in r.plan.zones[0], false);
  });
  await ok("checkName allows renaming a zone to its own name", () => assert.equal(checkName("A", [zone() as never], "a1"), null));
  await ok("clampRect works in any drag direction and clamps", () => {
    assert.deepEqual(clampRect(200, 150, 100, 50), { x: 100, y: 50, w: 100, h: 100 });
    assert.deepEqual(clampRect(-50, -50, 5000, 5000), { x: 0, y: 0, w: 1000, h: 600 });
  });
  await ok("plan <-> grid cell mapping round-trips", () => {
    assert.deepEqual(planToCell(25, 61), { col: 2, row: 6 });
    assert.deepEqual(cellToPlan(2, 6), { x: 20, y: 60, w: 10, h: 10 });
    assert.deepEqual(planToCell(1000, 600), { col: 99, row: 59 });
  });

  console.log("-- storage --");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tg-"));
  const { loadPlan, savePlan, updateZoneLimits, peekPlan, PLAN_FILE } = await import("../src/storage");
  await ok("first run is empty", async () => assert.equal((await loadPlan()).zones.length, 0));
  await ok("5 zones persist, delete persists", async () => {
    const p = emptyPlan();
    for (let i = 1; i <= 5; i++) p.zones.push({ id: `z${i}`, name: `Zone ${i}`, x: i * 100 - 100, y: 0, w: 100, h: 100, ...DEFAULT_LIMITS });
    await savePlan(p);
    assert.deepEqual((await loadPlan()).zones.map((z) => z.name), ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5"]);
    p.zones.splice(2, 1);
    await savePlan(p);
    assert.equal((await loadPlan()).zones.length, 4);
    assert.ok(!(await loadPlan()).zones.some((z) => z.id === "z3"));
  });
  await ok("limits update persists (survives a fresh read) and updates the live cache", async () => {
    const cold = validateLimits(lim({ type: "cold-storage", minC: 2, maxC: 8, warnMarginC: 1 }));
    assert.ok(cold.ok);
    const z = await updateZoneLimits("z1", (cold as { limits: never }).limits);
    assert.deepEqual([z?.type, z?.minC, z?.maxC], ["cold-storage", 2, 8]);
    const hot = validateLimits(lim({ type: "hot-process", minC: 20, maxC: 60, warnMarginC: 5 }));
    await updateZoneLimits("z2", (hot as { limits: never }).limits);
    const raw = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
    assert.deepEqual(raw.zones.slice(0, 2).map((q: { minC: number; maxC: number }) => [q.minC, q.maxC]), [[2, 8], [20, 60]]);
    assert.equal(peekPlan()?.zones[0].maxC, 8);
    await updateZoneLimits("z1", { type: "cold-storage", minC: 2, maxC: 10, warnMarginC: 1 }); // change a maximum
    assert.equal((await loadPlan()).zones[0].maxC, 10);
  });
  await ok("unknown zone id returns null and changes nothing", async () => {
    const before = fs.readFileSync(PLAN_FILE, "utf8");
    assert.equal(await updateZoneLimits("nope", DEFAULT_LIMITS), null);
    assert.equal(fs.readFileSync(PLAN_FILE, "utf8"), before);
  });
  await ok("rejected input never reaches the file (validate first)", async () => {
    const before = fs.readFileSync(PLAN_FILE, "utf8");
    assert.equal(validateLimits(lim({ minC: 9, maxC: 8 })).ok, false); // the route stops here, before updateZoneLimits
    assert.equal(fs.readFileSync(PLAN_FILE, "utf8"), before);
  });
  await ok("concurrent updates all land, none lost", async () => {
    await Promise.all(["z1", "z2", "z4", "z5"].map((id, i) => updateZoneLimits(id, { ...DEFAULT_LIMITS, minC: i, maxC: 40 })));
    assert.deepEqual((await loadPlan()).zones.map((z) => z.minC), [0, 1, 2, 3]);
  });
  await ok("an old version-1 file on disk is upgraded on load", async () => {
    fs.writeFileSync(PLAN_FILE, JSON.stringify({ version: 1, zones: [{ id: "o", name: "Old", x: 0, y: 0, w: 100, h: 100 }], exits: [], background: null }));
    const p = await loadPlan();
    assert.deepEqual([p.version, p.zones[0].minC, p.zones[0].maxC, p.zones[0].type], [2, 15, 30, "general"]);
  });
  await ok("corrupt file is reported, not silently replaced", async () => {
    fs.writeFileSync(PLAN_FILE, "{not json");
    await assert.rejects(loadPlan(), /not valid JSON/);
    assert.equal(fs.readFileSync(PLAN_FILE, "utf8"), "{not json");
  });

  console.log(n ? `\n${n} FAILED` : "\nAll checks passed");
  process.exit(n ? 1 : 0);
}
main();
