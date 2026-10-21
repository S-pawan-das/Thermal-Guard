import type { PlanZone, ZoneType } from "../shared/types";
import { statusForCells, validateLimits } from "../shared/floorplan";
import type { Reading } from "../shared/forecast";
import { ThermalSim, defaultScenario, type HeatSource } from "../server/src/thermal";
import { TEMPLATES } from "../client/src/templates";

/**
 * SCENARIO GENERATOR: runs the real ThermalSim many times with different floor plans, settings and incidents,
 * and records what the zone cards would have shown at every step. This is the training / test data.
 * Everything is seeded, so the same seed always gives the same episode.
 */
export type LayoutKind = "factory" | "cold" | "random";
export type IncidentKind = "normal" | "cooling-failure" | "fire" | "overheat" | "door-open";

export const WARMUP = 120; // unrecorded steps so machines reach their steady state before recording starts
export const EPISODE_STEPS = 360; // recorded steps per episode

export interface Episode {
  seed: number;
  layout: LayoutKind;
  incident: IncidentKind;
  zones: PlanZone[];
  noiseC: number;
  truth: Reading[][]; // [zone][step], exactly what the server would publish (rounded to 0.1)
  seen: Reading[][]; // [zone][step], truth plus sensor noise: what the detectors get to look at
  critical: boolean[][]; // [zone][step], true when the zone is really out of range
}

export function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const U = (r: Rng, a: number, b: number) => a + (b - a) * r();
const I = (r: Rng, a: number, b: number) => Math.floor(U(r, a, b + 1));
const half = (v: number) => Math.round(v * 2) / 2;
const round1 = (v: number) => Math.round(v * 10) / 10;
const gauss = (r: Rng) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

function jitterLimits(z: PlanZone, r: Rng): PlanZone {
  for (let k = 0; k < 10; k++) {
    const minC = half(z.minC + U(r, -1.5, 1.5)), maxC = half(z.maxC + U(r, -1.5, 1.5));
    const warnMarginC = half(Math.max(0.5, z.warnMarginC + U(r, -0.5, 0.5)));
    const v = validateLimits({ type: z.type, minC, maxC, warnMarginC });
    if (v.ok) return { ...z, ...v.limits };
  }
  return z;
}

/** Normal operation must start inside the limits: a non-cold zone starts at room temperature, so its limits have to bracket it. */
function fitToAmbient(z: PlanZone, amb: number, r: Rng): PlanZone {
  if (z.type === "cold-storage") return z;
  let { minC, maxC } = z;
  const pad = z.warnMarginC + 2;
  if (amb > maxC - pad) maxC = half(amb + pad + U(r, 2, 15));
  if (amb < minC + pad) minC = half(amb - pad - U(r, 2, 12));
  const v = validateLimits({ type: z.type, minC, maxC, warnMarginC: z.warnMarginC });
  return v.ok ? { ...z, ...v.limits } : z;
}

function randomLimits(type: ZoneType, r: Rng) {
  if (type === "cold-storage") { const minC = half(U(r, -25, 3)), range = half(U(r, 5, 12)); return { type, minC, maxC: minC + range, warnMarginC: Math.max(0.5, half(U(r, 0.5, Math.min(2.5, range * 0.3)))) }; }
  if (type === "hot-process") { const minC = half(U(r, 12, 25)), range = half(U(r, 25, 70)); return { type, minC, maxC: minC + range, warnMarginC: half(U(r, 2, 8)) }; }
  const minC = half(U(r, 5, 18)), range = half(U(r, 14, 28));
  return { type, minC, maxC: minC + range, warnMarginC: half(U(r, 1, 4)) };
}

function randomLayout(r: Rng): PlanZone[] {
  const zones: PlanZone[] = [];
  const want = I(r, 3, 7);
  const NAMES = ["Hall", "Cell", "Bay", "Room", "Line", "Store"];
  for (let tries = 0; tries < 200 && zones.length < want; tries++) {
    const w = I(r, 10, 30) * 10, h = I(r, 10, 24) * 10;
    const x = I(r, 0, (1000 - w) / 10) * 10, y = I(r, 0, (600 - h) / 10) * 10;
    if (zones.some((z) => x < z.x + z.w + 10 && x + w + 10 > z.x && y < z.y + z.h + 10 && y + h + 10 > z.y)) continue;
    const type: ZoneType = r() < 0.3 ? "cold-storage" : r() < 0.25 ? "hot-process" : "general";
    zones.push({ id: `z${zones.length}`, name: `${NAMES[zones.length % NAMES.length]} ${zones.length + 1}`, x, y, w, h, ...randomLimits(type, r) });
  }
  return zones;
}

export function makeLayout(kind: LayoutKind, r: Rng): PlanZone[] {
  if (kind === "random") return randomLayout(r);
  return TEMPLATES[kind === "factory" ? 0 : 1].build().zones.map((z) => jitterLimits({ ...z } as PlanZone, r));
}

export function runEpisode(seed: number, layout: LayoutKind, incident: IncidentKind): Episode {
  const r = mulberry32(seed);
  const amb = U(r, 16, 34);
  const zones = makeLayout(layout, r).map((z) => fitToAmbient(z, amb, r));
  const sim = new ThermalSim(
    {
      ...defaultScenario(), seed, initialNoiseC: U(r, 0, 0.5),
      params: { ambientC: amb, diffusion: U(r, 0.1, 0.2), ambientRate: U(r, 0.002, 0.012), wallConductance: U(r, 0.005, 0.06), failureRate: U(r, 0.002, 0.01) },
    },
    zones
  );
  const params = sim.getScenario().params; // mutated below on purpose: slow ambient drift
  const swing = U(r, 0, 3), period = U(r, 150, 400), phase = U(r, 0, 6.28);
  const noiseC = [0, 0.05, 0.1, 0.2][I(r, 0, 3)];
  const cold = zones.map((z, i) => (z.type === "cold-storage" ? i : -1)).filter((i) => i >= 0);
  const warm = zones.map((z, i) => (z.type !== "cold-storage" ? i : -1)).filter((i) => i >= 0);
  const spot = (z: PlanZone) => ({ x: z.x + U(r, 5, z.w - 5), y: z.y + U(r, 5, z.h - 5) });
  let n = 0;
  const add = (s: Omit<HeatSource, "id">) => sim.addSource({ id: `s${n++}`, ...s });

  // steady machines: capped a little below the zone's max, so normal operation stays in range
  for (let k = I(r, 0, 4); k > 0 && warm.length; k--) {
    const z = zones[warm[I(r, 0, warm.length - 1)]];
    const cap = z.maxC - U(r, 2, 8);
    if (cap < amb + 3) continue;
    add({ ...spot(z), targetC: Math.min(amb + U(r, 6, 30), cap), strength: U(r, 0.03, 0.15), startStep: 0, endStep: null });
  }
  // brief harmless disturbances (door opened for a moment, short machine burst): these must NOT cause alarms
  const benign = (count: number) => {
    for (let k = 0; k < count; k++) {
      const z = zones[I(r, 0, zones.length - 1)], s = U(r, 0, EPISODE_STEPS - 40);
      add({ ...spot(z), targetC: amb + U(r, 0, 6), strength: U(r, 0.05, 0.2), startStep: WARMUP + s, endStep: WARMUP + s + I(r, 4, 20) });
    }
  };
  benign(incident === "normal" ? I(r, 1, 4) : I(r, 0, 2));

  // the incident
  const f = I(r, 40, 140);
  let kind = incident;
  if (kind === "cooling-failure" && !cold.length) kind = "door-open";
  let failZone = -1, failTemp: number | undefined;
  let ramp: { src: HeatSource; from: number; to: number; len: number } | null = null;
  if (kind === "cooling-failure") { failZone = cold[I(r, 0, cold.length - 1)]; failTemp = r() < 0.5 ? undefined : amb + U(r, 0, 15); }
  else if (kind === "fire") {
    const z = zones[I(r, 0, zones.length - 1)];
    add({ zoneId: z.id, targetC: U(r, 60, 400), strength: U(r, 0.03, 0.4), startStep: WARMUP + f, endStep: r() < 0.5 ? null : WARMUP + f + I(r, 30, 200) });
  } else if (kind === "overheat" && warm.length) {
    const z = zones[warm[I(r, 0, warm.length - 1)]];
    const src: HeatSource = { id: `s${n++}`, ...spot(z), targetC: amb, strength: U(r, 0.08, 0.25), startStep: WARMUP + f, endStep: null };
    sim.addSource(src);
    ramp = { src, from: amb + 5, to: z.maxC + U(r, 2, 40), len: I(r, 60, 200) };
  } else if (kind === "door-open") {
    const pool = cold.length && r() < 0.7 ? cold : zones.map((_, i) => i);
    const z = zones[pool[I(r, 0, pool.length - 1)]];
    add({ x: z.x + U(r, 5, Math.min(30, z.w - 5)), y: z.y + U(r, 5, z.h - 5), targetC: amb + U(r, 2, 15), strength: U(r, 0.08, 0.35), startStep: WARMUP + f, endStep: WARMUP + f + I(r, 15, 120) });
  }

  const drift = () => { params.ambientC = amb + swing * Math.sin((2 * Math.PI * sim.step) / period + phase); };
  for (let i = 0; i < WARMUP; i++) { drift(); sim.tick(1); }

  const truth: Reading[][] = zones.map(() => []), seen: Reading[][] = zones.map(() => []), critical: boolean[][] = zones.map(() => []);
  for (let t = 0; t < EPISODE_STEPS; t++) {
    drift();
    if (failZone >= 0 && t === f) sim.triggerFailure(zones[failZone].id, failTemp);
    if (ramp) ramp.src.targetC = t < f ? ramp.from : ramp.from + (ramp.to - ramp.from) * Math.min(1, (t - f) / ramp.len);
    sim.tick(1);
    const stats = sim.zoneStats();
    zones.forEach((z, i) => {
      const s = stats[i];
      const tr = { avg: round1(s.avgC), min: round1(s.minC), max: round1(s.maxC) };
      truth[i].push(tr);
      seen[i].push(noiseC ? { avg: round1(tr.avg + gauss(r) * noiseC), min: round1(tr.min + gauss(r) * noiseC), max: round1(tr.max + gauss(r) * noiseC) } : tr);
      critical[i].push(statusForCells(tr.min, tr.max, z) === "critical");
    });
  }
  return { seed, layout, incident: kind, zones, noiseC, truth, seen, critical };
}

/** A varied, reproducible mix of episodes. Different seed ranges give training / validation / test sets. */
export function sampleSpec(seed: number, layoutOverride?: LayoutKind): { layout: LayoutKind; incident: IncidentKind } {
  const r = mulberry32(seed * 7919 + 13);
  const a = r(), b = r();
  const layout: LayoutKind = layoutOverride ?? (a < 0.25 ? "factory" : a < 0.5 ? "cold" : "random");
  const incident: IncidentKind = b < 0.3 ? "normal" : b < 0.5 ? "cooling-failure" : b < 0.65 ? "fire" : b < 0.8 ? "overheat" : "door-open";
  return { layout, incident };
}

export function makeEpisodes(firstSeed: number, count: number, layoutOverride?: LayoutKind): Episode[] {
  const out: Episode[] = [];
  for (let i = 0; i < count; i++) {
    const seed = firstSeed + i, spec = sampleSpec(seed, layoutOverride);
    const ep = runEpisode(seed, spec.layout, spec.incident);
    if (ep.zones.length) out.push(ep);
  }
  return out;
}
