import type { PlanZone } from "./types";
import { SIM_COLS, SIM_ROWS, SIM_CELL_W, SIM_CELL_H, DEFAULT_LIMITS } from "./floorplan";

/**
 * HEATMAP COLOURING (pure functions, shared so they can be tested on the server side).
 *
 * Two scales:
 *  - "limits":   every cell is coloured by where it sits inside the limits of the zone it belongs to.
 *                min limit -> blue, middle of the range -> green, max limit -> orange/red, beyond the limit -> deep red/blue.
 *                A cold room at 4 °C and a paint booth at 45 °C can both read "green = fine".
 *                Cells that are not inside any zone use the default limits.
 *  - "absolute": one °C scale for the whole floor, from the coldest to the hottest cell (at least MIN_ABS_SPAN wide).
 */
export type HeatMode = "limits" | "absolute";
export const MIN_ABS_SPAN = 10;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Blue -> cyan -> green -> yellow -> orange -> red, u in 0..1. Returns [r, g, b] 0..255. */
const STOPS: [number, number, number, number][] = [
  [0.0, 20, 30, 140],
  [0.15, 30, 90, 230],
  [0.3, 20, 190, 230],
  [0.5, 60, 200, 90],
  [0.68, 240, 225, 50],
  [0.85, 245, 120, 30],
  [1.0, 200, 20, 25],
];
export function heatRgb(u: number): [number, number, number] {
  const x = clamp01(Number.isFinite(u) ? u : 0);
  for (let i = 1; i < STOPS.length; i++) {
    const [u1, r1, g1, b1] = STOPS[i];
    if (x <= u1) {
      const [u0, r0, g0, b0] = STOPS[i - 1];
      const f = (x - u0) / (u1 - u0);
      return [Math.round(r0 + (r1 - r0) * f), Math.round(g0 + (g1 - g0) * f), Math.round(b0 + (b1 - b0) * f)];
    }
  }
  const last = STOPS[STOPS.length - 1];
  return [last[1], last[2], last[3]];
}

/** For each simulation cell: index of the zone that owns it (cell centre inside the zone; later zones win), or -1. Same rule as the engine. */
export function cellOwners(zones: Pick<PlanZone, "x" | "y" | "w" | "h">[]): Int16Array {
  const owner = new Int16Array(SIM_COLS * SIM_ROWS).fill(-1);
  zones.forEach((z, zi) => {
    for (let r = 0; r < SIM_ROWS; r++)
      for (let c = 0; c < SIM_COLS; c++) {
        const cx = c * SIM_CELL_W + SIM_CELL_W / 2, cy = r * SIM_CELL_H + SIM_CELL_H / 2;
        if (cx >= z.x && cx < z.x + z.w && cy >= z.y && cy < z.y + z.h) owner[r * SIM_COLS + c] = zi;
      }
  });
  return owner;
}

/** Position of a temperature relative to limits, as a colour position 0..1. 0.15 = min limit, 0.85 = max limit. */
export function limitsPosition(t: number, minC: number, maxC: number): number {
  const range = maxC - minC;
  if (!(range > 0) || !Number.isFinite(t)) return 0.5;
  const v = (t - minC) / range; // 0 at min limit, 1 at max limit
  if (v >= 0 && v <= 1) return 0.15 + 0.7 * v;
  const over = clamp01(Math.abs(v < 0 ? v : v - 1) / 0.5); // half a range past the limit = full colour
  return v < 0 ? 0.15 - 0.15 * over : 0.85 + 0.15 * over;
}

export interface AbsRange { lo: number; hi: number }
export function absoluteRange(values: ArrayLike<number>): AbsRange {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i++) { const v = values[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (!Number.isFinite(lo)) return { lo: 0, hi: MIN_ABS_SPAN };
  if (hi - lo < MIN_ABS_SPAN) { const mid = (lo + hi) / 2; lo = mid - MIN_ABS_SPAN / 2; hi = mid + MIN_ABS_SPAN / 2; }
  return { lo: Math.floor(lo), hi: Math.ceil(hi) };
}

/** Colour position (0..1) of every cell for the chosen scale. */
export function colourPositions(values: ArrayLike<number>, zones: PlanZone[], owners: Int16Array, mode: HeatMode): { u: Float32Array; range: AbsRange } {
  const u = new Float32Array(values.length);
  const range = absoluteRange(values);
  for (let i = 0; i < values.length; i++) {
    if (mode === "absolute") u[i] = clamp01((values[i] - range.lo) / (range.hi - range.lo));
    else {
      const z = owners[i] >= 0 ? zones[owners[i]] : undefined;
      u[i] = limitsPosition(values[i], z ? z.minC : DEFAULT_LIMITS.minC, z ? z.maxC : DEFAULT_LIMITS.maxC);
    }
  }
  return { u, range };
}
