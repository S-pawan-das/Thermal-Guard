import type { PlanZone } from "./types";

/**
 * EQUIPMENT LAYOUT for the 3D view (pure and deterministic: the same zone always gets the same equipment).
 * It only DRAWS plausible equipment for each kind of zone; it has no thermal effect.
 * All numbers are plan units (1000 x 600). x, y = centre of the item on the floor, w along x, d along y, h = height.
 */
export type EquipKind = "machine" | "conveyor" | "rack" | "tank" | "desk" | "pallet" | "oven";
export interface EquipItem { kind: EquipKind; x: number; y: number; w: number; d: number; h: number }
export type Profile = "line" | "oven" | "racks" | "desks" | "packaging" | "pallets" | "machines";

export const MAX_ITEMS_PER_ZONE = 60;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function profileOf(z: Pick<PlanZone, "name" | "type">): Profile {
  const n = z.name.toLowerCase();
  if (/assembly|line|production|manufact/.test(n)) return "line";
  if (z.type === "hot-process" || /paint|oven|furnace|kiln|boiler/.test(n)) return "oven";
  if (z.type === "cold-storage" || /storage|warehouse|rack|freezer|cold/.test(n)) return "racks";
  if (/office|control|admin/.test(n)) return "desks";
  if (/packag/.test(n)) return "packaging";
  if (/ship|receiv|dock|dispatch|staging|load/.test(n)) return "pallets";
  return "machines";
}

export function layoutEquipment(z: Pick<PlanZone, "id" | "name" | "type" | "x" | "y" | "w" | "h">): EquipItem[] {
  const m = Math.min(z.w, z.h) < 80 ? 6 : 16;
  const x0 = z.x + m, x1 = z.x + z.w - m, y0 = z.y + m, y1 = z.y + z.h - m;
  const iw = x1 - x0, ih = y1 - y0;
  if (iw < 20 || ih < 20) return [];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rnd = rng(hash(z.id));
  const out: EquipItem[] = [];
  const add = (it: EquipItem) => {
    if (out.length >= MAX_ITEMS_PER_ZONE) return;
    if (it.x - it.w / 2 < x0 - 1e-6 || it.x + it.w / 2 > x1 + 1e-6 || it.y - it.d / 2 < y0 - 1e-6 || it.y + it.d / 2 > y1 + 1e-6) return;
    out.push(it);
  };

  switch (profileOf(z)) {
    case "line": {
      add({ kind: "conveyor", x: cx, y: cy, w: iw, d: 14, h: 8 });
      for (let i = 0, x = x0 + 34; x + 18 <= x1; i++, x += 76)
        add({ kind: "machine", x, y: cy + (i % 2 ? 40 : -40), w: 34, d: 30, h: 26 + rnd() * 14 });
      break;
    }
    case "packaging": {
      const len = iw * 0.7;
      add({ kind: "conveyor", x: cx, y: cy, w: len, d: 14, h: 8 });
      for (let i = 0, x = cx - len / 2 + 30; x + 18 <= cx + len / 2; i++, x += 70)
        add({ kind: "machine", x, y: cy + (i % 2 ? 40 : -40), w: 32, d: 28, h: 24 + rnd() * 10 });
      break;
    }
    case "oven": {
      const n = Math.max(1, Math.min(3, Math.floor(iw / 90)));
      for (let i = 0; i < n; i++) add({ kind: "oven", x: x0 + 40 + i * 90, y: cy - 6, w: 70, d: Math.min(54, ih - 20), h: 42 });
      add({ kind: "tank", x: x1 - 14, y: y0 + 14, w: 22, d: 22, h: 38 });
      add({ kind: "tank", x: x1 - 14, y: y1 - 14, w: 22, d: 22, h: 30 });
      break;
    }
    case "racks": {
      for (let y = y0 + 12; y + 8 <= y1; y += 38)
        for (let x = x0 + 34; x + 30 <= x1 + 1; x += 78) add({ kind: "rack", x, y, w: 62, d: 14, h: 34 + rnd() * 6 });
      break;
    }
    case "desks": {
      for (let y = y0 + 14; y + 8 <= y1; y += 36)
        for (let x = x0 + 22; x + 14 <= x1; x += 46) add({ kind: "desk", x, y, w: 30, d: 16, h: 8 });
      break;
    }
    case "pallets": {
      for (let y = y0 + 16; y + 12 <= y1; y += 38)
        for (let x = x0 + 18; x + 12 <= x1; x += 38) if (rnd() > 0.3) add({ kind: "pallet", x, y, w: 26, d: 26, h: 10 + Math.floor(rnd() * 3) * 8 });
      break;
    }
    default: {
      const n = Math.max(1, Math.min(4, Math.floor((iw * ih) / 6000)));
      for (let i = 0; i < n; i++) add({ kind: "machine", x: x0 + 30 + rnd() * Math.max(0, iw - 60), y: y0 + 24 + rnd() * Math.max(0, ih - 48), w: 34, d: 30, h: 28 });
    }
  }
  return out;
}
