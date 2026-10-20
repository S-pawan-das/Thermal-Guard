import type { PlanZone, SimStatus } from "../../shared/types";
import {
  PLAN_WIDTH, PLAN_HEIGHT, SIM_COLS, SIM_ROWS, SIM_CELL_W, SIM_CELL_H, TEMP_MIN, TEMP_MAX,
  clamp, planToSimCell, zoneSimCells,
} from "../../shared/floorplan";

/**
 * DETERMINISTIC THERMAL GRID  (a teaching/demo model, NOT a fire-physics model)
 *
 * Grid: 40 x 25 cells on the plan coordinate system (see shared/floorplan.ts). One value per cell: °C.
 * One engine step does, in this order (every sub-step is a convex blend, so no sub-step can overshoot):
 *   1. Diffusion + ambient exchange (explicit, 4 neighbours):
 *        T' = T + diffusion * SUM_n c(i,n) * (T_n - T)  +  ambientRate * (ambientC - T)
 *      c = 1 between cells of the same zone, or wallConductance between different zones / open floor.
 *      Stability: the weight left on T itself is 1 - diffusion*SUM(c) - ambientRate >= 1 - 4*0.2 - 0.2 = 0
 *      because diffusion <= 0.2 and ambientRate <= 0.2 are enforced (the textbook limit is diffusion <= 0.25).
 *      Flux between two cells is symmetric, so diffusion alone conserves heat; only ambient/sources/coolers change it.
 *   2. Coolers (cold-storage zones): T += strength * (setpoint - T) on cells fully inside the zone.
 *      A failed cooler stops, and its cells instead move toward failureTempC (default: ambientC) at failureRate.
 *   3. Heat sources: T += strength * (targetC - T) on one cell while active. targetC is a cap: a source can
 *      never push a cell above it.
 *   4. Safety: non-finite values become ambientC; everything is clamped to [TEMP_MIN, TEMP_MAX].
 *
 * WALLS: not drawn explicitly. The edge between two cells whose CENTRES lie in different zones (or one in a zone
 * and one on open floor) conducts only wallConductance (default 0.02) of the normal amount. 1 = no walls,
 * 0 = fully insulated. DOORS are not represented (exit markers have no thermal effect).
 */

export interface SimParams {
  ambientC: number; // outside / room temperature
  diffusion: number; // per-step neighbour coupling, 0..0.2
  ambientRate: number; // per-step relaxation to ambient, 0..0.2
  wallConductance: number; // 0..1
  failureRate: number; // per-step relaxation of a FAILED cooler's zone toward failureTempC / ambient, 0..0.2
}
export const DEFAULT_PARAMS: SimParams = { ambientC: 22, diffusion: 0.15, ambientRate: 0.005, wallConductance: 0.02, failureRate: 0.004 };
export const PARAM_LIMITS: Record<keyof SimParams, [number, number]> = {
  ambientC: [-50, 60], diffusion: [0, 0.2], ambientRate: [0, 0.2], wallConductance: [0, 1], failureRate: [0, 0.2],
};
export const COOLER_STRENGTH = 0.2; // per-step pull toward the setpoint
export const MAX_SOURCES = 20;

export interface HeatSource {
  id: string;
  zoneId?: string; // place at the centre of this zone, or...
  x?: number; // ...at plan coordinates
  y?: number;
  targetC: number; // temperature the source cell is pulled toward (and never exceeds)
  strength: number; // 0..1 per step
  startStep: number;
  endStep: number | null; // null = never ends
}
export interface CoolingFailure {
  zoneId: string; // a zone id, or "*" for every cooled zone
  atStep: number;
  failureTempC?: number;
}
export interface Scenario {
  name: string;
  seed: number;
  initialNoiseC: number; // +/- random start offset per cell (seeded); 0 = perfectly uniform
  params: SimParams;
  sources: HeatSource[];
  failures: CoolingFailure[];
}
export const defaultScenario = (): Scenario => ({ name: "ambient", seed: 1, initialNoiseC: 0, params: { ...DEFAULT_PARAMS }, sources: [], failures: [] });

const N = SIM_COLS * SIM_ROWS;
const finiteOr = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function sanitizeParams(p: Partial<SimParams> = {}): SimParams {
  const out = { ...DEFAULT_PARAMS };
  for (const k of Object.keys(PARAM_LIMITS) as (keyof SimParams)[]) out[k] = clamp(finiteOr(p[k], DEFAULT_PARAMS[k]), PARAM_LIMITS[k][0], PARAM_LIMITS[k][1]);
  return out;
}

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Cooler { setpointC: number }

export class ThermalSim {
  step = 0;
  paused = false; // while true, tick() does nothing; the state is still published
  private scenario: Scenario;
  private T = new Float64Array(N);
  private tmp = new Float64Array(N);
  private initial = new Float64Array(N);
  private cR = new Float64Array(N); // conductance between cell i and i+1
  private cD = new Float64Array(N); // conductance between cell i and i+cols
  private zones: PlanZone[] = [];
  private cellsOf = new Map<string, number[]>(); // all intersecting cells (statistics)
  private insideOf = new Map<string, number[]>(); // cells fully inside (cooling)
  private coolers = new Map<string, Cooler>();
  private failed = new Map<string, { failureTempC?: number }>();
  private extraSources: HeatSource[] = [];

  constructor(scenario: Scenario = defaultScenario(), zones: PlanZone[] = []) {
    this.scenario = this.clean(scenario);
    this.setZones(zones);
  }

  private clean(s: Scenario): Scenario {
    return {
      name: String(s.name ?? "custom").slice(0, 40), seed: Math.trunc(finiteOr(s.seed, 1)),
      initialNoiseC: clamp(finiteOr(s.initialNoiseC, 0), 0, 5), params: sanitizeParams(s.params),
      sources: (s.sources ?? []).slice(0, MAX_SOURCES), failures: (s.failures ?? []).slice(0, MAX_SOURCES),
    };
  }
  getScenario(): Scenario { return this.scenario; }
  getZones(): PlanZone[] { return this.zones; }
  get ambientC(): number { return this.scenario.params.ambientC; }

  /** Call whenever the saved floor plan changes. Temperatures are kept; geometry and coolers are rebuilt. */
  setZones(zones: PlanZone[]): void {
    this.zones = zones;
    const owner = new Int16Array(N).fill(-1);
    this.cellsOf.clear();
    this.insideOf.clear();
    zones.forEach((z, zi) => {
      const { c0, c1, r0, r1 } = zoneSimCells(z);
      const all: number[] = [], inside: number[] = [], own: number[] = [];
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const i = r * SIM_COLS + c, x0 = c * SIM_CELL_W, y0 = r * SIM_CELL_H;
          all.push(i);
          if (x0 >= z.x && x0 + SIM_CELL_W <= z.x + z.w && y0 >= z.y && y0 + SIM_CELL_H <= z.y + z.h) inside.push(i);
          const cx = x0 + SIM_CELL_W / 2, cy = y0 + SIM_CELL_H / 2;
          if (cx >= z.x && cx < z.x + z.w && cy >= z.y && cy < z.y + z.h) { owner[i] = zi; own.push(i); }
        }
      this.cellsOf.set(z.id, all);
      this.insideOf.set(z.id, inside.length ? inside : own.length ? own : all);
    });
    const wall = this.scenario.params.wallConductance;
    for (let r = 0; r < SIM_ROWS; r++)
      for (let c = 0; c < SIM_COLS; c++) {
        const i = r * SIM_COLS + c;
        if (c < SIM_COLS - 1) this.cR[i] = owner[i] === owner[i + 1] ? 1 : wall;
        if (r < SIM_ROWS - 1) this.cD[i] = owner[i] === owner[i + SIM_COLS] ? 1 : wall;
      }
    // cooled zones: cold-storage zones get a cooler whose setpoint is the middle of their limits
    this.coolers.clear();
    for (const z of zones) if (z.type === "cold-storage") this.coolers.set(z.id, { setpointC: (z.minC + z.maxC) / 2 });
    const rng = mulberry32(this.scenario.seed), amb = this.ambientC, noise = this.scenario.initialNoiseC;
    for (let i = 0; i < N; i++) this.initial[i] = clamp(amb + noise * (rng() * 2 - 1), TEMP_MIN, TEMP_MAX);
    for (const [id, cl] of this.coolers) for (const i of this.insideOf.get(id) ?? []) this.initial[i] = cl.setpointC;
    if (this.step === 0) this.T.set(this.initial);
  }

  /** Replace the scenario and start again from step 0. */
  setScenario(s: Scenario): void {
    this.scenario = this.clean(s);
    this.extraSources = [];
    this.failed.clear();
    this.step = 0;
    this.setZones(this.zones);
    this.T.set(this.initial);
  }

  /** Back to the initial state of the current scenario: temperatures, step counter, failures, runtime sources. */
  reset(): void {
    this.T.set(this.initial);
    this.step = 0;
    this.failed.clear();
    this.extraSources = [];
  }

  addSource(s: HeatSource): void {
    if (this.scenario.sources.length + this.extraSources.length >= MAX_SOURCES) throw new Error(`At most ${MAX_SOURCES} heat sources.`);
    this.extraSources.push(s);
  }
  clearRuntimeSources(): void { this.extraSources = []; }
  /** Fail the cooler of one zone (or "*" for all) starting now. */
  triggerFailure(zoneId: string, failureTempC?: number): void {
    for (const id of zoneId === "*" ? [...this.coolers.keys()] : [zoneId]) if (!this.failed.has(id)) this.failed.set(id, { failureTempC });
  }

  tick(n = 1): void {
    if (this.paused) return;
    for (let k = 0; k < Math.min(Math.max(1, Math.trunc(n)), 1000); k++) this.stepOnce();
  }

  zoneIds(): string[] { return this.zones.map((z) => z.id); }
  cooledZoneIds(): string[] { return [...this.coolers.keys()]; }

  /** Starts (or restarts) a fire in the middle of a zone. Cleared by reset(). */
  startFire(zoneId: string, targetC = 300, strength = 0.3): boolean {
    if (!this.zones.some((z) => z.id === zoneId)) return false;
    const id = `fire-${zoneId}`;
    this.extraSources = this.extraSources.filter((s) => s.id !== id); // one fire per zone, never duplicates
    this.addSource({ id, zoneId, targetC, strength, startStep: this.step, endStep: null });
    return true;
  }

  /** One-time demo override: every grid cell overlapping the zone is set to this temperature. */
  setZoneTemperature(zoneId: string, c: number): boolean {
    const cells = this.cellsOf.get(zoneId);
    if (!cells || typeof c !== "number" || !Number.isFinite(c)) return false;
    const v = clamp(c, TEMP_MIN, TEMP_MAX);
    for (const i of cells) this.T[i] = v;
    return true;
  }

  status(): SimStatus {
    const fires = [...this.scenario.sources, ...this.extraSources]
      .filter((s) => this.step >= s.startStep && (s.endStep === null || this.step < s.endStep))
      .map((s) => ({ id: s.id, zoneId: s.zoneId }));
    const failedCoolers = [...this.failed.keys()].filter((id) => this.coolers.has(id));
    return { paused: this.paused, step: this.step, scenario: this.scenario.name, fires, failedCoolers, baseline: fires.length === 0 && failedCoolers.length === 0 };
  }

  private sourceCell(s: HeatSource): number {
    if (s.zoneId !== undefined) {
      const z = this.zones.find((q) => q.id === s.zoneId);
      if (!z) return -1;
      const p = planToSimCell(z.x + z.w / 2, z.y + z.h / 2);
      return p.row * SIM_COLS + p.col;
    }
    const p = planToSimCell(finiteOr(s.x, 0), finiteOr(s.y, 0));
    return p.row * SIM_COLS + p.col;
  }

  private stepOnce(): void {
    const { diffusion: a, ambientRate: k, ambientC: amb, failureRate } = this.scenario.params;
    let T = this.T;
    const tmp = this.tmp, cR = this.cR, cD = this.cD;
    // scheduled cooling failures
    for (const f of this.scenario.failures) if (this.step >= f.atStep) this.triggerFailure(f.zoneId, f.failureTempC);
    // 1. diffusion + ambient exchange
    for (let r = 0; r < SIM_ROWS; r++)
      for (let c = 0; c < SIM_COLS; c++) {
        const i = r * SIM_COLS + c, t = T[i];
        let acc = 0;
        if (c > 0) acc += cR[i - 1] * (T[i - 1] - t);
        if (c < SIM_COLS - 1) acc += cR[i] * (T[i + 1] - t);
        if (r > 0) acc += cD[i - SIM_COLS] * (T[i - SIM_COLS] - t);
        if (r < SIM_ROWS - 1) acc += cD[i] * (T[i + SIM_COLS] - t);
        tmp[i] = t + a * acc + k * (amb - t);
      }
    this.T = tmp;
    this.tmp = T;
    T = this.T;
    // 2. coolers and failed coolers
    for (const [id, cl] of this.coolers) {
      const cells = this.insideOf.get(id) ?? [];
      const f = this.failed.get(id);
      if (!f) for (const i of cells) T[i] += COOLER_STRENGTH * (cl.setpointC - T[i]);
      else { const target = clamp(finiteOr(f.failureTempC, amb), TEMP_MIN, TEMP_MAX); for (const i of cells) T[i] += failureRate * (target - T[i]); }
    }
    // 3. heat sources
    for (const s of [...this.scenario.sources, ...this.extraSources]) {
      if (this.step < s.startStep || (s.endStep !== null && this.step >= s.endStep)) continue;
      const i = this.sourceCell(s);
      if (i >= 0) T[i] += clamp(finiteOr(s.strength, 0), 0, 1) * (clamp(finiteOr(s.targetC, amb), TEMP_MIN, TEMP_MAX) - T[i]);
    }
    // 4. safety
    for (let i = 0; i < N; i++) T[i] = Number.isFinite(T[i]) ? clamp(T[i], TEMP_MIN, TEMP_MAX) : amb;
    this.step++;
  }

  getCell(col: number, row: number): number { return this.T[row * SIM_COLS + col]; }
  getGrid(): number[] { return Array.from(this.T); }

  /** Per zone: coldest cell (cold risk), hottest cell (heat risk) and average (display), over all intersecting cells. */
  zoneStats(): { id: string; minC: number; maxC: number; avgC: number }[] {
    return this.zones.map((z) => {
      const cells = this.cellsOf.get(z.id) ?? [];
      let mn = Infinity, mx = -Infinity, sum = 0;
      for (const i of cells) { const v = this.T[i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
      return cells.length ? { id: z.id, minC: mn, maxC: mx, avgC: sum / cells.length } : { id: z.id, minC: this.ambientC, maxC: this.ambientC, avgC: this.ambientC };
    });
  }
}

// ---------- validation for the HTTP API ----------
export type Res<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numIn = (v: unknown, lo: number, hi: number, name: string): number | string =>
  typeof v !== "number" || !Number.isFinite(v) ? `${name} must be a finite number.` : v < lo || v > hi ? `${name} must be between ${lo} and ${hi}.` : v;
const intIn = (v: unknown, lo: number, hi: number, name: string): number | string => {
  const r = numIn(v, lo, hi, name);
  return typeof r === "number" && !Number.isInteger(r) ? `${name} must be a whole number.` : r;
};

export function validateSource(input: unknown): Res<HeatSource> {
  if (!isObj(input)) return bad("Heat source must be an object.");
  const { id, zoneId, x, y, targetC, strength, startStep, endStep } = input;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return bad("Heat source id is invalid.");
  const src: HeatSource = { id, targetC: 0, strength: 0, startStep: 0, endStep: null };
  if (typeof zoneId === "string" && zoneId) src.zoneId = zoneId;
  else {
    const px = numIn(x, 0, PLAN_WIDTH, "x"), py = numIn(y, 0, PLAN_HEIGHT, "y");
    if (typeof px === "string") return bad(px);
    if (typeof py === "string") return bad(py);
    src.x = px; src.y = py;
  }
  const t = numIn(targetC, TEMP_MIN, TEMP_MAX, "targetC"); if (typeof t === "string") return bad(t);
  const s = numIn(strength, 0, 1, "strength"); if (typeof s === "string") return bad(s);
  const st = startStep === undefined ? 0 : intIn(startStep, 0, 1e9, "startStep"); if (typeof st === "string") return bad(st);
  const en = endStep === undefined || endStep === null ? null : intIn(endStep, 0, 1e9, "endStep");
  if (typeof en === "string") return bad(en);
  if (en !== null && en <= st) return bad("endStep must be after startStep.");
  return { ok: true, value: { ...src, targetC: t, strength: s, startStep: st, endStep: en } };
}

export function validateScenario(input: unknown): Res<Scenario> {
  if (!isObj(input)) return bad("Scenario must be a JSON object.");
  const sc = defaultScenario();
  if (input.name !== undefined) { if (typeof input.name !== "string" || input.name.length > 40) return bad("name must be text of at most 40 characters."); sc.name = input.name; }
  if (input.seed !== undefined) { const v = intIn(input.seed, 0, 2147483647, "seed"); if (typeof v === "string") return bad(v); sc.seed = v; }
  if (input.initialNoiseC !== undefined) { const v = numIn(input.initialNoiseC, 0, 5, "initialNoiseC"); if (typeof v === "string") return bad(v); sc.initialNoiseC = v; }
  if (input.params !== undefined) {
    if (!isObj(input.params)) return bad("params must be an object.");
    for (const k of Object.keys(input.params)) if (!(k in PARAM_LIMITS)) return bad(`Unknown parameter "${k}".`);
    for (const k of Object.keys(PARAM_LIMITS) as (keyof SimParams)[]) {
      if (input.params[k] === undefined) continue;
      const v = numIn(input.params[k], PARAM_LIMITS[k][0], PARAM_LIMITS[k][1], k); if (typeof v === "string") return bad(v);
      sc.params[k] = v;
    }
  }
  for (const key of ["sources", "failures"] as const) {
    const list = input[key] ?? [];
    if (!Array.isArray(list) || list.length > MAX_SOURCES) return bad(`${key} must be a list of at most ${MAX_SOURCES} items.`);
    for (const item of list) {
      if (key === "sources") { const r = validateSource(item); if (!r.ok) return r; sc.sources.push(r.value); }
      else {
        if (!isObj(item) || typeof item.zoneId !== "string" || !item.zoneId) return bad("Each failure needs a zoneId.");
        const at = intIn(item.atStep ?? 0, 0, 1e9, "atStep"); if (typeof at === "string") return bad(at);
        const f: CoolingFailure = { zoneId: item.zoneId, atStep: at };
        if (item.failureTempC !== undefined) { const v = numIn(item.failureTempC, TEMP_MIN, TEMP_MAX, "failureTempC"); if (typeof v === "string") return bad(v); f.failureTempC = v; }
        sc.failures.push(f);
      }
    }
  }
  return { ok: true, value: sc };
}

// ---------- validation for the simulator control endpoints (zone ids must exist) ----------
const zoneErr = (zoneId: unknown, ids: string[]): string | null =>
  typeof zoneId !== "string" || !zoneId ? "zoneId is required." : ids.includes(zoneId) ? null : "Unknown zone id.";

export function validateFire(body: unknown, ids: string[]): Res<{ zoneId: string; targetC: number; strength: number }> {
  if (!isObj(body)) return bad("Request body must be a JSON object.");
  const e = zoneErr(body.zoneId, ids); if (e) return bad(e);
  const t = body.targetC === undefined ? 300 : numIn(body.targetC, TEMP_MIN, TEMP_MAX, "targetC"); if (typeof t === "string") return bad(t);
  const st = body.strength === undefined ? 0.3 : numIn(body.strength, 0, 1, "strength"); if (typeof st === "string") return bad(st);
  return { ok: true, value: { zoneId: body.zoneId as string, targetC: t, strength: st } };
}

export function validateSetTemperature(body: unknown, ids: string[]): Res<{ zoneId: string; temperatureC: number }> {
  if (!isObj(body)) return bad("Request body must be a JSON object.");
  const e = zoneErr(body.zoneId, ids); if (e) return bad(e);
  const t = numIn(body.temperatureC, TEMP_MIN, TEMP_MAX, "temperatureC"); if (typeof t === "string") return bad(t);
  return { ok: true, value: { zoneId: body.zoneId as string, temperatureC: t } };
}

/** zoneId may be "*" (every cooled zone). Only zones that have a cooler (cold-storage) can fail. */
export function validateFailure(body: unknown, ids: string[], cooled: string[]): Res<{ zoneId: string; failureTempC?: number }> {
  if (!isObj(body)) return bad("Request body must be a JSON object.");
  const zoneId = body.zoneId === undefined ? "*" : body.zoneId;
  if (zoneId === "*") { if (!cooled.length) return bad("There is no cooled (cold-storage) zone."); }
  else {
    const e = zoneErr(zoneId, ids); if (e) return bad(e);
    if (!cooled.includes(zoneId as string)) return bad("That zone has no cooler. Only cold-storage zones are cooled.");
  }
  if (body.failureTempC === undefined) return { ok: true, value: { zoneId: zoneId as string } };
  const f = numIn(body.failureTempC, TEMP_MIN, TEMP_MAX, "failureTempC"); if (typeof f === "string") return bad(f);
  return { ok: true, value: { zoneId: zoneId as string, failureTempC: f } };
}
