import assert from "node:assert/strict";
import { layoutEquipment, profileOf, MAX_ITEMS_PER_ZONE } from "../../shared/equipment";
import { TEMPLATES } from "../../client/src/templates";

let n = 0;
const ok = (name: string, fn: () => void) => { try { fn(); console.log(`  ok  ${name}`); } catch (e) { n++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); } };
console.log("-- 3D equipment layout --");
const zones = TEMPLATES.flatMap((t) => t.build().zones);
ok("every item stays inside its zone, for every template zone", () => {
  for (const z of zones) for (const it of layoutEquipment(z)) {
    assert.ok(it.x - it.w / 2 >= z.x && it.x + it.w / 2 <= z.x + z.w && it.y - it.d / 2 >= z.y && it.y + it.d / 2 <= z.y + z.h, `${z.name} item outside`);
    assert.ok([it.x, it.y, it.w, it.d, it.h].every(Number.isFinite) && it.w > 0 && it.d > 0 && it.h > 0);
  }
});
ok("layout is deterministic and capped", () => {
  for (const z of zones) { assert.deepEqual(layoutEquipment(z), layoutEquipment(z)); assert.ok(layoutEquipment(z).length <= MAX_ITEMS_PER_ZONE); }
});
ok("zones get fitting equipment (line has a conveyor, cold storage has racks, tiny zones are safe)", () => {
  const find = (id: string) => zones.find((z) => z.id === id)!;
  assert.ok(layoutEquipment(find("tpl-assembly")).some((i) => i.kind === "conveyor"));
  assert.ok(layoutEquipment(find("tpl-cold-a")).some((i) => i.kind === "rack"));
  assert.equal(profileOf(find("tpl-paint")), "oven");
  assert.deepEqual(layoutEquipment({ id: "t", name: "Tiny", type: "general", x: 0, y: 0, w: 20, h: 20 }), []);
});
if (n) { console.log(`\n${n} check(s) failed`); process.exit(1); }
console.log("\nall equipment checks passed");
